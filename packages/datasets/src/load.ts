import type { DatasetGraph } from './science-history.js';

/**
 * Structural slice of @atlas/core's TxBuilder — datasets must not import core
 * (core dev-depends on datasets; the reverse import would cycle the
 * TypeScript project references).
 */
export interface TxLike {
  createNode(labels: string[], props?: Record<string, string | number>): number;
  createEdge(
    type: string,
    from: number,
    to: number,
    props?: Record<string, string | number>,
  ): number;
}

export interface DbLike {
  transact(fn: (tx: TxLike) => void): Promise<unknown>;
}

const NODES_PER_BATCH = 200;
const EDGES_PER_BATCH = 500;

/** Loads a dataset graph; returns assigned node ids positionally (ids[i] is nodes[i]). */
export async function loadDataset(db: DbLike, graph: DatasetGraph): Promise<number[]> {
  const ids = new Array<number>(graph.nodes.length);
  for (let i = 0; i < graph.nodes.length; i += NODES_PER_BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + NODES_PER_BATCH, graph.nodes.length); j++) {
        const n = graph.nodes[j]!;
        ids[j] = tx.createNode(n.labels, n.props);
      }
    });
  }
  for (let i = 0; i < graph.edges.length; i += EDGES_PER_BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + EDGES_PER_BATCH, graph.edges.length); j++) {
        const e = graph.edges[j]!;
        tx.createEdge(e.type, ids[e.from]!, ids[e.to]!, e.props);
      }
    });
  }
  return ids;
}
