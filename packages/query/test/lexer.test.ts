import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { lex } from '../src/lexer.js';

function kinds(src: string): string[] {
  return lex(src).map((t) => `${t.type}:${t.value}`);
}

describe('lex', () => {
  it('tokenizes a representative read query with positions', () => {
    const toks = lex(
      'MATCH (p:Person)-[:WROTE]->(d)\nWHERE d.year >= 1840\nRETURN p.name AS author',
    );
    expect(toks.at(-1)!.type).toBe('eof');
    const where = toks.find((t) => t.value === 'WHERE')!;
    expect(where.type).toBe('keyword');
    expect(where.line).toBe(2);
    expect(where.column).toBe(1);
    const ge = toks.find((t) => t.value === '>=')!;
    expect(ge.type).toBe('punct');
    expect(ge.line).toBe(2);
  });

  it('keywords are case-insensitive and normalized; identifiers keep case', () => {
    expect(kinds('match Person RETURN aS')).toEqual([
      'keyword:MATCH',
      'ident:Person',
      'keyword:RETURN',
      'keyword:AS',
      'eof:',
    ]);
  });

  it('lexes strings with both quote styles and escapes', () => {
    const toks = lex(`RETURN 'it\\'s', "two\\nlines", 'tab\\t'`);
    const strs = toks.filter((t) => t.type === 'string').map((t) => t.value);
    expect(strs).toEqual(["it's", 'two\nlines', 'tab\t']);
  });

  it('lexes numbers, params, and multi-char puncts greedily', () => {
    expect(kinds('$min <= 3.5 <> 2 .. ->')).toEqual([
      'param:min',
      'punct:<=',
      'number:3.5',
      'punct:<>',
      'number:2',
      'punct:..',
      'punct:->',
      'eof:',
    ]);
  });

  it('skips // comments to end of line', () => {
    expect(
      kinds('RETURN 1 // trailing\n// whole line\nRETURN 2').filter((k) => k !== 'eof:'),
    ).toEqual(['keyword:RETURN', 'number:1', 'keyword:RETURN', 'number:2']);
  });

  it('reports bad characters and unterminated strings with positions', () => {
    try {
      lex('RETURN ^');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AqlError);
      expect((e as AqlError).code).toBe('PARSE_ERROR');
      expect((e as AqlError).column).toBe(8);
    }
    expect(() => lex("RETURN 'open")).toThrowError(AqlError);
  });
});
