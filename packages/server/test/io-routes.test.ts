import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-io-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
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
  cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({
    method: 'POST',
    url: '/api/db',
    headers: { cookie },
    payload: { name: 'kb' },
  });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('JSON import/export', () => {
  it('imports nodes+edges by tempId and returns the id map', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: {
        nodes: [
          { tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } },
          { tempId: 'd', labels: ['Document'], properties: { title: 'Notes' } },
        ],
        edges: [{ from: 'a', to: 'd', type: 'WROTE', properties: {} }],
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.committed).toEqual({ nodes: 2, edges: 1 });
    expect(Object.keys(body.idMap)).toEqual(['a', 'd']);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/db/kb/export',
      headers: { cookie },
    });
    const dump = exported.json();
    expect(dump.nodes).toHaveLength(2);
    expect(dump.edges).toHaveLength(1);
    // export uses real ids and is re-importable shape
    expect(dump.nodes[0]).toHaveProperty('tempId');
  });

  it('edges may reference existing engine ids (numeric string) as well as tempIds', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: { nodes: [{ tempId: 'x', labels: ['P'], properties: {} }], edges: [] },
    });
    const xid = first.json().idMap.x as number;
    const second = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: {
        nodes: [{ tempId: 'y', labels: ['P'], properties: {} }],
        edges: [{ from: 'y', to: String(xid), type: 'R', properties: {} }],
      },
    });
    expect(second.json().committed).toEqual({ nodes: 1, edges: 1 });
  });

  it('non-atomic import reports partial commit + first error; atomic rolls all back', async () => {
    const bad = {
      nodes: [{ tempId: 'a', labels: ['P'], properties: {} }],
      edges: [{ from: 'a', to: 'missing', type: 'R', properties: {} }],
    };
    const partial = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: bad,
    });
    expect(partial.json().committed.nodes).toBe(1); // node batch committed before the bad edge
    expect(partial.json().error).toMatchObject({ at: { kind: 'edge', index: 0 } });

    const atomic = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: { ...bad, atomic: true },
    });
    expect(atomic.statusCode).toBe(400);
    // nothing from the atomic attempt persisted: only the earlier partial node remains
    const exp = await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie } });
    expect(exp.json().nodes).toHaveLength(1);
  });

  it('CSV import via multipart-ish text fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import?format=csv',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        nodesCsv: 'tempId,:label,name:string\n1,Person,Ada\n2,Person,Bob',
        edgesCsv: ':from,:to,:type\n1,2,KNOWS',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().committed).toEqual({ nodes: 2, edges: 1 });
  });
});

describe('seed', () => {
  it('seeds science-history (editor+); unknown dataset is 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/seed/science-history',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().committed.nodes).toBe(500);
    expect(
      (await app.inject({ method: 'POST', url: '/api/db/kb/seed/nope', headers: { cookie } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('permissions', () => {
  it('viewer cannot import/seed but can export', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'secret12' },
    });
    const l = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'bob', password: 'secret12' },
    });
    const bob = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie },
      payload: { username: 'bob', role: 'viewer' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/db/kb/import',
          headers: { cookie: bob },
          payload: { nodes: [], edges: [] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie: bob } }))
        .statusCode,
    ).toBe(200);
  });
});
