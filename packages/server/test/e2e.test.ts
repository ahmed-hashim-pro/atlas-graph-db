import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-srv-e2e-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('server e2e', () => {
  it('full journey: register, create db, seed via AQL, query, algorithm, persist across reopen', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ada', password: 'secret12' },
    });
    const cookie = `atlas_session=${reg.cookies.find((c) => c.name === 'atlas_session')?.value ?? ''}`;
    // register does not set a cookie; log in.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    const auth = `atlas_session=${login.cookies.find((c) => c.name === 'atlas_session')!.value}`;

    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: auth },
      payload: { name: 'kb' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth },
      payload: {
        query: "CREATE (a:Person {name: 'Ada'})-[:WROTE]->(:Doc {title: 'Notes'})",
        params: {},
      },
    });
    const pr = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth },
      payload: { query: 'CALL algo.degree() YIELD node, score', params: {} },
    });
    expect(pr.json().rows.length).toBe(2);

    // Reopen the server over the same data dir: db persists.
    await app.close();
    app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
    const login2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    const auth2 = `atlas_session=${login2.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    const count = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth2 },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    expect(count.json().rows).toEqual([[2]]);
    expect(reg.statusCode).toBe(201);
    expect(cookie).toBeDefined();
  });
});
