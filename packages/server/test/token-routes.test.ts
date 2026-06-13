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
  dir = await mkdtemp(join(tmpdir(), 'atlas-tok-'));
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

describe('API tokens', () => {
  it('create a token, then authenticate a query with it (Bearer)', async () => {
    const cookie = await userCookie('ada');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie },
      payload: { name: 'kb' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'ci' },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token).toContain('.'); // id.secret

    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    expect(r.statusCode).toBe(200);
  });

  it('lists tokens (without secrets) and revokes them', async () => {
    const cookie = await userCookie('ada');
    const created = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'ci' },
    });
    const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain('.'); // no secret leaked
    const id = created.json().tokenId as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tokens/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } })).json(),
    ).toHaveLength(0);
  });

  it("cannot revoke another user's token (IDOR)", async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie: ada },
      payload: { name: 'kb' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: ada },
      payload: { name: 'ci' },
    });
    const adaToken = created.json().token as string;
    const adaTokenId = created.json().tokenId as string;

    // Bob knows ada's (non-secret) token id and tries to revoke it.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tokens/${adaTokenId}`,
      headers: { cookie: bob },
    });
    expect(del.statusCode).toBe(404);

    // Ada's token must survive: she can still list it and authenticate with it.
    expect(
      (await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: ada } })).json(),
    ).toHaveLength(1);
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { authorization: `Bearer ${adaToken}` },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    expect(r.statusCode).toBe(200);
  });

  it('deleting a non-existent token id returns 404', async () => {
    const cookie = await userCookie('ada');
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/tokens/doesnotexist',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it('a revoked token no longer authenticates', async () => {
    const cookie = await userCookie('ada');
    await app.inject({
      method: 'POST',
      url: '/api/db',
      headers: { cookie },
      payload: { name: 'kb' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie },
      payload: { name: 'ci' },
    });
    const token = created.json().token as string;
    await app.inject({
      method: 'DELETE',
      url: `/api/tokens/${created.json().tokenId}`,
      headers: { cookie },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'MATCH (n) RETURN n', params: {} },
    });
    expect(r.statusCode).toBe(401);
  });
});
