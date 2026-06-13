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
  dir = await mkdtemp(join(tmpdir(), 'atlas-full-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('full server journey', () => {
  it('register → db → seed → CRUD → query → export → metrics', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ada', password: 'secret12' },
    });
    const l = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie },
      payload: { name: 'kb' },
    });

    await app.inject({
      method: 'POST',
      url: '/api/db/kb/seed/science-history',
      headers: { cookie },
    });
    const nid = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie },
        payload: { labels: ['Tag'], properties: { v: 1 } },
      })
    ).json().id;
    expect(typeof nid).toBe('number');

    const q = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie },
      payload: { query: 'MATCH (p:Person) RETURN count(*) AS c', params: {} },
    });
    expect(q.json().rows[0][0] as number).toBeGreaterThan(0);

    const exp = await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie } });
    expect(exp.json().nodes.length).toBeGreaterThan(500);

    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toMatch(/atlas_queries_total [1-9]/);
  });
});
