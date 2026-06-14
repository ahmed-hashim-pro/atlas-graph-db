import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { ImportStore } from './import.store';
import type { ImportResult } from '@atlas/protocol';

const result: ImportResult = { committed: { nodes: 2, edges: 1 }, idMap: { a: 0, b: 1 } };

function withApi(api: Partial<AtlasApi>): ImportStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(ImportStore);
}

describe('ImportStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('runJson() parses, calls import, and holds the result', async () => {
    const importFn = vi.fn().mockResolvedValue(result);
    const store = withApi({ import: importFn });
    await store.runJson(
      'kb',
      JSON.stringify({
        nodes: [
          { tempId: 'a', labels: ['X'] },
          { tempId: 'b', labels: ['X'] },
        ],
      }),
      false,
    );
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(store.result()).toEqual(result);
    expect(store.error()).toBe('');
  });

  it('runJson() surfaces a parse error and does not call the API', async () => {
    const importFn = vi.fn();
    const store = withApi({ import: importFn });
    await store.runJson('kb', '{bad', false);
    expect(importFn).not.toHaveBeenCalled();
    expect(store.error()).toContain('JSON');
    expect(store.result()).toBeNull();
  });

  it('runCsv() forwards the CSV body + atomic flag', async () => {
    const importCsv = vi.fn().mockResolvedValue(result);
    const store = withApi({ importCsv });
    await store.runCsv('kb', 'tempId,:label\n1,X\n', '', true);
    expect(importCsv).toHaveBeenCalledWith('kb', {
      nodesCsv: 'tempId,:label\n1,X\n',
      edgesCsv: undefined,
      atomic: true,
    });
    expect(store.result()).toEqual(result);
  });

  it('runJson() maps a 403 to a friendly permission error', async () => {
    const importFn = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const store = withApi({ import: importFn });
    await store.runJson('kb', JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }] }), false);
    expect(store.error()).toContain('permission');
  });
});
