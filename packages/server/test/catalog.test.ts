import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogService } from '../src/catalog.js';

let dir: string;
let cat: CatalogService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-cat-'));
  cat = await CatalogService.open(join(dir, '_catalog'));
});
afterEach(async () => {
  await cat.close();
  await rm(dir, { recursive: true, force: true });
});

describe('users', () => {
  it('creates and fetches a user; usernames are unique', async () => {
    await cat.createUser('ada', 'hash1', false);
    const u = await cat.findUser('ada');
    expect(u).toMatchObject({ username: 'ada', passwordHash: 'hash1', isAdmin: false });
    await expect(cat.createUser('ada', 'hash2', false)).rejects.toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
    });
    expect(await cat.findUser('nobody')).toBeNull();
  });
});

describe('databases + roles', () => {
  it('records databases, grants roles, and resolves a user role', async () => {
    await cat.createUser('ada', 'h', false);
    await cat.createDatabase('kb', 'ada'); // creator becomes owner
    expect(await cat.roleOf('ada', 'kb')).toBe('owner');
    expect(await cat.listDatabasesFor('ada')).toHaveLength(1);

    await cat.createUser('bob', 'h', false);
    expect(await cat.roleOf('bob', 'kb')).toBeNull();
    await cat.grantRole('bob', 'kb', 'editor');
    expect(await cat.roleOf('bob', 'kb')).toBe('editor');
    await cat.grantRole('bob', 'kb', 'viewer'); // regrant replaces
    expect(await cat.roleOf('bob', 'kb')).toBe('viewer');
    await cat.revokeRole('bob', 'kb');
    expect(await cat.roleOf('bob', 'kb')).toBeNull();

    expect(await cat.ownersOf('kb')).toEqual(['ada']);
  });

  it('deletes a database and its grants', async () => {
    await cat.createUser('ada', 'h', false);
    await cat.createDatabase('kb', 'ada');
    await cat.deleteDatabase('kb');
    expect(await cat.databaseExists('kb')).toBe(false);
    expect(await cat.roleOf('ada', 'kb')).toBeNull();
  });
});

describe('tokens', () => {
  it('creates, lists, verifies-by-id, and revokes tokens', async () => {
    await cat.createUser('ada', 'h', false);
    const t = await cat.createToken('ada', 'ci', 'tokenhash');
    expect(t.tokenId).toBeTruthy();
    const found = await cat.findToken(t.tokenId);
    expect(found).toMatchObject({ username: 'ada', hash: 'tokenhash', name: 'ci' });
    expect((await cat.listTokens('ada'))[0]).toMatchObject({ name: 'ci' });
    await cat.revokeToken('ada', t.tokenId);
    expect(await cat.findToken(t.tokenId)).toBeNull();
  });
});

describe('persistence', () => {
  it('survives reopen', async () => {
    await cat.createUser('ada', 'h', true);
    await cat.createDatabase('kb', 'ada');
    await cat.close();
    const c2 = await CatalogService.open(join(dir, '_catalog'));
    expect((await c2.findUser('ada'))?.isAdmin).toBe(true);
    expect(await c2.databaseExists('kb')).toBe(true);
    await c2.close();
    cat = await CatalogService.open(join(dir, '_catalog')); // for afterEach close
  });
});
