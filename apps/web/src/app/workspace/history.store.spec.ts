import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from './history.store';

describe('HistoryStore', () => {
  beforeEach(() => localStorage.clear());

  function make(): HistoryStore {
    return TestBed.runInInjectionContext(() => new HistoryStore());
  }

  it('records queries most-recent-first', () => {
    const h = make();
    h.use('kb');
    h.add('MATCH (a) RETURN a');
    h.add('MATCH (b) RETURN b');
    expect(h.entries().map((e) => e.query)).toEqual(['MATCH (b) RETURN b', 'MATCH (a) RETURN a']);
  });

  it('de-duplicates: re-adding an existing query moves it to the front', () => {
    const h = make();
    h.use('kb');
    h.add('Q1');
    h.add('Q2');
    h.add('Q1');
    expect(h.entries().map((e) => e.query)).toEqual(['Q1', 'Q2']);
  });

  it('ignores blank queries and trims', () => {
    const h = make();
    h.use('kb');
    h.add('   ');
    h.add('  RETURN 1  ');
    expect(h.entries().map((e) => e.query)).toEqual(['RETURN 1']);
  });

  it('caps the list at 50 entries', () => {
    const h = make();
    h.use('kb');
    for (let i = 0; i < 60; i++) h.add(`Q${i}`);
    expect(h.entries()).toHaveLength(50);
    expect(h.entries()[0]!.query).toBe('Q59');
  });

  it('persists per database and restores on a new instance', () => {
    const a = make();
    a.use('kb');
    a.add('MATCH (n) RETURN n');
    const b = make();
    b.use('kb');
    expect(b.entries().map((e) => e.query)).toEqual(['MATCH (n) RETURN n']);
    b.use('other');
    expect(b.entries()).toEqual([]);
  });

  it('clear() empties the current database history', () => {
    const h = make();
    h.use('kb');
    h.add('Q1');
    h.clear();
    expect(h.entries()).toEqual([]);
  });
});
