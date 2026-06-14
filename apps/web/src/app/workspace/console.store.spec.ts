import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { ConsoleStore } from './console.store';
import type { QueryResponse } from '@atlas/protocol';

const okResult: QueryResponse = {
  columns: ['name'],
  rows: [['Ada'], ['Bob']],
  stats: { rowsExamined: 2, elapsedMs: 3 },
};

function withDb(query: ReturnType<typeof vi.fn>): ConsoleStore {
  const database = vi.fn().mockReturnValue({ query });
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: { database } }] });
  const store = TestBed.inject(ConsoleStore);
  store.useDatabase('kb');
  return store;
}

describe('ConsoleStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('run() populates columns/rows/stats and clears error + running', async () => {
    const query = vi.fn().mockResolvedValue(okResult);
    const store = withDb(query);
    await store.run('MATCH (p:Person) RETURN p.name AS name');
    expect(query).toHaveBeenCalledWith('MATCH (p:Person) RETURN p.name AS name', {});
    expect(store.columns()).toEqual(['name']);
    expect(store.rows()).toEqual([['Ada'], ['Bob']]);
    expect(store.stats()?.rowsExamined).toBe(2);
    expect(store.error()).toBeNull();
    expect(store.running()).toBe(false);
  });

  it('maps an AqlError problem into a structured ConsoleError with caret position', async () => {
    const err = Object.assign(new Error('unexpected token'), {
      status: 400,
      code: 'PARSE_ERROR',
      problem: { code: 'PARSE_ERROR', line: 1, column: 7, snippet: 'MATCH x\n      ^', detail: 'unexpected token' },
    });
    const store = withDb(vi.fn().mockRejectedValue(err));
    await store.run('MATCH x');
    expect(store.error()).toMatchObject({ code: 'PARSE_ERROR', line: 1, column: 7, message: 'unexpected token' });
    expect(store.error()?.snippet).toContain('^');
    expect(store.rows()).toEqual([]);
  });

  it('falls back to a generic message when the error has no problem-details', async () => {
    const store = withDb(vi.fn().mockRejectedValue(new Error('network down')));
    await store.run('RETURN 1');
    expect(store.error()?.message).toContain('network down');
    expect(store.error()?.line).toBeUndefined();
  });

  it('refuses to run an empty query', async () => {
    const query = vi.fn();
    const store = withDb(query);
    await store.run('   ');
    expect(query).not.toHaveBeenCalled();
  });
});
