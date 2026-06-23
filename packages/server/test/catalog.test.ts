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

describe('user administration', () => {
  it('lists users sorted by username with summary fields', async () => {
    await cat.createUser('bob', 'h', false);
    await cat.createUser('ada', 'h', true);
    const users = await cat.listUsers();
    expect(users.map((u) => u.username)).toEqual(['ada', 'bob']);
    expect(users[0]).toMatchObject({ username: 'ada', isAdmin: true });
    expect(typeof users[0]!.createdAt).toBe('string');
    expect(JSON.stringify(users)).not.toContain('passwordHash');
  });

  it('sets and clears the admin flag', async () => {
    await cat.createUser('ada', 'h', false);
    await cat.setUserAdmin('ada', true);
    expect((await cat.findUser('ada'))?.isAdmin).toBe(true);
    await cat.setUserAdmin('ada', false);
    expect((await cat.findUser('ada'))?.isAdmin).toBe(false);
  });

  it('resets a password and kills existing sessions', async () => {
    await cat.createUser('ada', 'h', false);
    const sid = await cat.createSession('ada');
    await cat.resetPassword('ada', 'newhash');
    expect((await cat.findUser('ada'))?.passwordHash).toBe('newhash');
    expect(await cat.findSessionUser(sid)).toBeNull();
  });

  it('deletes a user and their sessions', async () => {
    await cat.createUser('ada', 'h', false);
    const sid = await cat.createSession('ada');
    await cat.deleteUser('ada');
    expect(await cat.findUser('ada')).toBeNull();
    expect(await cat.findSessionUser(sid)).toBeNull();
  });
});

describe('audit log', () => {
  it('records entries and lists them newest-first', async () => {
    await cat.recordAudit({ username: 'ada', action: 'db:create', target: 'kb' });
    await cat.recordAudit({ username: 'ada', action: 'node:create', target: 'kb', detail: '#1' });
    const entries = await cat.listAudit(100);
    expect(entries.map((e) => e.seq)).toEqual([2, 1]);
    expect(entries[0]).toMatchObject({ action: 'node:create', target: 'kb', detail: '#1' });
    expect(typeof entries[0]!.at).toBe('string');
  });

  it('records a real timestamp (not the fixed nowIso constant)', async () => {
    await cat.recordAudit({ username: 'ada', action: 'db:create', target: 'kb' });
    const [entry] = await cat.listAudit(1);
    expect(entry!.at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('caps the result at the requested limit', async () => {
    for (let i = 0; i < 5; i++)
      await cat.recordAudit({ username: 'ada', action: 'node:create', target: 'kb' });
    expect(await cat.listAudit(2)).toHaveLength(2);
  });

  it('continues the seq counter across reopen without collision', async () => {
    await cat.recordAudit({ username: 'ada', action: 'db:create', target: 'kb' });
    await cat.recordAudit({ username: 'ada', action: 'db:create', target: 'kb2' });
    await cat.close();
    const c2 = await CatalogService.open(join(dir, '_catalog'));
    await c2.recordAudit({ username: 'ada', action: 'db:create', target: 'kb3' });
    const seqs = (await c2.listAudit(100)).map((e) => e.seq);
    expect(seqs).toEqual([3, 2, 1]); // monotonic, no collision after reopen
    expect(new Set(seqs).size).toBe(seqs.length);
    await c2.close();
    cat = await CatalogService.open(join(dir, '_catalog')); // for afterEach close
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

describe('sessions', () => {
  it('creates, finds, deletes, and bulk-revokes sessions for a user', async () => {
    await cat.createUser('ada', 'h', false);
    const s1 = await cat.createSession('ada');
    const s2 = await cat.createSession('ada');
    expect(s1).not.toBe(s2);
    expect(await cat.findSessionUser(s1)).toBe('ada');
    expect(await cat.findSessionUser('nope')).toBeNull();

    await cat.deleteSession(s1);
    expect(await cat.findSessionUser(s1)).toBeNull();
    expect(await cat.findSessionUser(s2)).toBe('ada'); // unaffected

    await cat.deleteSessionsForUser('ada');
    expect(await cat.findSessionUser(s2)).toBeNull();
  });

  it('sessions survive reopen', async () => {
    await cat.createUser('ada', 'h', false);
    const sid = await cat.createSession('ada');
    await cat.close();
    const c2 = await CatalogService.open(join(dir, '_catalog'));
    expect(await c2.findSessionUser(sid)).toBe('ada');
    await c2.close();
    cat = await CatalogService.open(join(dir, '_catalog')); // for afterEach
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
