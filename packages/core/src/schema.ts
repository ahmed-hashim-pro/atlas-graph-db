import { AtlasError } from './errors.js';
import type { GraphStore } from './store.js';
import type { Op, PropertyValue } from './types.js';

export interface SchemaSummary {
  labels: {
    label: string;
    count: number;
    properties: { property: string; types: Record<string, number> }[];
  }[];
  edgeTypes: {
    type: string;
    count: number;
    from: Record<string, number>;
    to: Record<string, number>;
  }[];
}

export function propTypeName(v: PropertyValue): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return 'array';
    return `${propTypeName(v[0]!)}[]`;
  }
  if (v instanceof Date) return 'datetime';
  return typeof v; // string | number | boolean
}

class Counter<K> {
  readonly map = new Map<K, number>();

  inc(k: K): void {
    this.map.set(k, (this.map.get(k) ?? 0) + 1);
  }

  dec(k: K): void {
    const n = this.map.get(k);
    if (n === undefined) return;
    if (n <= 1) this.map.delete(k);
    else this.map.set(k, n - 1);
  }

  toRecord(this: Counter<string>): Record<string, number> {
    return Object.fromEntries(this.map);
  }
}

interface LabelStats {
  count: number;
  /** property -> typeName -> count of nodes carrying that (property, type). */
  properties: Map<string, Counter<string>>;
}

interface EdgeTypeStats {
  count: number;
  from: Counter<string>;
  to: Counter<string>;
}

/**
 * Incrementally maintained observed schema. beforeApply MUST run before the
 * store mutates (old values still readable) — same contract as IndexRegistry.
 */
export class SchemaTracker {
  private readonly labels = new Map<string, LabelStats>();
  private readonly edgeTypes = new Map<string, EdgeTypeStats>();

  beforeApply(op: Op, store: GraphStore): void {
    switch (op.op) {
      case 'createNode': {
        for (const label of op.labels) {
          const stats = this.labelStats(label);
          stats.count++;
          for (const [prop, v] of Object.entries(op.props))
            this.propCounter(stats, prop).inc(propTypeName(v));
        }
        return;
      }
      case 'setNodeProps': {
        const n = store.getNode(op.id);
        if (!n) return;
        for (const label of n.labels) {
          const stats = this.labels.get(label);
          if (!stats) continue;
          const touched = new Set([...Object.keys(op.set), ...op.remove]);
          for (const prop of touched) {
            const oldV = n.props[prop];
            if (oldV !== undefined) {
              const c = stats.properties.get(prop);
              c?.dec(propTypeName(oldV));
              if (c && c.map.size === 0) stats.properties.delete(prop);
            }
            const newV = op.remove.includes(prop) ? undefined : op.set[prop];
            if (newV !== undefined) this.propCounter(stats, prop).inc(propTypeName(newV));
          }
        }
        return;
      }
      case 'deleteNode': {
        const n = store.getNode(op.id);
        if (!n) return;
        for (const label of n.labels) {
          const stats = this.labels.get(label);
          if (!stats) continue;
          stats.count--;
          for (const [prop, v] of Object.entries(n.props)) {
            const c = stats.properties.get(prop);
            c?.dec(propTypeName(v));
            if (c && c.map.size === 0) stats.properties.delete(prop);
          }
          if (stats.count === 0) this.labels.delete(label);
        }
        return;
      }
      case 'createEdge': {
        const stats = this.edgeTypeStats(op.type);
        stats.count++;
        for (const label of store.getNode(op.from)?.labels ?? []) stats.from.inc(label);
        for (const label of store.getNode(op.to)?.labels ?? []) stats.to.inc(label);
        return;
      }
      case 'deleteEdge': {
        const e = store.getEdge(op.id);
        if (!e) return;
        const stats = this.edgeTypes.get(e.type);
        if (!stats) return;
        stats.count--;
        for (const label of store.getNode(e.from)?.labels ?? []) stats.from.dec(label);
        for (const label of store.getNode(e.to)?.labels ?? []) stats.to.dec(label);
        if (stats.count === 0) this.edgeTypes.delete(e.type);
        return;
      }
      default:
        return; // index DDL and edge prop changes do not affect the schema
    }
  }

  summary(): SchemaSummary {
    return {
      labels: [...this.labels.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([label, s]) => ({
          label,
          count: s.count,
          properties: [...s.properties.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([property, types]) => ({ property, types: types.toRecord() })),
        })),
      edgeTypes: [...this.edgeTypes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([type, s]) => ({
          type,
          count: s.count,
          from: s.from.toRecord(),
          to: s.to.toRecord(),
        })),
    };
  }

  /**
   * Rebuild-and-compare deep check: replaying the store's current contents
   * through a fresh tracker must reproduce this tracker's summary exactly.
   */
  checkInvariants(store: GraphStore): void {
    const fresh = new SchemaTracker();
    for (const n of store.nodes.values())
      fresh.beforeApply({ op: 'createNode', id: n.id, labels: n.labels, props: n.props }, store);
    for (const e of store.edges.values())
      fresh.beforeApply(
        { op: 'createEdge', id: e.id, type: e.type, from: e.from, to: e.to, props: e.props },
        store,
      );
    const live = JSON.stringify(this.summary());
    const want = JSON.stringify(fresh.summary());
    if (live !== want)
      throw new AtlasError('INTERNAL', `schema counters diverge from store contents: ${live} != ${want}`);
  }

  private labelStats(label: string): LabelStats {
    let s = this.labels.get(label);
    if (!s) {
      s = { count: 0, properties: new Map() };
      this.labels.set(label, s);
    }
    return s;
  }

  private propCounter(stats: LabelStats, prop: string): Counter<string> {
    let c = stats.properties.get(prop);
    if (!c) {
      c = new Counter<string>();
      stats.properties.set(prop, c);
    }
    return c;
  }

  private edgeTypeStats(type: string): EdgeTypeStats {
    let s = this.edgeTypes.get(type);
    if (!s) {
      s = { count: 0, from: new Counter<string>(), to: new Counter<string>() };
      this.edgeTypes.set(type, s);
    }
    return s;
  }
}
