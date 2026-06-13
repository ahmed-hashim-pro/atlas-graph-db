import type { AtlasDatabase, EdgeRecord, NodeRecord } from '@atlas/core';
import type { CallStatement, Expr } from './ast.js';
import { AqlError } from './errors.js';
import { evalExpr, type EvalContext, type RuntimeValue } from './eval.js';

export interface CallResult {
  columns: string[];
  rows: RuntimeValue[][];
}

/** Decode the options-map Expr produced by parseCallArg into a plain object. */
function decodeOptions(arg: Expr | undefined, ctx: EvalContext): Record<string, RuntimeValue> {
  if (!arg) return {};
  if (arg.kind !== 'list')
    throw new AqlError('RUNTIME_ERROR', 'CALL options must be a map', arg.pos, ctx.source);
  const out: Record<string, RuntimeValue> = {};
  for (const entry of arg.items) {
    if (entry.kind !== 'list' || entry.items.length !== 2) continue;
    const key = entry.items[0]!;
    const keyName = key.kind === 'literal' ? String(key.value) : '';
    out[keyName] = evalExpr(entry.items[1]!, new Map(), ctx);
  }
  return out;
}

type AlgoRunner = (
  db: AtlasDatabase,
  o: Record<string, RuntimeValue>,
) => Promise<Record<string, RuntimeValue>[]>;

/** Maps spec §5.2 CALL names to db.algo, normalizing each result to YIELDable column maps. */
const ALGOS: Record<string, AlgoRunner> = {
  'algo.pagerank': async (db, o) =>
    (await db.algo.pagerank({ damping: num(o.damping), iterations: num(o.iterations) })).map(
      (r) => ({
        node: r.node,
        score: r.score,
      }),
    ),
  'algo.louvain': async (db, o) =>
    (await db.algo.louvain({ maxLevels: num(o.maxLevels) })).map((r) => ({
      node: r.node,
      community: r.community,
    })),
  'algo.components': async (db, o) =>
    (await db.algo.components({ mode: o.mode === 'strong' ? 'strong' : 'weak' })).map((r) => ({
      node: r.node,
      component: r.component,
    })),
  'algo.degree': async (db, o) =>
    (await db.algo.degree({ direction: dir(o.direction) })).map((r) => ({
      node: r.node,
      score: r.score,
    })),
  'algo.betweenness': async (db, o) =>
    (await db.algo.betweenness({ sampleK: num(o.sampleK) })).map((r) => ({
      node: r.node,
      score: r.score,
    })),
  'algo.shortestPath': async (db, o) => {
    const r = await db.algo.shortestPath({
      from: reqId(o.from),
      to: reqId(o.to),
      weightProp: str(o.weightProp),
    });
    return r === null ? [] : [{ path: r.path as unknown as RuntimeValue, cost: r.cost }];
  },
  'algo.allShortestPaths': async (db, o) =>
    (await db.algo.allShortestPaths({ from: reqId(o.from), to: reqId(o.to) })).map((r) => ({
      path: r.path as unknown as RuntimeValue,
      cost: r.cost,
    })),
  'algo.bfs': async (db, o) =>
    (await db.algo.bfs({ from: reqId(o.from), type: str(o.type), maxDepth: num(o.maxDepth) })).map(
      (r) => ({
        node: r.node,
        depth: r.depth,
      }),
    ),
  'algo.dfs': async (db, o) =>
    (await db.algo.dfs({ from: reqId(o.from), type: str(o.type), maxDepth: num(o.maxDepth) })).map(
      (r) => ({
        node: r.node,
        depth: r.depth,
      }),
    ),
  'algo.topoSort': async (db, o) =>
    (await db.algo.topoSort({ type: str(o.type) })).map((r) => ({ node: r.node, order: r.order })),
  'algo.cycles': async (db, o) =>
    (await db.algo.cycles({ type: str(o.type) })).map((r) => ({
      cycle: r.cycle as unknown as RuntimeValue,
    })),
};

function num(v: RuntimeValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function str(v: RuntimeValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function dir(v: RuntimeValue | undefined): 'out' | 'in' | 'both' | undefined {
  return v === 'out' || v === 'in' || v === 'both' ? v : undefined;
}
function reqId(v: RuntimeValue | undefined): number {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && 'id' in v) return (v as NodeRecord | EdgeRecord).id;
  throw new Error('expected a node id argument');
}

export async function runCall(
  stmt: CallStatement,
  db: AtlasDatabase,
  params: Record<string, unknown>,
): Promise<CallResult> {
  const runner = ALGOS[stmt.name];
  if (!runner)
    throw new AqlError('SEMANTIC_ERROR', `unknown procedure "${stmt.name}"`, stmt.pos, '');
  const ctx: EvalContext = { params, source: '' };
  const options = decodeOptions(stmt.args[0], ctx);
  let results: Record<string, RuntimeValue>[];
  try {
    results = await runner(db, options);
  } catch (e) {
    if (e instanceof AqlError) throw e;
    throw new AqlError('RUNTIME_ERROR', `${stmt.name}: ${(e as Error).message}`, stmt.pos, '');
  }
  const cols = stmt.yields.length > 0 ? stmt.yields : inferColumns(results);
  for (const y of cols)
    if (results.length > 0 && !(y.name in results[0]!))
      throw new AqlError(
        'SEMANTIC_ERROR',
        `procedure "${stmt.name}" does not yield "${y.name}"`,
        stmt.pos,
        '',
      );
  const columns = cols.map((y) => y.alias ?? y.name);
  const rows = results.map((r) => cols.map((y) => r[y.name] ?? null));
  return { columns, rows };
}

function inferColumns(results: Record<string, RuntimeValue>[]): { name: string; alias?: string }[] {
  return results.length === 0 ? [] : Object.keys(results[0]!).map((name) => ({ name }));
}
