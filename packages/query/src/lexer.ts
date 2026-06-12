import { AqlError } from './errors.js';

export type TokenType = 'keyword' | 'ident' | 'param' | 'number' | 'string' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  'MATCH', 'WHERE', 'RETURN', 'AS', 'DISTINCT', 'ORDER', 'BY', 'SKIP', 'LIMIT',
  'ASC', 'DESC', 'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'STARTS', 'ENDS', 'WITH',
  'EXISTS', 'NULL', 'TRUE', 'FALSE', 'EXPLAIN',
]);

const MULTI_PUNCTS = ['<=', '>=', '<>', '->', '<-', '..'];
const SINGLE_PUNCTS = new Set(['(', ')', '[', ']', '{', '}', ':', ',', '.', '=', '<', '>', '-', '*', '|']);
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' };

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const fail = (msg: string, l = line, c = column): never => {
    throw new AqlError('PARSE_ERROR', msg, { line: l, column: c }, source);
  };
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j]!)) j++;
      const raw = source.slice(i, j);
      const upper = raw.toUpperCase();
      advance(raw.length);
      tokens.push(
        KEYWORDS.has(upper)
          ? { type: 'keyword', value: upper, line: startLine, column: startCol }
          : { type: 'ident', value: raw, line: startLine, column: startCol },
      );
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      if (j >= source.length || !IDENT_START.test(source[j]!)) fail('expected parameter name after "$"');
      while (j < source.length && IDENT_PART.test(source[j]!)) j++;
      const name = source.slice(i + 1, j);
      advance(j - i);
      tokens.push({ type: 'param', value: name, line: startLine, column: startCol });
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j++;
      // ".." after a number is a range punct, not a decimal point.
      if (source[j] === '.' && source[j + 1] !== '.' && source[j + 1]! >= '0' && source[j + 1]! <= '9') {
        j++;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j++;
      }
      const raw = source.slice(i, j);
      advance(raw.length);
      tokens.push({ type: 'number', value: raw, line: startLine, column: startCol });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= source.length) fail('unterminated string', startLine, startCol);
        const c = source[j]!;
        if (c === '\\') {
          const esc = ESCAPES[source[j + 1] ?? ''];
          if (esc === undefined) fail(`unknown escape "\\${source[j + 1] ?? ''}"`, startLine, startCol);
          out += esc;
          j += 2;
          continue;
        }
        if (c === ch) break;
        out += c;
        j++;
      }
      advance(j + 1 - i);
      tokens.push({ type: 'string', value: out, line: startLine, column: startCol });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (MULTI_PUNCTS.includes(two)) {
      advance(2);
      tokens.push({ type: 'punct', value: two, line: startLine, column: startCol });
      continue;
    }
    if (SINGLE_PUNCTS.has(ch)) {
      advance();
      tokens.push({ type: 'punct', value: ch, line: startLine, column: startCol });
      continue;
    }
    fail(`unexpected character "${ch}"`);
  }
  tokens.push({ type: 'eof', value: '', line, column });
  return tokens;
}
