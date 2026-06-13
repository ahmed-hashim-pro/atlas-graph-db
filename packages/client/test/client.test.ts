import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '@atlas/server';
import { loadConfig } from '@atlas/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let url: string;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
  const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
  const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
  token = (await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 't' } })).json().token;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client', () => {
  it('queries through the typed client', async () => {
    const db = connect(url, { token }).database('kb');
    await db.query("CREATE (p:Person {name: 'Ada'}) RETURN p", {});
    const res = await db.query('MATCH (p:Person) RETURN p.name AS name', {});
    expect(res.columns).toEqual(['name']);
    expect(res.rows).toEqual([['Ada']]);
  });

  it('surfaces server errors as thrown AtlasClientError with code + status', async () => {
    const db = connect(url, { token }).database('kb');
    await expect(db.query('MATCH (n RETURN n', {})).rejects.toMatchObject({ code: 'PARSE_ERROR', status: 400 });
  });

  it('subscribe() delivers live change batches and unsubscribes', async () => {
    const db = connect(url, { token }).database('kb');
    const got: { txId: number }[] = [];
    const sub = await db.subscribe({ labels: ['Person'] }, (frame) => {
      if (frame.type === 'batch') got.push({ txId: frame.txId });
    });
    await new Promise((r) => setTimeout(r, 50)); // let 'ready' settle
    await db.query("CREATE (p:Person {name: 'Live'}) RETURN p", {});
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBeGreaterThanOrEqual(1);
    sub.close();
  });
});
