import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let staticDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-static-'));
  staticDir = join(dir, 'web');
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32), ATLAS_STATIC_DIR: staticDir }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('static SPA hosting', () => {
  it('serves index.html at / and SPA-fallbacks unknown non-API paths', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Atlas');
    const deep = await app.inject({ method: 'GET', url: '/workspace/kb' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('Atlas'); // SPA fallback to index.html
  });

  it('unknown /api paths stay JSON 404, not the SPA shell', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
  });
});
