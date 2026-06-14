import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Workspace } from './workspace';
import type { QueryResponse } from '@atlas/protocol';
import type { SchemaSummary } from '@atlas/core';

const schema: SchemaSummary = {
  labels: [{ label: 'Person', count: 1, properties: [] }],
  edgeTypes: [],
};
const initial: QueryResponse = {
  columns: ['n', 'r', 'm'],
  rows: [[{ id: '1', labels: ['Person'], properties: { name: 'Ada' } }, null, null]],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};
const expanded: QueryResponse = {
  columns: ['n', 'r', 'm'],
  rows: [
    [
      { id: '1', labels: ['Person'], properties: { name: 'Ada' } },
      { id: 'e', type: 'KNOWS', from: '1', to: '2', properties: {} },
      { id: '2', labels: ['Person'], properties: { name: 'Bob' } },
    ],
  ],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};

function db(query: ReturnType<typeof vi.fn>, schemaFn: ReturnType<typeof vi.fn>) {
  return { query, schema: schemaFn, subscribe: vi.fn().mockResolvedValue({ close: vi.fn() }) };
}

describe('Workspace page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup(query: ReturnType<typeof vi.fn>, schemaFn: ReturnType<typeof vi.fn>) {
    TestBed.configureTestingModule({
      imports: [Workspace],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { database: () => db(query, schemaFn) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'kb' } } } },
      ],
    });
    const fixture = TestBed.createComponent(Workspace);
    return { fixture, cmp: fixture.componentInstance };
  }

  it('loads the initial graph + schema into its store on init', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture, cmp } = setup(query, schemaFn);
    fixture.detectChanges();
    await cmp.ready;
    fixture.detectChanges();
    expect(schemaFn).toHaveBeenCalled();
    expect(cmp.store.visibleNodes().map((n) => n.id)).toContain('1');
    expect(cmp.store.labels().some((l) => l.label === 'Person')).toBe(true);
  });

  it('onExpand fetches neighbors and folds them into the store', async () => {
    const query = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(expanded);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture, cmp } = setup(query, schemaFn);
    fixture.detectChanges();
    await cmp.ready;
    await cmp.onExpand('1');
    fixture.detectChanges();
    expect(
      cmp.store
        .visibleNodes()
        .map((n) => n.id)
        .sort(),
    ).toEqual(['1', '2']);
    expect(cmp.store.visibleEdges().map((e) => e.id)).toEqual(['e']);
  });

  it('⌘K toggles the command palette open', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture } = setup(query, schemaFn);
    fixture.detectChanges();
    await fixture.componentInstance.ready;
    expect(fixture.componentInstance.paletteOpen()).toBe(false);
    fixture.componentInstance.onHostKey(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
    );
    expect(fixture.componentInstance.paletteOpen()).toBe(true);
  });

  it('picking a search hit adds it to the store and selects it', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const { fixture } = setup(query, schemaFn);
    fixture.detectChanges();
    await fixture.componentInstance.ready;
    await fixture.whenStable();
    await fixture.componentInstance.onPick({ id: '1', labels: ['Person'], label: 'Ada' });
    expect(fixture.componentInstance.store.selection()).toEqual({ kind: 'node', id: '1' });
  });
});
