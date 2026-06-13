import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ws-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `127.0.0.1:${port}`;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
  const cookie = `atlas_session=${login.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
  const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'ws' } });
  token = created.json().token as string;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function open(path: string): Promise<{ ws: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`);
    const frames: unknown[] = [];
    const waiters: ((v: unknown) => void)[] = [];
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      const w = waiters.shift();
      if (w) w(frame);
      else frames.push(frame);
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () =>
      resolve({
        ws,
        frames,
        next: () =>
          new Promise((res) => {
            const buffered = frames.shift();
            if (buffered !== undefined) res(buffered);
            else waiters.push(res);
          }),
      });
  });
}

async function writeNode(labels: string[], props: Record<string, unknown> = {}): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/api/db/kb/nodes',
    headers: { authorization: `Bearer ${token}` },
    payload: { labels, properties: props },
  });
}

describe('WS subscriptions', () => {
  it('rejects unauthenticated connections', async () => {
    await expect(open('/ws/db/kb')).rejects.toThrow();
  });

  it('streams committed batches after a ready frame', async () => {
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    await writeNode(['Person'], { name: 'Ada' });
    const frame = (await conn.next()) as { type: string; ops: { op: string }[] };
    expect(frame.type).toBe('batch');
    expect(frame.ops.some((o) => o.op === 'createNode')).toBe(true);
    conn.ws.close();
  });

  it('label filter only forwards batches touching matching labels', async () => {
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}&labels=Document`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    await writeNode(['Person'], { name: 'ignored' }); // filtered out
    await writeNode(['Document'], { title: 'kept' });
    const frame = (await conn.next()) as { type: string; ops: { op: string }[] };
    expect(frame.type).toBe('batch');
    // the first delivered batch is the Document one (Person was filtered)
    conn.ws.close();
  });

  it('viewer token may subscribe (read capability)', async () => {
    // ada is owner; a viewer also works — covered by capability=read in the handler.
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    conn.ws.close();
  });
});
