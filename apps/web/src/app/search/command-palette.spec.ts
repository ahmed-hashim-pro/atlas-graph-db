import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { CommandPalette } from './command-palette';
import type { QueryResponse } from '@atlas/protocol';

const found: QueryResponse = {
  columns: ['n'],
  rows: [[{ id: '7', labels: ['Person'], props: { name: 'Ada' } }]],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};

describe('CommandPalette', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup(query = vi.fn().mockResolvedValue(found)) {
    TestBed.configureTestingModule({
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query }) } }],
    });
    const fixture = TestBed.createComponent(CommandPalette);
    fixture.componentRef.setInput('database', 'kb');
    return { fixture, query };
  }

  it('runs the search and exposes hits', async () => {
    const { fixture, query } = setup();
    const cmp = fixture.componentInstance;
    cmp.term.set('ada');
    await cmp.search();
    expect(query).toHaveBeenCalledTimes(1);
    expect(cmp.hits()).toHaveLength(1);
    expect(cmp.hits()[0].label).toBe('Ada');
  });

  it('arrow keys move the active index and Enter emits the active hit', async () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    const picked: string[] = [];
    cmp.pick.subscribe((h) => picked.push(h.id));
    cmp.term.set('ada');
    await cmp.search();
    cmp.onKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picked).toEqual(['7']);
  });

  it('Escape emits close', () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    let closed = false;
    cmp.closed.subscribe(() => (closed = true));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(true);
  });
});
