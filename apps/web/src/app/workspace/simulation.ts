import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  /** Fixed coordinates (a pinned node); d3-force pins a node when fx/fy are set. */
  fx?: number | null;
  fy?: number | null;
}
export interface SimEdge {
  source: string;
  target: string;
}
export interface SimGraph {
  nodes: SimNode[];
  edges: SimEdge[];
}
export interface SimOptions {
  ticks?: number;
  seed?: number;
}
export type Positions = Map<string, { x: number; y: number }>;

/**
 * Deterministic mulberry32 PRNG — d3-force calls the injected RNG for initial placement + jitter.
 * Note: the `seed` makes ticks deterministic (stable tests), but it does NOT vary the layout for
 * normal graphs: d3-force lays nodes on a fixed phyllotaxis spiral and only consults the RNG to
 * jitter coincident nodes (x===0), which never happens here. The seed is meaningful only for that
 * coincident-node jitter; treat it as a determinism knob, not a layout-variation knob.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(graph: SimGraph, seed: number): Simulation<SimNode, undefined> {
  // d3-force mutates node objects; clone so the caller's data is untouched.
  const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
  const links: SimulationLinkDatum<SimNode>[] = graph.edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));
  const sim = forceSimulation<SimNode>(nodes)
    .force('charge', forceManyBody().strength(-120))
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(40),
    )
    .force('center', forceCenter(0, 0))
    .randomSource(mulberry32(seed))
    .stop();
  return sim;
}

function snapshot(sim: Simulation<SimNode, undefined>): Positions {
  const out: Positions = new Map();
  for (const n of sim.nodes()) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return out;
}

/** Run a fixed number of ticks synchronously and return final positions (used in tests + the worker). */
export function runSimulation(graph: SimGraph, opts: SimOptions = {}): Positions {
  const sim = build(graph, opts.seed ?? 1);
  const ticks = opts.ticks ?? 100;
  for (let i = 0; i < ticks; i++) sim.tick();
  const positions = snapshot(sim);
  // Pinned nodes report their fixed coordinates exactly.
  for (const n of graph.nodes)
    if (n.fx != null && n.fy != null) positions.set(n.id, { x: n.fx, y: n.fy });
  return positions;
}

export interface RunningSimulation {
  tick(): Positions;
  setPin(id: string, x: number | null, y: number | null): void;
  stop(): void;
}

/** A streaming simulation: call `tick()` per animation frame; `setPin` fixes/frees a node. */
export function createSimulation(graph: SimGraph, opts: SimOptions = {}): RunningSimulation {
  const sim = build(graph, opts.seed ?? 1);
  return {
    tick: () => {
      sim.tick();
      return snapshot(sim);
    },
    setPin: (id, x, y) => {
      const node = sim.nodes().find((n) => n.id === id);
      if (node) {
        node.fx = x;
        node.fy = y;
      }
      sim.alpha(0.3); // reheat so neighbors settle around the new pin on subsequent ticks
    },
    stop: () => sim.stop(),
  };
}
