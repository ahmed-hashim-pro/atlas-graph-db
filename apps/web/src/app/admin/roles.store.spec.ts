import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { RolesStore } from './roles.store';
import type { DbSummary } from '@atlas/client';
import type { DbInfo } from '@atlas/protocol';

const dbs: DbSummary[] = [
  { name: 'kb', description: '', role: 'owner' },
  { name: 'readonly', description: '', role: 'viewer' },
];
const kbInfo: DbInfo = { name: 'kb', role: 'owner', owners: ['ada'] };

function withApi(api: Partial<AtlasApi>): RolesStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(RolesStore);
}

describe('RolesStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() keeps only databases the user owns', async () => {
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs) });
    await store.load();
    expect(store.ownedDatabases().map((d) => d.name)).toEqual(['kb']);
  });

  it('selecting a db loads its owners', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs), getDatabase });
    await store.load();
    await store.select('kb');
    expect(store.selected()).toBe('kb');
    expect(store.owners()).toEqual(['ada']);
  });

  it('grant() calls the API then refreshes owners', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const grantRole = vi.fn().mockResolvedValue(undefined);
    const store = withApi({
      listDatabases: vi.fn().mockResolvedValue(dbs),
      getDatabase,
      grantRole,
    });
    await store.load();
    await store.select('kb');
    await store.grant('bob', 'editor');
    expect(grantRole).toHaveBeenCalledWith('kb', 'bob', 'editor');
  });

  it('grant() maps a 404 (unknown user) to a friendly error', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const grantRole = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 404 }));
    const store = withApi({
      listDatabases: vi.fn().mockResolvedValue(dbs),
      getDatabase,
      grantRole,
    });
    await store.load();
    await store.select('kb');
    await store.grant('ghost', 'viewer');
    expect(store.error()).toContain('No user');
  });

  it('revoke() calls the API with the db + username', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const revokeRole = vi.fn().mockResolvedValue(undefined);
    const store = withApi({
      listDatabases: vi.fn().mockResolvedValue(dbs),
      getDatabase,
      revokeRole,
    });
    await store.load();
    await store.select('kb');
    await store.revoke('bob');
    expect(revokeRole).toHaveBeenCalledWith('kb', 'bob');
  });
});
