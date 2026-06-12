import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { IndexDef, NodeId, Op, Props } from '../types.js';
import { FulltextIndex } from './fulltext.js';
import { encodeKey, isScalar, type ScalarValue } from './keys.js';
import { PropertyIndex, type RangeQuery } from './property-index.js';

export function indexDefKey(def: IndexDef): string {
  return `${def.kind}:${def.label}:${def.property}`;
}

interface Entry {
  def: IndexDef;
  property?: PropertyIndex; // kinds 'property' and 'unique'
  fulltext?: FulltextIndex; // kind 'fulltext'
}

export class IndexRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byLabel = new Map<string, Entry[]>();

  defs(): IndexDef[] {
    return [...this.entries.values()].map((e) => ({ ...e.def }));
  }

  has(def: IndexDef): boolean {
    return this.entries.has(indexDefKey(def));
  }

  /** Create + synchronous backfill. Routed from GraphStore.applyOp('createIndex'). */
  create(def: IndexDef, store: GraphStore): void {
    if (this.has(def)) throw new AtlasError('INTERNAL', `index ${indexDefKey(def)} already exists`);
    const entry: Entry = { def };
    if (def.kind === 'fulltext') entry.fulltext = new FulltextIndex();
    else entry.property = new PropertyIndex();
    if (def.kind === 'unique') {
      const seen = new Map<string, NodeId>();
      for (const n of store.nodesByLabel(def.label)) {
        const v = n.props[def.property];
        if (v === undefined || !isScalar(v)) continue;
        const k = encodeKey(v);
        const prev = seen.get(k);
        if (prev !== undefined)
          throw new AtlasError(
            'CONSTRAINT_VIOLATION',
            `unique ${def.label}.${def.property}: nodes ${prev} and ${n.id} share a value`,
          );
        seen.set(k, n.id);
      }
    }
    for (const n of store.nodesByLabel(def.label)) {
      const v = n.props[def.property];
      if (v === undefined) continue;
      entry.property?.add(v, n.id);
      entry.fulltext?.add(v, n.id);
    }
    this.entries.set(indexDefKey(def), entry);
    let list = this.byLabel.get(def.label);
    if (!list) {
      list = [];
      this.byLabel.set(def.label, list);
    }
    list.push(entry);
  }

  /** Routed from GraphStore.applyOp('dropIndex'). */
  drop(def: IndexDef): void {
    const key = indexDefKey(def);
    const entry = this.entries.get(key);
    if (!entry) throw new AtlasError('INTERNAL', `index ${key} does not exist`);
    this.entries.delete(key);
    const list = this.byLabel.get(def.label)!;
    list.splice(list.indexOf(entry), 1);
    if (list.length === 0) this.byLabel.delete(def.label);
  }

  /**
   * Posting maintenance. MUST run before the store mutates: setNodeProps and
   * deleteNode read the node's old values. Edge ops are no-ops (node indexes
   * only in v1).
   */
  beforeApply(op: Op, store: GraphStore): void {
    switch (op.op) {
      case 'createNode': {
        for (const label of op.labels) {
          for (const e of this.byLabel.get(label) ?? []) {
            const v = op.props[e.def.property];
            if (v === undefined) continue;
            e.property?.add(v, op.id);
            e.fulltext?.add(v, op.id);
          }
        }
        return;
      }
      case 'setNodeProps': {
        const n = store.getNode(op.id);
        if (!n) return; // the store will throw INTERNAL right after
        for (const label of n.labels) {
          for (const e of this.byLabel.get(label) ?? []) {
            const prop = e.def.property;
            if (!(prop in op.set) && !op.remove.includes(prop)) continue;
            const oldV = n.props[prop];
            if (oldV !== undefined) {
              e.property?.remove(oldV, op.id);
              e.fulltext?.remove(oldV, op.id);
            }
            // applyOp assigns `set` then deletes `remove`, so remove wins on overlap.
            const newV = op.remove.includes(prop) ? undefined : op.set[prop];
            if (newV !== undefined) {
              e.property?.add(newV, op.id);
              e.fulltext?.add(newV, op.id);
            }
          }
        }
        return;
      }
      case 'deleteNode': {
        const n = store.getNode(op.id);
        if (!n) return;
        for (const label of n.labels) {
          for (const e of this.byLabel.get(label) ?? []) {
            const v = n.props[e.def.property];
            if (v !== undefined) {
              e.property?.remove(v, op.id);
              e.fulltext?.remove(v, op.id);
            }
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** undefined = no scalar index on (label, property). Empty set = indexed, no match. */
  lookupExact(
    label: string,
    property: string,
    value: ScalarValue,
  ): ReadonlySet<NodeId> | undefined {
    const ix = this.scalarIndex(label, property);
    if (!ix) return undefined;
    return ix.getExact(value) ?? new Set();
  }

  /**
   * Throws NOT_FOUND when no scalar index exists — range scans never fall back
   * to table scans silently. Message must stay in sync with the exact-path
   * throw in GraphView.nodesWhere (traversal.ts).
   */
  lookupRange(label: string, property: string, q: RangeQuery): IterableIterator<NodeId> {
    const ix = this.scalarIndex(label, property);
    if (!ix) throw new AtlasError('NOT_FOUND', `no property index on ${label}.${property}`);
    return ix.getRange(q);
  }

  /** undefined = no fulltext index on (label, property). */
  searchText(
    label: string,
    property: string,
    query: string,
    opts: { prefix?: boolean } = {},
  ): Set<NodeId> | undefined {
    const e = this.entries.get(indexDefKey({ kind: 'fulltext', label, property }));
    return e?.fulltext?.search(query, opts);
  }

  uniqueEntries(): { def: IndexDef; index: PropertyIndex }[] {
    const out: { def: IndexDef; index: PropertyIndex }[] = [];
    for (const e of this.entries.values())
      if (e.def.kind === 'unique') out.push({ def: e.def, index: e.property! });
    return out;
  }

  /**
   * Pre-commit constraint validation. Simulates the batch's effect on every
   * touched node, then checks each unique index (existing and staged in this
   * batch) for conflicts — both within the batch and against committed state.
   * Throws CONSTRAINT_VIOLATION; called before the WAL append so a violating
   * batch never becomes durable.
   */
  validateBatch(ops: Op[], store: GraphStore): void {
    // Order-aware DDL tracking: the LAST action per def key wins. A unique def
    // whose final action is 'create' must be validated via the staged full-scan
    // path even when an index with that key currently exists (drop-then-
    // recreate rebuilds from the batch's end state); a def whose final action
    // is 'drop' is exempt. TxBuilder.build() nets DDL to at most one drop
    // followed by one create per key, but this stays order-aware as
    // defense-in-depth against hand-built op arrays.
    const ddl = new Map<string, { action: 'create' | 'drop'; def: IndexDef }>();
    for (const op of ops) {
      if (op.op === 'createIndex') ddl.set(indexDefKey(op.def), { action: 'create', def: op.def });
      else if (op.op === 'dropIndex') ddl.set(indexDefKey(op.def), { action: 'drop', def: op.def });
    }
    const active: { def: IndexDef; index: PropertyIndex | undefined }[] =
      this.uniqueEntries().filter((u) => !ddl.has(indexDefKey(u.def)));
    for (const { action, def } of ddl.values())
      if (action === 'create' && def.kind === 'unique') active.push({ def, index: undefined });
    if (active.length === 0) return;

    // Final state of every node the batch touches: null = deleted.
    type Sim = { labels: string[]; props: Props } | null;
    const touched = new Map<NodeId, Sim>();
    const finalOf = (id: NodeId): Sim => {
      if (touched.has(id)) return touched.get(id)!;
      const n = store.getNode(id);
      return n ? { labels: n.labels, props: { ...n.props } } : null;
    };
    for (const op of ops) {
      if (op.op === 'createNode') touched.set(op.id, { labels: op.labels, props: { ...op.props } });
      else if (op.op === 'setNodeProps') {
        const sim = finalOf(op.id);
        if (sim) {
          Object.assign(sim.props, op.set);
          for (const k of op.remove) delete sim.props[k];
          touched.set(op.id, sim);
        }
      } else if (op.op === 'deleteNode') touched.set(op.id, null);
    }

    for (const { def, index } of active) {
      const claims = new Map<string, NodeId>();
      const claim = (key: string, id: NodeId): void => {
        const prev = claims.get(key);
        if (prev !== undefined && prev !== id)
          throw new AtlasError(
            'CONSTRAINT_VIOLATION',
            `unique ${def.label}.${def.property}: nodes ${prev} and ${id} share a value`,
          );
        claims.set(key, id);
      };
      // 1) Claims from touched nodes' final state.
      for (const [id, sim] of touched) {
        if (!sim || !sim.labels.includes(def.label)) continue;
        const v = sim.props[def.property];
        if (v === undefined || !isScalar(v)) continue;
        claim(encodeKey(v), id);
      }
      if (claims.size === 0 && index !== undefined) continue; // nothing relevant changed
      // 2) Conflicts against committed, untouched nodes.
      if (index !== undefined) {
        for (const [key, id] of claims) {
          const committed = index.getExactByKey(key);
          for (const other of committed ?? []) {
            if (other !== id && !touched.has(other))
              throw new AtlasError(
                'CONSTRAINT_VIOLATION',
                `unique ${def.label}.${def.property}: value already taken by node ${other}`,
              );
          }
        }
      } else {
        // Staged constraint: full label scan over committed state (DDL is rare).
        for (const n of store.nodesByLabel(def.label)) {
          if (touched.has(n.id)) continue;
          const v = n.props[def.property];
          if (v === undefined || !isScalar(v)) continue;
          claim(encodeKey(v), n.id);
        }
      }
    }
  }

  private scalarIndex(label: string, property: string): PropertyIndex | undefined {
    return (
      this.entries.get(indexDefKey({ kind: 'property', label, property }))?.property ??
      this.entries.get(indexDefKey({ kind: 'unique', label, property }))?.property
    );
  }
}
