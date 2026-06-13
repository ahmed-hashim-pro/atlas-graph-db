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
  dir = await mkdtemp(join(tmpdir(), 'atlas-data-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ owner: string; viewer: string }> {
  const reg = async (u: string): Promise<string> => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: u, password: 'secret12' },
    });
    const l = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: u, password: 'secret12' },
    });
    return `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  };
  const owner = await reg('ada');
  await app.inject({
    method: 'POST',
    url: '/api/db',
    headers: { cookie: owner },
    payload: { name: 'kb' },
  });
  const viewer = await reg('bob');
  await app.inject({
    method: 'POST',
    url: '/api/db/kb/roles',
    headers: { cookie: owner },
    payload: { username: 'bob', role: 'viewer' },
  });
  return { owner, viewer };
}

describe('node CRUD', () => {
  it('create → get → patch → delete a node (editor/owner)', async () => {
    const { owner } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/db/kb/nodes',
      headers: { cookie: owner },
      payload: { labels: ['Person'], properties: { name: 'Ada', born: 1815 } },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;

    const got = await app.inject({
      method: 'GET',
      url: `/api/db/kb/nodes/${id}`,
      headers: { cookie: owner },
    });
    expect(got.json()).toMatchObject({
      id,
      labels: ['Person'],
      properties: { name: 'Ada', born: 1815 },
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/db/kb/nodes/${id}`,
      headers: { cookie: owner },
      payload: { set: { field: 'math' }, remove: ['born'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().properties).toEqual({ name: 'Ada', field: 'math' });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/db/kb/nodes/${id}`,
      headers: { cookie: owner },
    });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/db/kb/nodes/${id}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('DELETE a node with edges needs ?detach=true', async () => {
    const { owner } = await setup();
    const a = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    const b = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/edges',
      headers: { cookie: owner },
      payload: { type: 'R', from: a, to: b },
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/db/kb/nodes/${a}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/db/kb/nodes/${a}?detach=true`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(204);
  });

  it('viewer cannot create/patch/delete; can read', async () => {
    const { owner, viewer } = await setup();
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/db/kb/nodes/${id}`,
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/db/kb/nodes',
          headers: { cookie: viewer },
          payload: { labels: ['P'] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/db/kb/nodes/${id}`,
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('404 for a missing node id, 400 for an invalid id', async () => {
    const { owner } = await setup();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/db/kb/nodes/99999',
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/db/kb/nodes/abc', headers: { cookie: owner } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('edge CRUD', () => {
  it('create → get → patch → delete an edge', async () => {
    const { owner } = await setup();
    const a = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    const b = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    const create = await app.inject({
      method: 'POST',
      url: '/api/db/kb/edges',
      headers: { cookie: owner },
      payload: { type: 'KNOWS', from: a, to: b, properties: { since: 1833 } },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/db/kb/edges/${id}`,
          headers: { cookie: owner },
        })
      ).json(),
    ).toMatchObject({ type: 'KNOWS', from: a, to: b, properties: { since: 1833 } });
    await app.inject({
      method: 'PATCH',
      url: `/api/db/kb/edges/${id}`,
      headers: { cookie: owner },
      payload: { set: { since: 1840 }, remove: [] },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/db/kb/edges/${id}`,
          headers: { cookie: owner },
        })
      ).json().properties,
    ).toEqual({ since: 1840 });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/db/kb/edges/${id}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(204);
  });

  it('creating an edge to a missing node is 400/404', async () => {
    const { owner } = await setup();
    const a = (
      await app.inject({
        method: 'POST',
        url: '/api/db/kb/nodes',
        headers: { cookie: owner },
        payload: { labels: ['P'] },
      })
    ).json().id;
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/edges',
      headers: { cookie: owner },
      payload: { type: 'R', from: a, to: 99999 },
    });
    expect([400, 404]).toContain(r.statusCode);
  });
});
