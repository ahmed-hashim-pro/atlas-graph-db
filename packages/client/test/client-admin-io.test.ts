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
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-admin-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client tokens', () => {
  it('creates a token (shown once), lists it, and revokes it', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');

    expect(await client.listTokens()).toEqual([]);
    const created = await client.createToken('ci');
    expect(created.name).toBe('ci');
    expect(created.tokenId.length).toBeGreaterThan(0);
    // The full secret is `tokenId.secret`, returned only on creation.
    expect(created.token.startsWith(`${created.tokenId}.`)).toBe(true);

    expect(await client.listTokens()).toEqual([{ tokenId: created.tokenId, name: 'ci' }]);
    await client.revokeToken(created.tokenId);
    expect(await client.listTokens()).toEqual([]);
  });

  it('revoking an unknown token surfaces a 404', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await expect(client.revokeToken('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('the freshly minted token authenticates a bearer client', async () => {
    const cookie = connect(url, { mode: 'cookie' });
    await cookie.register('ada', 'secret12');
    await cookie.login('ada', 'secret12');
    const { token } = await cookie.createToken('cli');
    const bearer = connect(url, { token });
    expect(await bearer.whoami()).toEqual({ username: 'ada', isAdmin: false });
  });
});

describe('@atlas/client roles', () => {
  it('an owner grants then revokes a role on a database they own', async () => {
    const owner = connect(url, { mode: 'cookie' });
    await owner.register('ada', 'secret12');
    await owner.login('ada', 'secret12');
    await owner.createDatabase('kb');

    const member = connect(url, { mode: 'cookie' });
    await member.register('bob', 'secret12');

    await owner.grantRole('kb', 'bob', 'editor');
    let info = await owner.getDatabase('kb');
    expect(info.owners).toContain('ada');

    // Bob can now log in and see kb with the editor role.
    await member.login('bob', 'secret12');
    expect(await member.listDatabases()).toContainEqual({
      name: 'kb',
      description: '',
      role: 'editor',
    });

    await owner.revokeRole('kb', 'bob');
    await member.login('bob', 'secret12');
    expect(await member.listDatabases()).toEqual([]);
    info = await owner.getDatabase('kb');
    expect(info.owners).toContain('ada');
  });

  it('granting a role to an unknown user surfaces a 404', async () => {
    const owner = connect(url, { mode: 'cookie' });
    await owner.register('ada', 'secret12');
    await owner.login('ada', 'secret12');
    await owner.createDatabase('kb');
    await expect(owner.grantRole('kb', 'ghost', 'viewer')).rejects.toMatchObject({ status: 404 });
  });
});

describe('@atlas/client import', () => {
  it('imports JSON nodes+edges and returns committed counts + an idMap', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');

    const res = await client.import('kb', {
      nodes: [
        { tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } },
        { tempId: 'b', labels: ['Person'], properties: { name: 'Bob' } },
      ],
      edges: [{ from: 'a', to: 'b', type: 'KNOWS', properties: {} }],
      atomic: true,
    });
    expect(res.committed).toEqual({ nodes: 2, edges: 1 });
    expect(Object.keys(res.idMap)).toEqual(['a', 'b']);
    expect(res.error).toBeUndefined();
  });

  it('imports CSV via ?format=csv', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');

    const res = await client.importCsv('kb', {
      nodesCsv: 'tempId,:label,name:string\n1,Person,Ada\n2,Person,Bob\n',
      edgesCsv: ':from,:to,:type\n1,2,KNOWS\n',
      atomic: false,
    });
    expect(res.committed.nodes).toBe(2);
    expect(res.committed.edges).toBe(1);
  });
});
