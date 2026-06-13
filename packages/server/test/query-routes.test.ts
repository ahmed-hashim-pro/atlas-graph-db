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
  dir = await mkdtemp(join(tmpdir(), 'atlas-qr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function userCookie(username: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'secret12' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'secret12' },
  });
  return `atlas_session=${login.cookies.find((x) => x.name === 'atlas_session')!.value}`;
}
function q(cookie: string, name: string, query: string, params = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/db/${name}/query`,
    headers: { cookie },
    payload: { query, params },
  });
}

describe('query routes + role gating', () => {
  it('write then read through AQL as the owner', async () => {
    const cookie = await userCookie('ada');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie },
      payload: { name: 'kb' },
    });
    const w = await q(cookie, 'kb', "CREATE (p:Person {name: 'Ada'}) RETURN p.name AS name");
    expect(w.statusCode).toBe(200);
    expect(w.json().rows).toEqual([['Ada']]);
    const r = await q(cookie, 'kb', 'MATCH (p:Person) RETURN count(*) AS c');
    expect(r.json().rows).toEqual([[1]]);
  });

  it('viewer may read but not write or run DDL', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: ada },
      payload: { name: 'kb' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: ada },
      payload: { username: 'bob', role: 'viewer' },
    });

    expect((await q(bob, 'kb', 'MATCH (n) RETURN n')).statusCode).toBe(200);
    expect((await q(bob, 'kb', 'CREATE (n:X) RETURN n')).statusCode).toBe(403);
    expect((await q(bob, 'kb', 'CREATE INDEX ON :Person(name)')).statusCode).toBe(403);
  });

  it('editor may write but not run DDL; owner may', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: ada },
      payload: { name: 'kb' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: ada },
      payload: { username: 'bob', role: 'editor' },
    });

    expect((await q(bob, 'kb', 'CREATE (n:X {v: 1}) RETURN n')).statusCode).toBe(200);
    expect((await q(bob, 'kb', 'CREATE INDEX ON :X(v)')).statusCode).toBe(403);
    expect((await q(ada, 'kb', 'CREATE INDEX ON :X(v)')).statusCode).toBe(200);
  });

  it('parse errors return 400 with caret snippet; EXPLAIN works for viewers', async () => {
    const cookie = await userCookie('ada');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie },
      payload: { name: 'kb' },
    });
    const bad = await q(cookie, 'kb', 'MATCH (n RETURN n');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'PARSE_ERROR' });
    expect(bad.json().snippet).toContain('^');
    const exp = await q(cookie, 'kb', 'EXPLAIN MATCH (n:Person) RETURN n');
    expect(exp.json().rows[0][0]).toHaveProperty('op');
  });

  it('GET schema requires read access', async () => {
    const ada = await userCookie('ada');
    const carol = await userCookie('carol');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: ada },
      payload: { name: 'kb' },
    });
    await q(ada, 'kb', "CREATE (:Person {name: 'A'})");
    const s = await app.inject({
      method: 'GET',
      url: '/api/db/kb/schema',
      headers: { cookie: ada },
    });
    expect(s.statusCode).toBe(200);
    expect(s.json().labels.map((l: { label: string }) => l.label)).toContain('Person');
    expect(
      (await app.inject({ method: 'GET', url: '/api/db/kb/schema', headers: { cookie: carol } }))
        .statusCode,
    ).toBe(403);
  });
});
