import type { AtlasDatabase } from '@atlas/core';
import { runRead } from './exec.js';
import { parseQuery } from './parser.js';
import { serializePlan } from './plan.js';
import { planQuery } from './planner.js';

export interface QueryOptions {
  params?: Record<string, unknown>;
  /** Per-query wall-clock budget. Default 30s. */
  timeoutMs?: number;
  /** Maximum result rows; exceeding raises ROW_LIMIT (never silent truncation). Default 100k. */
  maxRows?: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  stats: { rowsExamined: number; elapsedMs: number };
}

/**
 * Parse, plan, and execute an AQL read query. `EXPLAIN <query>` returns a
 * single `plan` column holding the serialized plan JSON instead of results.
 * Async for wire-compatibility with M4b (CALL algo.*); reads execute
 * synchronously inside.
 */
export async function executeQuery(
  db: AtlasDatabase,
  text: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const started = performance.now();
  const parsed = parseQuery(text);
  const plan = planQuery(parsed.query, db.graphStore);
  if (parsed.explain) {
    return {
      columns: ['plan'],
      rows: [[serializePlan(plan)]],
      stats: { rowsExamined: 0, elapsedMs: Math.round(performance.now() - started) },
    };
  }
  const result = runRead(plan, parsed.query, db.graphStore, {
    params: opts.params ?? {},
    source: text,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxRows: opts.maxRows ?? 100_000,
  });
  return {
    columns: result.columns,
    rows: result.rows,
    stats: {
      rowsExamined: result.stats.rowsExamined,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}

/** The plan a query would run with, as plain JSON (the EXPLAIN payload). */
export function explainQuery(db: AtlasDatabase, text: string): Record<string, unknown> {
  const parsed = parseQuery(text);
  return serializePlan(planQuery(parsed.query, db.graphStore));
}
