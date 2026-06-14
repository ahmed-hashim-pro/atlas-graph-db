import type { AlgorithmPaint } from './workspace-graph-store.contract';

export type ParamType = 'number' | 'string' | 'nodeId' | 'enum';

export interface AlgorithmParam {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  default?: number | string;
  /** For `enum` params. */
  options?: string[];
}

/** How an algorithm's YIELD rows map to canvas styling. */
export type PaintKind = 'score' | 'community' | 'component' | 'path' | 'none';

export interface AlgorithmSpec {
  name: string; // e.g. 'algo.pagerank'
  label: string; // human title
  params: AlgorithmParam[];
  yields: string[]; // YIELD column names (verified against packages/query/src/call.ts)
  paint: PaintKind;
}

/** v1 algorithm set with parameters + defaults pinned to spec §5.2. */
export const ALGORITHMS: readonly AlgorithmSpec[] = [
  {
    name: 'algo.pagerank',
    label: 'PageRank',
    params: [
      { key: 'damping', label: 'Damping', type: 'number', default: 0.85 },
      { key: 'iterations', label: 'Iterations', type: 'number', default: 20 },
    ],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.louvain',
    label: 'Louvain communities',
    params: [{ key: 'maxLevels', label: 'Max levels', type: 'number', default: 10 }],
    yields: ['node', 'community'],
    paint: 'community',
  },
  {
    name: 'algo.components',
    label: 'Connected components',
    params: [{ key: 'mode', label: 'Mode', type: 'enum', options: ['weak', 'strong'], default: 'weak' }],
    yields: ['node', 'component'],
    paint: 'component',
  },
  {
    name: 'algo.degree',
    label: 'Degree centrality',
    params: [{ key: 'direction', label: 'Direction', type: 'enum', options: ['both', 'out', 'in'], default: 'both' }],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.betweenness',
    label: 'Betweenness centrality',
    params: [{ key: 'sampleK', label: 'Sample K (optional)', type: 'number' }],
    yields: ['node', 'score'],
    paint: 'score',
  },
  {
    name: 'algo.shortestPath',
    label: 'Shortest path',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'to', label: 'To node id', type: 'nodeId', required: true },
      { key: 'weightProp', label: 'Weight property (optional)', type: 'string' },
    ],
    yields: ['path', 'cost'],
    paint: 'path',
  },
  {
    name: 'algo.allShortestPaths',
    label: 'All shortest paths',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'to', label: 'To node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
    ],
    yields: ['path', 'cost'],
    paint: 'path',
  },
  {
    name: 'algo.bfs',
    label: 'Breadth-first search',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
      { key: 'maxDepth', label: 'Max depth (optional)', type: 'number' },
    ],
    yields: ['node', 'depth'],
    paint: 'score',
  },
  {
    name: 'algo.dfs',
    label: 'Depth-first search',
    params: [
      { key: 'from', label: 'From node id', type: 'nodeId', required: true },
      { key: 'type', label: 'Edge type (optional)', type: 'string' },
      { key: 'maxDepth', label: 'Max depth (optional)', type: 'number' },
    ],
    yields: ['node', 'depth'],
    paint: 'score',
  },
  {
    name: 'algo.topoSort',
    label: 'Topological sort',
    params: [{ key: 'type', label: 'Edge type (optional)', type: 'string' }],
    yields: ['node', 'order'],
    paint: 'score',
  },
  {
    name: 'algo.cycles',
    label: 'Cycle detection',
    params: [{ key: 'type', label: 'Edge type (optional)', type: 'string' }],
    yields: ['cycle'],
    paint: 'path',
  },
];

export function findAlgorithm(name: string): AlgorithmSpec | undefined {
  return ALGORITHMS.find((a) => a.name === name);
}

export interface BuiltCall {
  query: string;
  params: Record<string, number | string>;
}

/** Whether a form value should be included (skip blanks for optional params). */
function isSet(v: number | string | undefined): v is number | string {
  return v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
}

/**
 * Build an injection-safe `CALL algo.<name>({k: $k, …}) YIELD … RETURN …` string.
 * Every literal flows through `$params`, never string interpolation.
 */
export function buildAlgorithmCall(spec: AlgorithmSpec, values: Record<string, number | string>): BuiltCall {
  const params: Record<string, number | string> = {};
  const entries: string[] = [];
  for (const p of spec.params) {
    const v = values[p.key];
    if (isSet(v)) {
      params[p.key] = v;
      entries.push(`${p.key}: $${p.key}`);
    }
  }
  const optionsMap = entries.length > 0 ? `{${entries.join(', ')}}` : '';
  const yields = spec.yields.join(', ');
  return {
    query: `CALL ${spec.name}(${optionsMap}) YIELD ${yields} RETURN ${yields}`,
    params,
  };
}

interface PathLike {
  nodes: number[];
  edges: number[];
}

function isPathLike(v: unknown): v is PathLike {
  return typeof v === 'object' && v !== null && Array.isArray((v as PathLike).nodes);
}

/**
 * Map YIELD rows to canvas styling (§7.2): node size from score, color from
 * community/component, highlighted node sequences from path/cycle results.
 */
export function paintFromRows(spec: AlgorithmSpec, columns: string[], rows: unknown[][]): AlgorithmPaint {
  const scores = new Map<number, number>();
  const communities = new Map<number, number>();
  const paths: number[][] = [];
  const nodeIdx = columns.indexOf('node');
  const valueCol = spec.paint === 'community' ? 'community' : spec.paint === 'component' ? 'component' : 'score';
  const valueIdx = spec.yields.includes(valueCol) ? columns.indexOf(valueCol) : columns.indexOf('depth');

  for (const row of rows) {
    if (spec.paint === 'path') {
      const cell = row[columns.indexOf(spec.yields[0]!)];
      if (isPathLike(cell)) paths.push(cell.nodes);
      continue;
    }
    if (nodeIdx === -1) continue;
    const id = row[nodeIdx];
    if (typeof id !== 'number') continue;
    const value = valueIdx === -1 ? 0 : row[valueIdx];
    if (typeof value !== 'number') continue;
    if (spec.paint === 'community' || spec.paint === 'component') communities.set(id, value);
    else scores.set(id, value);
  }
  return { scores, communities, paths };
}
