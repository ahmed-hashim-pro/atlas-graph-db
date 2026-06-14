import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics.js';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

describe('MetricsRegistry', () => {
  it('counters, gauges, and histograms render Prometheus text', () => {
    const m = new MetricsRegistry();
    m.queriesTotal.inc();
    m.queriesTotal.inc();
    m.wsSubscribers.inc();
    m.queryLatencyMs.observe(5);
    m.queryLatencyMs.observe(120);
    const text = m.render();
    expect(text).toContain('atlas_queries_total 2');
    expect(text).toContain('atlas_ws_subscribers 1');
    expect(text).toContain('atlas_query_latency_ms_bucket{le="10"} 1');
    expect(text).toContain('atlas_query_latency_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('atlas_query_latency_ms_count 2');
    expect(text).toMatch(/atlas_query_latency_ms_sum 125/);
  });
});

let dir: string;
let app: FastifyInstance;

describe('/metrics endpoint', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-metrics-'));
    app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is public and exposes counters in Prometheus format', async () => {
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('atlas_queries_total');
  });

  it('increments query counter + latency on a query', async () => {
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
      url: '/api/db/kb/query',
      headers: { cookie },
      payload: { query: 'MATCH (n) RETURN n', params: {} },
    });
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.body).toMatch(/atlas_queries_total [1-9]/);
  });

  it('a failed query increments queryErrorsTotal and queriesTotal, not just successes', async () => {
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

    // An invalid query (empty RETURN → parse error) 400s and must still be
    // metered (the route counts parse failures before re-throwing).
    const bad = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie },
      payload: { query: 'MATCH (n) RETURN', params: {} },
    });
    expect(bad.statusCode).toBe(400);
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/atlas_query_errors_total [1-9]/);
    expect(metrics).toMatch(/atlas_queries_total [1-9]/);
  });
});
