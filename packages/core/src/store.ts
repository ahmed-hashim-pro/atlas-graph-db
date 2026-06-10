import { AtlasError } from './errors.js';
import { Interner } from './interner.js';
import type { CommittedBatch, EdgeId, EdgeRecord, NodeId, NodeRecord, Op } from './types.js';

type Adjacency = Map<NodeId, Map<number, Set<EdgeId>>>;

function bucket(adj: Adjacency, nodeId: NodeId, typeId: number): Set<EdgeId> {
  let byType = adj.get(nodeId);
  if (!byType) {
    byType = new Map();
    adj.set(nodeId, byType);
  }
  let set = byType.get(typeId);
  if (!set) {
    set = new Set();
    byType.set(typeId, set);
  }
  return set;
}

export class GraphStore {
  readonly nodes = new Map<NodeId, NodeRecord>();
  readonly edges = new Map<EdgeId, EdgeRecord>();
  readonly types = new Interner();
  private readonly outAdj: Adjacency = new Map();
  private readonly inAdj: Adjacency = new Map();

  applyBatch(batch: CommittedBatch): void {
    for (const op of batch.ops) this.applyOp(op);
  }

  applyOp(op: Op): void {
    switch (op.op) {
      case 'createNode': {
        if (this.nodes.has(op.id)) throw new AtlasError('INTERNAL', `node ${op.id} already exists`);
        this.nodes.set(op.id, { id: op.id, labels: [...op.labels], props: { ...op.props } });
        return;
      }
      case 'createEdge': {
        if (this.edges.has(op.id)) throw new AtlasError('INTERNAL', `edge ${op.id} already exists`);
        if (!this.nodes.has(op.from) || !this.nodes.has(op.to))
          throw new AtlasError('INTERNAL', `edge ${op.id} references missing node`);
        const typeId = this.types.intern(op.type);
        this.edges.set(op.id, {
          id: op.id,
          type: op.type,
          from: op.from,
          to: op.to,
          props: { ...op.props },
        });
        bucket(this.outAdj, op.from, typeId).add(op.id);
        bucket(this.inAdj, op.to, typeId).add(op.id);
        return;
      }
      case 'setNodeProps': {
        const n = this.nodes.get(op.id);
        if (!n) throw new AtlasError('INTERNAL', `node ${op.id} not found`);
        Object.assign(n.props, op.set);
        for (const k of op.remove) delete n.props[k];
        return;
      }
      case 'setEdgeProps': {
        const e = this.edges.get(op.id);
        if (!e) throw new AtlasError('INTERNAL', `edge ${op.id} not found`);
        Object.assign(e.props, op.set);
        for (const k of op.remove) delete e.props[k];
        return;
      }
      case 'deleteEdge': {
        const e = this.edges.get(op.id);
        if (!e) throw new AtlasError('INTERNAL', `edge ${op.id} not found`);
        const typeId = this.types.idOf(e.type);
        if (typeId !== undefined) {
          this.outAdj.get(e.from)?.get(typeId)?.delete(op.id);
          this.inAdj.get(e.to)?.get(typeId)?.delete(op.id);
        }
        this.edges.delete(op.id);
        return;
      }
      case 'deleteNode': {
        if (!this.nodes.has(op.id)) throw new AtlasError('INTERNAL', `node ${op.id} not found`);
        if (this.degree(op.id) > 0)
          throw new AtlasError(
            'INTERNAL',
            `node ${op.id} still has edges (batch not pre-validated?)`,
          );
        this.outAdj.delete(op.id);
        this.inAdj.delete(op.id);
        this.nodes.delete(op.id);
        return;
      }
    }
  }

  getNode(id: NodeId): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: EdgeId): EdgeRecord | undefined {
    return this.edges.get(id);
  }

  outEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.collect(this.outAdj, id, type);
  }

  inEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.collect(this.inAdj, id, type);
  }

  degree(id: NodeId): number {
    let n = 0;
    for (const set of this.outAdj.get(id)?.values() ?? []) n += set.size;
    for (const set of this.inAdj.get(id)?.values() ?? []) n += set.size;
    return n;
  }

  *nodesByLabel(label: string): IterableIterator<NodeRecord> {
    for (const n of this.nodes.values()) if (n.labels.includes(label)) yield n;
  }

  stats(): { nodeCount: number; edgeCount: number } {
    return { nodeCount: this.nodes.size, edgeCount: this.edges.size };
  }

  checkInvariants(): void {
    const seen = new Set<EdgeId>();
    for (const [adj, dir] of [
      [this.outAdj, 'out'],
      [this.inAdj, 'in'],
    ] as const) {
      for (const [nodeId, byType] of adj) {
        for (const [typeId, set] of byType) {
          for (const edgeId of set) {
            const e = this.edges.get(edgeId);
            if (!e)
              throw new AtlasError(
                'INTERNAL',
                `${dir}-adjacency references missing edge ${edgeId}`,
              );
            const endpoint = dir === 'out' ? e.from : e.to;
            if (endpoint !== nodeId || this.types.idOf(e.type) !== typeId)
              throw new AtlasError('INTERNAL', `adjacency mismatch for edge ${edgeId}`);
            if (dir === 'out') seen.add(edgeId);
          }
        }
      }
    }
    if (seen.size !== this.edges.size)
      throw new AtlasError(
        'INTERNAL',
        `adjacency covers ${seen.size} edges, store has ${this.edges.size}`,
      );
    for (const e of this.edges.values())
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to))
        throw new AtlasError('INTERNAL', `edge ${e.id} has dangling endpoint`);
  }

  private collect(adj: Adjacency, id: NodeId, type?: string): EdgeRecord[] {
    const byType = adj.get(id);
    if (!byType) return [];
    const out: EdgeRecord[] = [];
    if (type !== undefined) {
      const typeId = this.types.idOf(type);
      if (typeId === undefined) return [];
      for (const edgeId of byType.get(typeId) ?? []) out.push(this.edges.get(edgeId)!);
    } else {
      for (const set of byType.values())
        for (const edgeId of set) out.push(this.edges.get(edgeId)!);
    }
    return out;
  }
}
