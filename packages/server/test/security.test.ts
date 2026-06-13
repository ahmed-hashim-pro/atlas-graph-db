import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;

async function make(env: Record<string, string>): Promise<FastifyInstance> {
  dir = await mkdtemp(join(tmpdir(), 'atlas-sec-'));
  return buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32), ...env }));
}
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('security headers', () => {
  it('sets standard hardening headers on every response', async () => {
    app = await make({});
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and rejects others', async () => {
    app = await make({ ATLAS_CORS_ORIGINS: 'https://app.example' });
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/db', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example');
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/db', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('429s a token after exceeding its per-window budget', async () => {
    app = await make({ ATLAS_RATE_LIMIT: '3', ATLAS_RATE_WINDOW_MS: '60000' });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } })).statusCode);
    expect(codes.filter((c) => c === 200).length).toBe(3);
    expect(codes.filter((c) => c === 429).length).toBe(2);
  });

  it('does not rate-limit /healthz or /metrics', async () => {
    app = await make({ ATLAS_RATE_LIMIT: '1', ATLAS_RATE_WINDOW_MS: '60000' });
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('resets the counter after the window elapses', async () => {
    // Tiny window so the fixed-window reset branch (nowMs >= entry.resetAt) is exercised.
    app = await make({ ATLAS_RATE_LIMIT: '1', ATLAS_RATE_WINDOW_MS: '20' });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'grace', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'grace', password: 'secret12' } });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    // First request in the window: allowed.
    expect((await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } })).statusCode).toBe(200);
    // Second request, still inside the window: over budget -> 429.
    expect((await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } })).statusCode).toBe(429);
    // Wait past the window so the next request opens a fresh bucket.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } })).statusCode).toBe(200);
  });
});
