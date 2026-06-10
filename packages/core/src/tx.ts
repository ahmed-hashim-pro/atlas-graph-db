import { AtlasError } from './errors.js';
import type { IdAllocator } from './id-allocator.js';
import type { GraphStore } from './store.js';
import { validateProps } from './types.js';
import type { EdgeId, NodeId, Op, Props } from './types.js';

interface TxEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
}

export class TxBuilder {
  private readonly ops: Op[] = [];
  private readonly createdNodes = new Set<NodeId>();
  private readonly createdEdges = new Set<EdgeId>();
  private readonly deletedNodes = new Set<NodeId>();
  private readonly deletedEdges = new Set<EdgeId>();
  private readonly txEdges: TxEdge[] = [];

  constructor(
    private readonly store: GraphStore,
    private readonly ids: IdAllocator,
  ) {}

  createNode(labels: string[], props: Props = {}): NodeId {
    if (labels.length === 0 || labels.some((l) => l.length === 0))
      throw new AtlasError('VALIDATION', 'node needs at least one non-empty label');
    validateProps(props);
    const id = this.ids.nextNode();
    this.ops.push({ op: 'createNode', id, labels, props });
    this.createdNodes.add(id);
    return id;
  }

  createEdge(type: string, from: NodeId, to: NodeId, props: Props = {}): EdgeId {
    if (type.length === 0) throw new AtlasError('VALIDATION', 'edge type must not be empty');
    this.requireNode(from);
    this.requireNode(to);
    validateProps(props);
    const id = this.ids.nextEdge();
    this.ops.push({ op: 'createEdge', id, type, from, to, props });
    this.createdEdges.add(id);
    this.txEdges.push({ id, from, to });
    return id;
  }

  setNodeProps(id: NodeId, set: Props, remove: string[] = []): void {
    this.requireNode(id);
    validateProps(set);
    this.ops.push({ op: 'setNodeProps', id, set, remove });
  }

  setEdgeProps(id: EdgeId, set: Props, remove: string[] = []): void {
    this.requireEdge(id);
    validateProps(set);
    this.ops.push({ op: 'setEdgeProps', id, set, remove });
  }

  deleteEdge(id: EdgeId): void {
    this.requireEdge(id);
    this.ops.push({ op: 'deleteEdge', id });
    this.deletedEdges.add(id);
  }

  deleteNode(id: NodeId, opts: { detach?: boolean } = {}): void {
    this.requireNode(id);
    const incident = new Set<EdgeId>();
    for (const e of [...this.store.outEdges(id), ...this.store.inEdges(id)])
      if (!this.deletedEdges.has(e.id)) incident.add(e.id);
    for (const e of this.txEdges)
      if ((e.from === id || e.to === id) && !this.deletedEdges.has(e.id)) incident.add(e.id);
    if (incident.size > 0) {
      if (!opts.detach)
        throw new AtlasError(
          'VALIDATION',
          `node ${id} has ${incident.size} edge(s); pass { detach: true }`,
        );
      for (const edgeId of incident) {
        this.ops.push({ op: 'deleteEdge', id: edgeId });
        this.deletedEdges.add(edgeId);
      }
    }
    this.ops.push({ op: 'deleteNode', id });
    this.deletedNodes.add(id);
  }

  build(): Op[] {
    return this.ops;
  }

  private requireNode(id: NodeId): void {
    const visible =
      (this.createdNodes.has(id) || this.store.nodes.has(id)) && !this.deletedNodes.has(id);
    if (!visible) throw new AtlasError('NOT_FOUND', `node ${id} not found in transaction view`);
  }

  private requireEdge(id: EdgeId): void {
    const visible =
      (this.createdEdges.has(id) || this.store.edges.has(id)) && !this.deletedEdges.has(id);
    if (!visible) throw new AtlasError('NOT_FOUND', `edge ${id} not found in transaction view`);
  }
}
