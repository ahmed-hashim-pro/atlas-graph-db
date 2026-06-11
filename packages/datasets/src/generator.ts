import { mulberry32 } from './random.js';

export interface GeneratorOptions {
  nodes: number;
  edges: number;
  seed?: number;
  labels?: string[];
  edgeTypes?: string[];
}

export interface GenNode {
  labels: string[];
  props: { name: string; weight: number };
}

export interface GenEdge {
  from: number;
  to: number;
  type: string;
  props: { weight: number };
}

export interface GeneratedGraph {
  nodes: GenNode[];
  edges: GenEdge[];
}

export function generateGraph(opts: GeneratorOptions): GeneratedGraph {
  const { nodes, edges, seed = 42, labels = ['Entity'], edgeTypes = ['LINKS'] } = opts;
  if (nodes < 1) throw new RangeError('nodes must be >= 1');
  if (edges < 0) throw new RangeError('edges must be >= 0');
  const rand = mulberry32(seed);

  const genNodes: GenNode[] = Array.from({ length: nodes }, (_, i) => ({
    labels: [labels[i % labels.length]!],
    props: { name: `n${i}`, weight: rand() },
  }));

  const genEdges: GenEdge[] = Array.from({ length: edges }, (_, i) => ({
    // Squaring the sample skews sources toward low indices → hub nodes emerge.
    from: Math.floor(rand() ** 2 * nodes),
    to: Math.floor(rand() * nodes),
    type: edgeTypes[i % edgeTypes.length]!,
    props: { weight: rand() },
  }));

  return { nodes: genNodes, edges: genEdges };
}
