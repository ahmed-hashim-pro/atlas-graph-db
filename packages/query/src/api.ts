import type { AtlasDatabase } from '@atlas/core';
import { runCall } from './call.js';
import { runDdl } from './ddl.js';
import { runRead } from './exec.js';
import { parseQuery } from './parser.js';
import { describeCallPlan, describeDdlPlan, describeWritePlan, serializePlan } from './plan.js';
import { planQuery } from './planner.js';
import { runWrite } from './write.js';

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
  stats: {
    rowsExamined: number;
    elapsedMs: number;
    created?: number;
    deleted?: number;
    propsSet?: number;
  };
}

/**
 * Parse, plan, and execute any AQL statement: read, write, DDL, or CALL.
 * `EXPLAIN <statement>` returns a single `plan` column holding the serialized
 * plan JSON instead of executing. Writes run inside a single transaction so a
 * failure rolls the whole statement back.
 */
export async function executeQuery(
  db: AtlasDatabase,
  text: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const started = performance.now();
  const params = opts.params ?? {};
  const parsed = parseQuery(text);
  const ms = (): number => Math.round(performance.now() - started);

  if (parsed.explain) {
    const plan =
      parsed.statement.type === 'read'
        ? serializePlan(planQuery(parsed.statement.query, db.graphStore))
        : parsed.statement.type === 'write'
          ? describeWritePlan(parsed.statement.query)
          : parsed.statement.type === 'ddl'
            ? describeDdlPlan(parsed.statement.statement)
            : describeCallPlan(parsed.statement.statement);
    return { columns: ['plan'], rows: [[plan]], stats: { rowsExamined: 0, elapsedMs: ms() } };
  }

  switch (parsed.statement.type) {
    case 'read': {
      const query = parsed.statement.query;
      const plan = planQuery(query, db.graphStore);
      const result = runRead(plan, query, db.graphStore, {
        params,
        source: text,
        timeoutMs: opts.timeoutMs ?? 30_000,
        maxRows: opts.maxRows ?? 100_000,
      });
      return {
        columns: result.columns,
        rows: result.rows,
        stats: { rowsExamined: result.stats.rowsExamined, elapsedMs: ms() },
      };
    }
    case 'write': {
      const query = parsed.statement.query;
      let out = {
        columns: [] as string[],
        rows: [] as unknown[][],
        stats: { created: 0, deleted: 0, propsSet: 0 },
      };
      await db.transact((tx) => {
        out = runWrite(query, db.graphStore, tx, { params, source: text });
      });
      return {
        columns: out.columns,
        rows: out.rows,
        stats: { rowsExamined: 0, elapsedMs: ms(), ...out.stats },
      };
    }
    case 'ddl': {
      const r = await runDdl(parsed.statement.statement, db);
      return { columns: r.columns, rows: r.rows, stats: { rowsExamined: 0, elapsedMs: ms() } };
    }
    case 'call': {
      const r = await runCall(parsed.statement.statement, db, params);
      return { columns: r.columns, rows: r.rows, stats: { rowsExamined: 0, elapsedMs: ms() } };
    }
  }
}

/** The plan a query would run with, as plain JSON (the EXPLAIN payload). */
export function explainQuery(db: AtlasDatabase, text: string): Record<string, unknown> {
  const parsed = parseQuery(text);
  if (parsed.statement.type === 'read')
    return serializePlan(planQuery(parsed.statement.query, db.graphStore));
  if (parsed.statement.type === 'write') return describeWritePlan(parsed.statement.query);
  if (parsed.statement.type === 'ddl') return describeDdlPlan(parsed.statement.statement);
  return describeCallPlan(parsed.statement.statement);
}
