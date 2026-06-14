import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { PickerStore } from './picker.store';
import type { DbSummary } from '@atlas/client';

const dbs: DbSummary[] = [
  { name: 'kb', description: '', role: 'owner' },
  { name: 'shared', description: 'team', role: 'editor' },
];

function withApi(api: Partial<AtlasApi>): PickerStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(PickerStore);
}

describe('PickerStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the databases signal and clears loading', async () => {
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs) });
    expect(store.loading()).toBe(false);
    const p = store.load();
    expect(store.loading()).toBe(true);
    await p;
    expect(store.databases()).toEqual(dbs);
    expect(store.loading()).toBe(false);
  });

  it('create() adds the new database then reloads the list', async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'new', description: '', role: 'owner' }]);
    const createDatabase = vi.fn().mockResolvedValue({ name: 'new' });
    const store = withApi({ listDatabases, createDatabase });
    await store.load();
    await store.create('new');
    expect(createDatabase).toHaveBeenCalledWith('new');
    expect(store.databases().map((d) => d.name)).toContain('new');
  });

  it('create() surfaces a 409 as a friendly error and does not throw', async () => {
    const createDatabase = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { status: 409 }));
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue([]), createDatabase });
    await store.create('kb');
    expect(store.error()).toContain('already exists');
  });

  it('seed() calls the API for science-history', async () => {
    const seed = vi.fn().mockResolvedValue({ committed: { nodes: 10, edges: 12 } });
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue([]), seed });
    await store.seed('kb');
    expect(seed).toHaveBeenCalledWith('kb', 'science-history');
  });
});
