import { describe, expect, it } from 'vitest';
import { lex } from '../src/lexer.js';

function kinds(src: string): string[] {
  return lex(src)
    .filter((t) => t.type !== 'eof')
    .map((t) => `${t.type}:${t.value}`);
}

describe('lexer — write keywords', () => {
  it('recognizes all new keywords case-insensitively', () => {
    expect(kinds('create merge set remove delete detach on')).toEqual([
      'keyword:CREATE',
      'keyword:MERGE',
      'keyword:SET',
      'keyword:REMOVE',
      'keyword:DELETE',
      'keyword:DETACH',
      'keyword:ON',
    ]);
    expect(kinds('INDEX FULLTEXT CONSTRAINT UNIQUE DROP SHOW INDEXES CONSTRAINTS')).toEqual([
      'keyword:INDEX',
      'keyword:FULLTEXT',
      'keyword:CONSTRAINT',
      'keyword:UNIQUE',
      'keyword:DROP',
      'keyword:SHOW',
      'keyword:INDEXES',
      'keyword:CONSTRAINTS',
    ]);
    expect(kinds('call yield for')).toEqual(['keyword:CALL', 'keyword:YIELD', 'keyword:FOR']);
  });

  it('keeps identifiers that merely contain keywords intact', () => {
    expect(kinds('created merger')).toEqual(['ident:created', 'ident:merger']);
  });
});
