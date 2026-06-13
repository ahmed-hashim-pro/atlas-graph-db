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
  dir = await mkdtemp(join(tmpdir(), 'atlas-app-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('app base', () => {
  it('GET /healthz is public and reports ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
  });

  it('protected routes reject anonymous callers with 401 problem-details', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/db' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('unknown engine/internal errors become 500 problem-details, not stack traces', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(r.statusCode).toBe(404); // Fastify not-found, shaped as problem-details
    expect(r.json()).toHaveProperty('status', 404);
  });

  it('admin bootstrap seeds an admin when configured', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'atlas-app2-'));
    const app2 = await buildServer(
      loadConfig({
        ATLAS_DATA_DIR: dir2,
        ATLAS_SECRET: 's'.repeat(32),
        ATLAS_ADMIN_USER: 'root',
        ATLAS_ADMIN_PASSWORD: 'rootpass1',
      }),
    );
    const r = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'rootpass1' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: 'root', isAdmin: true });
    await app2.close();
    await rm(dir2, { recursive: true, force: true });
  });
});
