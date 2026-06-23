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
  dir = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
  app = await buildServer(
    loadConfig({
      ATLAS_DATA_DIR: dir,
      ATLAS_SECRET: 's'.repeat(32),
      ATLAS_ADMIN_USER: 'root',
      ATLAS_ADMIN_PASSWORD: 'rootpass1',
    }),
  );
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function cookieFor(username: string, password: string): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return `atlas_session=${login.cookies.find((x) => x.name === 'atlas_session')!.value}`;
}

async function normalUser(username: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'secret12' },
  });
  return cookieFor(username, 'secret12');
}

describe('audit route', () => {
  it('unauthenticated → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
  });

  it('non-admin → 403', async () => {
    const cookie = await normalUser('ada');
    expect(
      (await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).statusCode,
    ).toBe(403);
  });

  it('records write operations and returns them seq-desc', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    // db create (write path) → audit
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: admin },
      payload: { name: 'kb' },
    });
    // node create (write path) → audit
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/nodes',
      headers: { cookie: admin },
      payload: { labels: ['Person'], properties: { name: 'Ada' } },
    });
    const r = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    const entries = r.json() as { seq: number; action: string; target: string }[];
    // Newest first.
    const seqs = entries.map((e) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('db:create');
    expect(actions).toContain('node:create');
  });

  it('does not record audit entries for read operations', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: admin },
      payload: { name: 'kb' },
    });
    const before = (
      (
        await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: admin } })
      ).json() as unknown[]
    ).length;
    // A pure read query and a GET node should not append audit entries.
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: admin },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    const after = (
      (
        await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: admin } })
      ).json() as unknown[]
    ).length;
    expect(after).toBe(before);
  });

  it('records a write query as query:write', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: admin },
      payload: { name: 'kb' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: admin },
      payload: { query: 'CREATE (n:Person {name: "Ada"}) RETURN n', params: {} },
    });
    const entries = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: admin } })
    ).json() as { action: string }[];
    expect(entries.map((e) => e.action)).toContain('query:write');
  });

  it('respects the limit query param', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: admin },
      payload: { name: 'kb' },
    });
    for (let i = 0; i < 3; i++)
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: admin },
        payload: { labels: ['X'], properties: {} },
      });
    const r = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=2',
      headers: { cookie: admin },
    });
    expect((r.json() as unknown[]).length).toBe(2);
  });
});
