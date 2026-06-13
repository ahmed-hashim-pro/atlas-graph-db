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
  dir = await mkdtemp(join(tmpdir(), 'atlas-authr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function cookieFrom(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'atlas_session')!;
  return `atlas_session=${c.value}`;
}

describe('auth routes', () => {
  it('register → login → whoami round trip', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ada', password: 'secret12' },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ username: 'ada', isAdmin: false });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);

    const who = await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { cookie } });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ username: 'ada', isAdmin: false });
  });

  it('first registered user is NOT admin (admin only via bootstrap)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'first', password: 'secret12' },
    });
    expect(reg.json()).toMatchObject({ isAdmin: false });
  });

  it('duplicate registration is a 409', async () => {
    const payload = { username: 'ada', password: 'secret12' };
    await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    expect(dup.statusCode).toBe(409);
  });

  it('bad credentials and weak passwords are rejected', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'x', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nope', password: 'whatever1' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('logout clears the session', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = cookieFrom(login);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    // The cleared cookie should no longer authenticate (expired/empty).
    const cleared = out.cookies.find((c) => c.name === 'atlas_session');
    expect(cleared?.value === '' || (cleared?.expires?.getTime() ?? 0) <= Date.now()).toBe(true);
  });
});
