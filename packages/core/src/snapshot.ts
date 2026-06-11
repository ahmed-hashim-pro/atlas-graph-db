import { decode, encode } from '@msgpack/msgpack';
import { AtlasError } from './errors.js';
import type { GraphStore } from './store.js';
import type { EdgeRecord, NodeRecord } from './types.js';

const MAGIC = Buffer.from('ATLS1');

export interface SnapshotData {
  lastTxId: number;
  nextNodeId: number;
  nextEdgeId: number;
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

export function encodeSnapshot(
  store: GraphStore,
  lastTxId: number,
  counters: { nodeNext: number; edgeNext: number },
): Buffer {
  const data: SnapshotData = {
    lastTxId,
    nextNodeId: counters.nodeNext,
    nextEdgeId: counters.edgeNext,
    nodes: [...store.nodes.values()],
    edges: [...store.edges.values()],
  };
  return Buffer.concat([MAGIC, encode(data)]);
}

export function decodeSnapshot(buf: Buffer): SnapshotData {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC))
    throw new AtlasError('INTERNAL', 'snapshot magic header mismatch');
  return decode(buf.subarray(MAGIC.length)) as SnapshotData;
}
