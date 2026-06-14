import { describe, expect, it } from 'vitest';
import { AQL_KEYWORDS, AQL_FUNCTIONS, tokenizeAql, type AqlToken } from './aql-language';

function kinds(src: string): [string, AqlToken['kind']][] {
  return tokenizeAql(src).map((t) => [t.text, t.kind]);
}

describe('AQL keyword list', () => {
  it('includes the §5.2 clause keywords and is upper-cased + unique', () => {
    for (const kw of ['MATCH', 'WHERE', 'RETURN', 'CREATE', 'MERGE', 'SET', 'DELETE', 'EXPLAIN'])
      expect(AQL_KEYWORDS).toContain(kw);
    expect(new Set(AQL_KEYWORDS).size).toBe(AQL_KEYWORDS.length);
    expect(AQL_KEYWORDS.every((k) => k === k.toUpperCase())).toBe(true);
  });

  it('exposes the aggregate function names from §5.2', () => {
    for (const fn of ['count', 'collect', 'sum', 'avg', 'min', 'max'])
      expect(AQL_FUNCTIONS).toContain(fn);
  });
});

describe('tokenizeAql', () => {
  it('classifies keywords case-insensitively', () => {
    expect(kinds('match (n) return n')).toEqual([
      ['match', 'keyword'],
      ['(', 'punctuation'],
      ['n', 'identifier'],
      [')', 'punctuation'],
      ['return', 'keyword'],
      ['n', 'identifier'],
    ]);
  });

  it('classifies strings, numbers, params, labels, and operators', () => {
    expect(kinds("WHERE n.born >= 1800 AND n.name = 'Ada' OR n.id IN $ids")).toEqual([
      ['WHERE', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['born', 'identifier'],
      ['>=', 'operator'],
      ['1800', 'number'],
      ['AND', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['name', 'identifier'],
      ['=', 'operator'],
      ["'Ada'", 'string'],
      ['OR', 'keyword'],
      ['n', 'identifier'],
      ['.', 'punctuation'],
      ['id', 'identifier'],
      ['IN', 'keyword'],
      ['$ids', 'parameter'],
    ]);
  });

  it('tokenizes a label after a colon and a line comment', () => {
    const t = tokenizeAql('MATCH (p:Person) // find people');
    expect(t.find((x) => x.text === ':Person')?.kind).toBe('label');
    expect(t.at(-1)).toMatchObject({ kind: 'comment', text: '// find people' });
  });

  it('does not choke on an unterminated string (emits a string token to EOL)', () => {
    expect(tokenizeAql("RETURN 'oops").at(-1)).toMatchObject({ kind: 'string', text: "'oops" });
  });
});
