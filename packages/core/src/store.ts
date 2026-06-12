import { AtlasError } from './errors.js';
import { IndexRegistry } from './index/registry.js';
import { Interner } from './interner.js';
import { SchemaTracker } from './schema.js';
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

/** Remove an edge from an adjacency bucket, pruning empty Sets/Maps so churn does not leak memory. */
function unlink(adj: Adjacency, nodeId: NodeId, typeId: number, edgeId: EdgeId): void {
  const byType = adj.get(nodeId);
  const set = byType?.get(typeId);
  if (!byType || !set) return;
  set.delete(edgeId);
  if (set.size === 0) byType.delete(typeId);
  if (byType.size === 0) adj.delete(nodeId);
}

const EMPTY_IDS: ReadonlySet<NodeId> = new Set();

export class GraphStore {
  readonly nodes = new Map<NodeId, NodeRecord>();
  readonly edges = new Map<EdgeId, EdgeRecord>();
  readonly types = new Interner();
  readonly indexes = new IndexRegistry();
  readonly schema = new SchemaTracker();
  private readonly outAdj: Adjacency = new Map();
  private readonly inAdj: Adjacency = new Map();
  private readonly byLabel = new Map<string, Set<NodeId>>();

  applyBatch(batch: CommittedBatch): void {
    for (const op of batch.ops) this.applyOp(op);
  }

  /**
   * Apply a single op to the store.
   *
   * Prop copies are shallow: array PropertyValues are shared with `op`, and records returned by
   * getNode/getEdge/outEdges/inEdges are live. Callers must not mutate an op (or its arrays) after
   * passing it to applyOp, nor mutate returned records. In the real pipeline ops always arrive as
   * fresh objects (WAL decode / tx builder), so no defensive deep copy is performed here.
   */
  applyOp(op: Op): void {
    this.indexes.beforeApply(op, this);
    this.schema.beforeApply(op, this);
    switch (op.op) {
      case 'createNode': {
        if (this.nodes.has(op.id)) throw new AtlasError('INTERNAL', `node ${op.id} already exists`);
        this.nodes.set(op.id, { id: op.id, labels: [...op.labels], props: { ...op.props } });
        for (const label of op.labels) {
          let set = this.byLabel.get(label);
          if (!set) {
            set = new Set();
            this.byLabel.set(label, set);
          }
          set.add(op.id);
        }
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
        if (typeId === undefined)
          throw new AtlasError('INTERNAL', `type ${e.type} not interned for edge ${op.id}`);
        unlink(this.outAdj, e.from, typeId, op.id);
        unlink(this.inAdj, e.to, typeId, op.id);
        this.edges.delete(op.id);
        return;
      }
      case 'deleteNode': {
        const n = this.nodes.get(op.id);
        if (!n) throw new AtlasError('INTERNAL', `node ${op.id} not found`);
        if (this.degree(op.id) > 0)
          throw new AtlasError(
            'INTERNAL',
            `node ${op.id} still has edges (batch not pre-validated?)`,
          );
        for (const label of n.labels) {
          const set = this.byLabel.get(label);
          set?.delete(op.id);
          if (set?.size === 0) this.byLabel.delete(label);
        }
        this.outAdj.delete(op.id);
        this.inAdj.delete(op.id);
        this.nodes.delete(op.id);
        return;
      }
      case 'createIndex': {
        this.indexes.create(op.def, this);
        return;
      }
      case 'dropIndex': {
        this.indexes.drop(op.def);
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
    for (const id of this.byLabel.get(label) ?? []) yield this.nodes.get(id)!;
  }

  /** Live id set for a label — do not mutate. Internal accelerator for traversals/backfill. */
  nodeIdsByLabel(label: string): ReadonlySet<NodeId> {
    return this.byLabel.get(label) ?? EMPTY_IDS;
  }

  labelCount(label: string): number {
    return this.byLabel.get(label)?.size ?? 0;
  }

  stats(): { nodeCount: number; edgeCount: number } {
    return { nodeCount: this.nodes.size, edgeCount: this.edges.size };
  }

  checkInvariants(): void {
    const seen = { out: new Set<EdgeId>(), in: new Set<EdgeId>() };
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
            seen[dir].add(edgeId);
          }
        }
      }
    }
    for (const dir of ['out', 'in'] as const)
      if (seen[dir].size !== this.edges.size)
        throw new AtlasError(
          'INTERNAL',
          `${dir}-adjacency covers ${seen[dir].size} edges, store has ${this.edges.size}`,
        );
    let labelRefs = 0;
    for (const [label, set] of this.byLabel) {
      for (const id of set) {
        const n = this.nodes.get(id);
        if (!n || !n.labels.includes(label))
          throw new AtlasError('INTERNAL', `label index entry ${label}->${id} is stale`);
        labelRefs++;
      }
    }
    let expectedRefs = 0;
    // Count distinct labels: byLabel holds each node at most once per label, so a record with
    // duplicate labels (e.g. ['A', 'A'], reachable via applyOp) must not trip a phantom mismatch.
    for (const n of this.nodes.values()) expectedRefs += new Set(n.labels).size;
    if (labelRefs !== expectedRefs)
      throw new AtlasError(
        'INTERNAL',
        `label index has ${labelRefs} refs, expected ${expectedRefs}`,
      );
    for (const e of this.edges.values())
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to))
        throw new AtlasError('INTERNAL', `edge ${e.id} has dangling endpoint`);
    this.indexes.checkInvariants(this);
    this.schema.checkInvariants(this);
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
