import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { SchemaSummary } from '@atlas/core';
import { AQL_FUNCTIONS, AQL_KEYWORDS } from './aql-language';

/** §5.2 algorithm procedures offered after `CALL` / `algo.`. */
export const ALGO_PROCEDURES: readonly string[] = [
  'algo.shortestPath', 'algo.allShortestPaths', 'algo.pagerank', 'algo.louvain',
  'algo.components', 'algo.degree', 'algo.betweenness', 'algo.bfs', 'algo.dfs',
  'algo.topoSort', 'algo.cycles',
];

export interface AqlCompletion {
  label: string;
  type: 'label' | 'edge' | 'property' | 'keyword' | 'function' | 'procedure';
  /** Replacement text (defaults to label). */
  apply?: string;
}

/** All distinct property names across the schema (autocomplete after `ident.`). */
function allProperties(schema: SchemaSummary): string[] {
  const set = new Set<string>();
  for (const l of schema.labels) for (const p of l.properties) set.add(p.property);
  return [...set].sort();
}

/**
 * Pure completion engine: given the schema, the full source, and the cursor
 * offset, return context-appropriate completions. Exported for unit tests; the
 * CodeMirror source adapter (below) calls this.
 */
export function computeCompletions(schema: SchemaSummary, source: string, cursor: number): AqlCompletion[] {
  const before = source.slice(0, cursor);

  // `[:` or `[: PARTIAL` → edge types.
  const edgeMatch = /\[:([A-Za-z0-9_]*)$/.exec(before);
  if (edgeMatch) {
    const prefix = edgeMatch[1]!.toUpperCase();
    return schema.edgeTypes
      .filter((e) => e.type.toUpperCase().startsWith(prefix))
      .map((e) => ({ label: `:${e.type}`, type: 'edge' as const, apply: `:${e.type}` }));
  }

  // `:` or `:PARTIAL` (not preceded by `[`) → labels.
  const labelMatch = /(?<!\[):([A-Za-z0-9_]*)$/.exec(before);
  if (labelMatch) {
    const prefix = labelMatch[1]!.toLowerCase();
    return schema.labels
      .filter((l) => l.label.toLowerCase().startsWith(prefix))
      .map((l) => ({ label: `:${l.label}`, type: 'label' as const, apply: `:${l.label}` }));
  }

  // `algo.PARTIAL` → procedures.
  const algoMatch = /algo\.([A-Za-z]*)$/.exec(before);
  if (algoMatch) {
    const prefix = algoMatch[1]!.toLowerCase();
    return ALGO_PROCEDURES.filter((p) => p.slice('algo.'.length).toLowerCase().startsWith(prefix)).map((p) => ({
      label: p,
      type: 'procedure' as const,
      apply: p,
    }));
  }

  // `ident.PARTIAL` → property names.
  const propMatch = /[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z0-9_]*)$/.exec(before);
  if (propMatch) {
    const prefix = propMatch[1]!.toLowerCase();
    return allProperties(schema)
      .filter((p) => p.toLowerCase().startsWith(prefix))
      .map((p) => ({ label: p, type: 'property' as const }));
  }

  // Bare word → keywords + functions, filtered by the current word prefix.
  const wordMatch = /([A-Za-z]+)$/.exec(before);
  const prefix = (wordMatch?.[1] ?? '').toLowerCase();
  const out: AqlCompletion[] = [];
  for (const k of AQL_KEYWORDS)
    if (k.toLowerCase().startsWith(prefix)) out.push({ label: k, type: 'keyword' });
  for (const f of AQL_FUNCTIONS)
    if (f.toLowerCase().startsWith(prefix)) out.push({ label: f, type: 'function' });
  return out;
}

/** Adapt the pure engine to a CodeMirror CompletionSource backed by a live-schema getter. */
export function makeAqlCompletionSource(getSchema: () => SchemaSummary | null): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (!schema) return null;
    const items = computeCompletions(schema, ctx.state.doc.toString(), ctx.pos);
    if (items.length === 0) return null;
    // Where does the replaced token start? Match the trailing token CodeMirror sees.
    const word = ctx.matchBefore(/[:.\[A-Za-z0-9_]*$/);
    const from = word ? word.from : ctx.pos;
    const options: Completion[] = items.map((c) => ({ label: c.label, type: cmType(c.type), apply: c.apply }));
    return { from, options, validFor: /[:.\[A-Za-z0-9_]*$/ };
  };
}

function cmType(type: AqlCompletion['type']): string {
  switch (type) {
    case 'label':
      return 'class';
    case 'edge':
      return 'type';
    case 'property':
      return 'property';
    case 'procedure':
      return 'function';
    case 'function':
      return 'function';
    case 'keyword':
      return 'keyword';
  }
}
