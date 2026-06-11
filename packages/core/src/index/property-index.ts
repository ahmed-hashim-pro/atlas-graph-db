import type { NodeId, PropertyValue } from '../types.js';
import { BTree, type RangeQuery } from './btree.js';
import { encodeKey, isScalar, type ScalarValue } from './keys.js';

export type { RangeQuery } from './btree.js';

/**
 * Exact + range index over one (label, property) pair. Non-scalar values
 * (arrays) are not indexable and are skipped silently — the node simply has
 * no entry, mirroring how absent properties behave.
 */
export class PropertyIndex {
  private readonly exact = new Map<string, Set<NodeId>>();
  private readonly tree = new BTree();

  get size(): number {
    return this.tree.size;
  }

  add(value: PropertyValue, id: NodeId): void {
    if (!isScalar(value)) return;
    const key = encodeKey(value);
    let set = this.exact.get(key);
    if (!set) {
      set = new Set();
      this.exact.set(key, set);
    }
    if (set.has(id)) return; // pair already present — keep tree/size in sync
    set.add(id);
    this.tree.insert(value, id);
  }

  remove(value: PropertyValue, id: NodeId): void {
    if (!isScalar(value)) return;
    const key = encodeKey(value);
    const set = this.exact.get(key);
    if (!set?.has(id)) return;
    set.delete(id);
    if (set.size === 0) this.exact.delete(key);
    this.tree.remove(value, id);
  }

  getExact(value: ScalarValue): ReadonlySet<NodeId> | undefined {
    return this.getExactByKey(encodeKey(value));
  }

  /** Exact postings by pre-encoded key — used by unique validation. */
  getExactByKey(key: string): ReadonlySet<NodeId> | undefined {
    return this.exact.get(key);
  }

  *getRange(q: RangeQuery): IterableIterator<NodeId> {
    for (const [, id] of this.tree.range(q)) yield id;
  }
}
