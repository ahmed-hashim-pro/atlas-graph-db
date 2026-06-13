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
  dir = await mkdtemp(join(tmpdir(), 'atlas-dbr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function userCookie(username: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret12' } });
  const c = login.cookies.find((x) => x.name === 'atlas_session')!;
  return `atlas_session=${c.value}`;
}

describe('database routes', () => {
  it('create → creator is owner → appears in their list', async () => {
    const cookie = await userCookie('ada');
    const create = await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    expect(create.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } });
    expect(list.json()).toEqual([{ name: 'kb', description: '', role: 'owner' }]);
  });

  it('rejects invalid db names and duplicates', async () => {
    const cookie = await userCookie('ada');
    expect(
      (await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: '../evil' } })).statusCode,
    ).toBe(400);
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    expect(
      (await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } })).statusCode,
    ).toBe(409);
  });

  it('GET /api/db/:name shows owners and the caller role; 403 for non-members', async () => {
    const ada = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    const info = await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: ada } });
    expect(info.json()).toMatchObject({ name: 'kb', role: 'owner', owners: ['ada'] });

    const bob = await userCookie('bob');
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
  });

  it('owner grants/revokes roles; only owners may grant', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });

    const grant = await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: ada },
      payload: { username: 'bob', role: 'editor' },
    });
    expect(grant.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).json()).toMatchObject({
      role: 'editor',
    });

    // bob (editor) cannot grant
    const bobGrant = await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: bob },
      payload: { username: 'bob', role: 'owner' },
    });
    expect(bobGrant.statusCode).toBe(403);

    const revoke = await app.inject({ method: 'DELETE', url: '/api/db/kb/roles/bob', headers: { cookie: ada } });
    expect(revoke.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
  });

  it('DELETE removes the database (owner only); non-owner editor gets 403', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie: ada }, payload: { username: 'bob', role: 'editor' } });

    expect((await app.inject({ method: 'DELETE', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/db/kb', headers: { cookie: ada } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: ada } })).statusCode).toBe(404);
  });
});
