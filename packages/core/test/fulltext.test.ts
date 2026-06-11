import { describe, expect, it } from 'vitest';
import { FulltextIndex, tokenize } from '../src/index/fulltext.js';

describe('tokenize', () => {
  it('lowercases and splits on non-letter/number runs, unicode included', () => {
    expect(tokenize('Notes on the Analytical Engine!')).toEqual([
      'notes',
      'on',
      'the',
      'analytical',
      'engine',
    ]);
    expect(tokenize('Ada—Lovelace 1815')).toEqual(['ada', 'lovelace', '1815']);
    expect(tokenize('Théorie analytique')).toEqual(['théorie', 'analytique']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('FulltextIndex', () => {
  function seeded(): FulltextIndex {
    const ix = new FulltextIndex();
    ix.add('Notes on the Analytical Engine', 1);
    ix.add('Sketch of the Analytical Engine', 2);
    ix.add('On the Origin of Species', 3);
    return ix;
  }

  it('ANDs all query tokens', () => {
    const ix = seeded();
    expect([...ix.search('analytical engine')].sort()).toEqual([1, 2]);
    expect([...ix.search('notes engine')]).toEqual([1]);
    expect([...ix.search('engine species')]).toEqual([]);
    expect([...ix.search('')]).toEqual([]);
  });

  it('prefix mode expands the final token (search-as-you-type)', () => {
    const ix = seeded();
    expect([...ix.search('anal', { prefix: true })].sort()).toEqual([1, 2]);
    expect([...ix.search('origin of spec', { prefix: true })]).toEqual([3]);
    expect([...ix.search('anal', {})]).toEqual([]); // exact token 'anal' matches nothing
  });

  it('indexes string arrays, ignores non-strings, and removes cleanly', () => {
    const ix = new FulltextIndex();
    ix.add(['graph theory', 'algebra'], 7);
    ix.add(1815, 8); // numbers are not text — skipped
    expect([...ix.search('algebra')]).toEqual([7]);
    ix.remove(['graph theory', 'algebra'], 7);
    expect([...ix.search('algebra')]).toEqual([]);
    expect(ix.tokenCount).toBe(0);
  });
});
