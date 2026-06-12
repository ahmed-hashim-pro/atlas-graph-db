export type AqlErrorCode =
  | 'PARSE_ERROR'
  | 'SEMANTIC_ERROR'
  | 'RUNTIME_ERROR'
  | 'TIMEOUT'
  | 'ROW_LIMIT';

/** Caret rendering: the offending source line, then a `^` under the 1-based column. */
export function renderSnippet(source: string, line: number, column: number): string {
  const lines = source.split('\n');
  const idx = Math.min(Math.max(line, 1), lines.length) - 1;
  const text = lines[idx] ?? '';
  const col = Math.min(Math.max(column, 1), text.length + 1);
  return `${text}\n${' '.repeat(col - 1)}^`;
}

export class AqlError extends Error {
  readonly line: number;
  readonly column: number;
  readonly snippet: string;

  constructor(
    readonly code: AqlErrorCode,
    message: string,
    pos: { line: number; column: number },
    source: string,
  ) {
    super(message);
    this.name = 'AqlError';
    this.line = pos.line;
    this.column = pos.column;
    this.snippet = renderSnippet(source, pos.line, pos.column);
  }
}
