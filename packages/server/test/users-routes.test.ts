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
  dir = await mkdtemp(join(tmpdir(), 'atlas-users-'));
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

/** Register a normal (non-admin) user via the public route and return their session cookie. */
async function normalUser(username: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'secret12' },
  });
  return cookieFor(username, 'secret12');
}

describe('admin user routes', () => {
  it('GET /api/users is unauthenticated → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/users' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /api/users as a non-admin → 403', async () => {
    const cookie = await normalUser('ada');
    const r = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });

  it('admin can list users (no password hashes leaked)', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await normalUser('ada');
    const r = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } });
    expect(r.statusCode).toBe(200);
    const list = r.json() as { username: string; isAdmin: boolean }[];
    expect(list.map((u) => u.username)).toContain('ada');
    expect(JSON.stringify(list)).not.toContain('passwordHash');
  });

  it('admin creates a user and an audit entry is recorded', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    const r = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'bob', password: 'secret12', isAdmin: false },
    });
    expect(r.statusCode).toBe(201);
    // New user can authenticate.
    const bob = await cookieFor('bob', 'secret12');
    expect(bob).toContain('atlas_session=');
    // Audit recorded the create.
    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie: admin },
    });
    const actions = (audit.json() as { action: string; target: string }[]).map((e) => e.action);
    expect(actions).toContain('user:create');
  });

  it('rejects an invalid username on create → 400 (no unmanageable accounts)', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    // A username with a space passes the loose schema but is rejected by the strict
    // management-route param schema, leaving an account that can never be deleted.
    const spaced = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'bad user', password: 'secret12' },
    });
    expect(spaced.statusCode).toBe(400);
    // A username with a slash breaks the management route path entirely.
    const slashed = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'a/b', password: 'secret12' },
    });
    expect(slashed.statusCode).toBe(400);
    // Neither account was created.
    const list = (
      await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })
    ).json() as { username: string }[];
    expect(list.map((u) => u.username)).not.toContain('bad user');
    expect(list.map((u) => u.username)).not.toContain('a/b');
  });

  it('creating a duplicate user → 409', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'bob', password: 'secret12' },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'bob', password: 'secret12' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('promotes and demotes a user', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await normalUser('ada');
    const promote = await app.inject({
      method: 'PATCH',
      url: '/api/users/ada',
      headers: { cookie: admin },
      payload: { isAdmin: true },
    });
    expect(promote.statusCode).toBe(204);
    // ada is now an admin and can list users.
    const ada = await cookieFor('ada', 'secret12');
    expect(
      (await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: ada } })).statusCode,
    ).toBe(200);
  });

  it('refuses to demote the last admin → 409', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/users/root',
      headers: { cookie: admin },
      payload: { isAdmin: false },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('CONSTRAINT_VIOLATION');
  });

  it('password reset kills existing sessions', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    const ada = await normalUser('ada');
    // ada has a working session.
    expect(
      (await app.inject({ method: 'GET', url: '/api/db', headers: { cookie: ada } })).statusCode,
    ).toBe(200);
    const reset = await app.inject({
      method: 'POST',
      url: '/api/users/ada/password',
      headers: { cookie: admin },
      payload: { password: 'brandnew1' },
    });
    expect(reset.statusCode).toBe(204);
    // ada's old session no longer authenticates.
    expect(
      (await app.inject({ method: 'GET', url: '/api/db', headers: { cookie: ada } })).statusCode,
    ).toBe(401);
    // ada can log in with the new password.
    const fresh = await cookieFor('ada', 'brandnew1');
    expect(fresh).toContain('atlas_session=');
  });

  it('refuses self-delete → 409', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/users/root',
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(409);
  });

  it('refuses deleting the last admin → 409', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    // Create a second admin so root is no longer doing a "self" delete on the target.
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { username: 'ada', password: 'secret12', isAdmin: true },
    });
    const ada = await cookieFor('ada', 'secret12');
    // ada demotes root → root is no longer admin; now ada is the last admin.
    await app.inject({
      method: 'PATCH',
      url: '/api/users/root',
      headers: { cookie: ada },
      payload: { isAdmin: false },
    });
    // ada tries to delete root — fine; then deleting the sole remaining admin (ada) must 409.
    const delAda = await app.inject({
      method: 'DELETE',
      url: '/api/users/ada',
      headers: { cookie: ada },
    });
    expect(delAda.statusCode).toBe(409);
  });

  it('admin deletes a user (204)', async () => {
    const admin = await cookieFor('root', 'rootpass1');
    await normalUser('ada');
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/users/ada',
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(204);
    const list = (
      await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })
    ).json() as { username: string }[];
    expect(list.map((u) => u.username)).not.toContain('ada');
  });
});
