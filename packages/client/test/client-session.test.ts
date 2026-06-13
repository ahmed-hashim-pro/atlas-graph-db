import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, loadConfig } from '@atlas/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let url: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-session-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client cookie mode', () => {
  it('register → login → whoami round trip with a cookie jar', async () => {
    const client = connect(url, { mode: 'cookie' });
    const reg = await client.register('ada', 'secret12');
    expect(reg).toEqual({ username: 'ada', isAdmin: false });
    const me = await client.login('ada', 'secret12');
    expect(me).toEqual({ username: 'ada', isAdmin: false });
    expect(await client.whoami()).toEqual({ username: 'ada', isAdmin: false });
  });

  it('whoami returns null when not authenticated (401 → null, not throw)', async () => {
    const client = connect(url, { mode: 'cookie' });
    expect(await client.whoami()).toBeNull();
  });

  it('logout ends the session', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('bob', 'secret12');
    await client.login('bob', 'secret12');
    expect(await client.whoami()).not.toBeNull();
    await client.logout();
    expect(await client.whoami()).toBeNull();
  });

  it('lists, creates, and seeds databases; the creator is owner', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    expect(await client.listDatabases()).toEqual([]);

    const created = await client.createDatabase('kb');
    expect(created).toEqual({ name: 'kb' });
    expect(await client.listDatabases()).toEqual([{ name: 'kb', description: '', role: 'owner' }]);

    const seeded = await client.seed('kb', 'science-history');
    expect(seeded.committed.nodes).toBeGreaterThan(0);
    expect(seeded.committed.edges).toBeGreaterThan(0);
  });

  it('queries and introspects schema through the cookie session', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');
    const db = client.database('kb');
    await db.query("CREATE (p:Person {name: 'Ada'}) RETURN p", {});
    const res = await db.query('MATCH (p:Person) RETURN p.name AS name', {});
    expect(res.rows).toEqual([['Ada']]);
    const schema = await db.schema();
    expect(schema.labels.map((l) => l.label)).toContain('Person');
  });

  it('surfaces auth failures as AtlasClientError with status', async () => {
    const client = connect(url, { mode: 'cookie' });
    await expect(client.login('nobody', 'whatever1')).rejects.toMatchObject({ status: 401 });
  });
});
