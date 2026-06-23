import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { UsersStore } from './users.store';
import type { UserSummary } from '@atlas/client';

const list: UserSummary[] = [
  { username: 'admin', isAdmin: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { username: 'bob', isAdmin: false, createdAt: '2026-01-02T00:00:00.000Z' },
];

function withApi(api: Partial<AtlasApi>): UsersStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(UsersStore);
}

describe('UsersStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the users signal', async () => {
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list) });
    await store.load();
    expect(store.users()).toEqual(list);
  });

  it('load() sets a friendly error on failure', async () => {
    const store = withApi({ listUsers: vi.fn().mockRejectedValue(new Error('boom')) });
    await store.load();
    expect(store.error()).toBe('Could not load users.');
  });

  it('create() calls the API and reloads the list', async () => {
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce([...list, { username: 'cara', isAdmin: false, createdAt: 'x' }]);
    const createUser = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listUsers, createUser });
    await store.load();
    await store.create('cara', 'password1', false);
    expect(createUser).toHaveBeenCalledWith('cara', 'password1', false);
    expect(store.users().map((u) => u.username)).toContain('cara');
  });

  it('create() surfaces a friendly error on a 409 conflict', async () => {
    const createUser = vi.fn().mockRejectedValue({ status: 409 });
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list), createUser });
    await store.create('admin', 'password1', false);
    expect(store.error()).toBe('A user named "admin" already exists.');
  });

  it('setAdmin() calls updateUser and reloads', async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list), updateUser });
    await store.setAdmin('bob', true);
    expect(updateUser).toHaveBeenCalledWith('bob', { isAdmin: true });
  });

  it('setAdmin() surfaces the last-admin guard error on 409', async () => {
    const updateUser = vi.fn().mockRejectedValue({ status: 409 });
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list), updateUser });
    await store.setAdmin('admin', false);
    expect(store.error()).toBe('Cannot demote the last admin.');
  });

  it('resetPassword() calls the API', async () => {
    const resetUserPassword = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list), resetUserPassword });
    await store.resetPassword('bob', 'newsecret1');
    expect(resetUserPassword).toHaveBeenCalledWith('bob', 'newsecret1');
  });

  it('remove() deletes and reloads', async () => {
    const listUsers = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce([list[0]]);
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listUsers, deleteUser });
    await store.load();
    await store.remove('bob');
    expect(deleteUser).toHaveBeenCalledWith('bob');
    expect(store.users().map((u) => u.username)).not.toContain('bob');
  });

  it('remove() surfaces the guard error on 409', async () => {
    const deleteUser = vi.fn().mockRejectedValue({ status: 409 });
    const store = withApi({ listUsers: vi.fn().mockResolvedValue(list), deleteUser });
    await store.remove('admin');
    expect(store.error()).toBe('Cannot delete this user.');
  });
});
