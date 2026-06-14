import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** §5.2 clause + operator keywords, upper-cased; matching is case-insensitive at tokenize time. */
export const AQL_KEYWORDS: readonly string[] = [
  'MATCH', 'OPTIONAL', 'WHERE', 'RETURN', 'DISTINCT', 'AS', 'ORDER', 'BY', 'ASC', 'DESC',
  'SKIP', 'LIMIT', 'CREATE', 'MERGE', 'SET', 'REMOVE', 'DELETE', 'DETACH', 'ON',
  'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'STARTS', 'ENDS', 'WITH', 'EXISTS',
  'INDEX', 'UNIQUE', 'CONSTRAINT', 'FULLTEXT', 'SHOW', 'INDEXES', 'CONSTRAINTS', 'DROP',
  'CALL', 'YIELD', 'EXPLAIN', 'TRUE', 'FALSE', 'NULL',
];

/** §5.2 aggregate/utility function names (lower-cased; used for completion + highlight). */
export const AQL_FUNCTIONS: readonly string[] = ['count', 'collect', 'sum', 'avg', 'min', 'max', 'labels', 'type', 'id'];

const KEYWORD_SET = new Set(AQL_KEYWORDS);

export interface AqlToken {
  text: string;
  /** 0-based start offset within the source. */
  start: number;
  kind: 'keyword' | 'identifier' | 'number' | 'string' | 'parameter' | 'label' | 'operator' | 'punctuation' | 'comment';
}

const OPERATOR_CHARS = new Set(['<', '>', '=', '!', '+', '-', '*', '/']);
const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ',', '.', ':', ';']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * A small hand-written AQL tokenizer (deliberately lightweight — a full lezer
 * grammar is not warranted for v1 highlighting; see plan self-review). Always
 * makes progress and tolerates unterminated strings (emits to end-of-line).
 */
export function tokenizeAql(src: string): AqlToken[] {
  const out: AqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    // Line comment // … to EOL.
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'comment' });
      i = j;
      continue;
    }
    // Parameter $name.
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'parameter' });
      i = j;
      continue;
    }
    // String 'literal' or "literal" (unterminated → to EOL).
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j++;
      const end = j < src.length && src[j] === c ? j + 1 : j;
      out.push({ text: src.slice(i, end), start: i, kind: 'string' });
      i = end;
      continue;
    }
    // Label :Name (colon immediately followed by an identifier).
    if (c === ':' && i + 1 < src.length && isIdentStart(src[i + 1]!)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'label' });
      i = j;
      continue;
    }
    // Number (integer or decimal).
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ text: src.slice(i, j), start: i, kind: 'number' });
      i = j;
      continue;
    }
    // Identifier or keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j]!)) j++;
      const text = src.slice(i, j);
      out.push({ text, start: i, kind: KEYWORD_SET.has(text.toUpperCase()) ? 'keyword' : 'identifier' });
      i = j;
      continue;
    }
    // Multi-char operators (<=, >=, <>, !=) then single operators.
    if (OPERATOR_CHARS.has(c)) {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '<>', '!='].includes(two)) {
        out.push({ text: two, start: i, kind: 'operator' });
        i += 2;
        continue;
      }
      out.push({ text: c, start: i, kind: 'operator' });
      i++;
      continue;
    }
    if (PUNCTUATION.has(c)) {
      out.push({ text: c, start: i, kind: 'punctuation' });
      i++;
      continue;
    }
    // Unknown char — consume one so we always progress.
    out.push({ text: c, start: i, kind: 'punctuation' });
    i++;
  }
  return out;
}

/** CodeMirror StreamLanguage built on the same token classification. */
export const aqlStreamLanguage = StreamLanguage.define<unknown>({
  token(stream) {
    if (stream.eatSpace()) return null;
    const rest = stream.string.slice(stream.pos);
    const tok = tokenizeAql(rest)[0];
    if (!tok || tok.start !== 0) {
      stream.next();
      return null;
    }
    stream.pos += tok.text.length;
    switch (tok.kind) {
      case 'keyword':
        return 'keyword';
      case 'number':
        return 'number';
      case 'string':
        return 'string';
      case 'parameter':
        return 'variableName.special';
      case 'label':
        return 'typeName';
      case 'comment':
        return 'comment';
      case 'operator':
        return 'operator';
      case 'punctuation':
        return 'punctuation';
      default:
        return 'variableName';
    }
  },
  languageData: { commentTokens: { line: '//' } },
});

const aqlHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)' },
  { tag: t.number, color: 'var(--accent-2)' },
  { tag: t.string, color: 'var(--node-5)' },
  { tag: t.typeName, color: 'var(--node-3)' },
  { tag: t.special(t.variableName), color: 'var(--node-6)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.operator, color: 'var(--text)' },
]);

/** The full AQL language extension (tokenizer + theme-aware highlighting). */
export function aql(): LanguageSupport {
  return new LanguageSupport(aqlStreamLanguage, [syntaxHighlighting(aqlHighlight)]);
}
