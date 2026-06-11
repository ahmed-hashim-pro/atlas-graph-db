import { compareValues, type ScalarValue } from './keys.js';

const ORDER = 64; // max entries per leaf / max children per internal node

interface Leaf {
  leaf: true;
  keys: ScalarValue[];
  ids: number[];
  next: Leaf | null;
}

interface Internal {
  leaf: false;
  /** (keys[i], splitIds[i]) = smallest (key, id) pair in children[i+1]'s subtree (split pairs). */
  keys: ScalarValue[];
  splitIds: number[];
  children: BNode[];
}

type BNode = Leaf | Internal;

export interface RangeQuery {
  gt?: ScalarValue;
  gte?: ScalarValue;
  lt?: ScalarValue;
  lte?: ScalarValue;
}

/** Compare (key, id) pairs: key order, then id as tiebreaker so pairs are totally ordered. */
function cmpPair(k1: ScalarValue, i1: number, k2: ScalarValue, i2: number): number {
  return compareValues(k1, k2) || i1 - i2;
}

/** First slot in the leaf whose (key, id) >= (key, id) — insertion point. */
function lowerBound(leaf: Leaf, key: ScalarValue, id: number): number {
  let lo = 0;
  let hi = leaf.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmpPair(leaf.keys[mid]!, leaf.ids[mid]!, key, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Child slot to descend into for a (key, id) probe: rightmost child whose
 * split pair <= probe. Split pairs are full (key, id) pairs, so duplicates of
 * a key that straddle a split are still routed to the unique correct child.
 */
function childIndex(n: Internal, key: ScalarValue, id: number): number {
  let i = 0;
  while (i < n.keys.length && cmpPair(n.keys[i]!, n.splitIds[i]!, key, id) <= 0) i++;
  return i;
}

export class BTree {
  private root: BNode = { leaf: true, keys: [], ids: [], next: null };
  size = 0;

  insert(key: ScalarValue, id: number): void {
    const split = this.insertInto(this.root, key, id);
    if (split) {
      this.root = {
        leaf: false,
        keys: [split.key],
        splitIds: [split.id],
        children: [this.root, split.node],
      };
    }
  }

  remove(key: ScalarValue, id: number): boolean {
    // Deletion never rebalances: leaves may run sparse. For an in-memory index
    // fed by interactive workloads this trades memory slack for simplicity;
    // a full checkpoint-reload rebuilds tight trees.
    const leaf = this.findLeaf(key, id);
    const i = lowerBound(leaf, key, id);
    if (i >= leaf.keys.length || cmpPair(leaf.keys[i]!, leaf.ids[i]!, key, id) !== 0) return false;
    leaf.keys.splice(i, 1);
    leaf.ids.splice(i, 1);
    this.size--;
    return true;
  }

  *range(q: RangeQuery = {}): IterableIterator<[ScalarValue, number]> {
    const start = q.gte ?? q.gt;
    let leaf: Leaf;
    let i: number;
    if (start === undefined) {
      leaf = this.leftmostLeaf();
      i = 0;
    } else {
      // -Infinity id: the probe sorts before every real (start, id) pair, so
      // descent lands at the first pair with key >= start.
      leaf = this.findLeaf(start, Number.NEGATIVE_INFINITY);
      i = lowerBound(leaf, start, Number.NEGATIVE_INFINITY);
    }
    for (;;) {
      if (i >= leaf.keys.length) {
        if (!leaf.next) return;
        leaf = leaf.next;
        i = 0;
        continue;
      }
      const k = leaf.keys[i]!;
      if (q.gt !== undefined && compareValues(k, q.gt) <= 0) {
        i++;
        continue;
      }
      if (q.lt !== undefined && compareValues(k, q.lt) >= 0) return;
      if (q.lte !== undefined && compareValues(k, q.lte) > 0) return;
      yield [k, leaf.ids[i]!];
      i++;
    }
  }

  private leftmostLeaf(): Leaf {
    let n = this.root;
    while (!n.leaf) n = n.children[0]!;
    return n;
  }

  private findLeaf(key: ScalarValue, id: number): Leaf {
    let n = this.root;
    while (!n.leaf) n = n.children[childIndex(n, key, id)]!;
    return n;
  }

  private insertInto(
    n: BNode,
    key: ScalarValue,
    id: number,
  ): { key: ScalarValue; id: number; node: BNode } | null {
    if (n.leaf) {
      const i = lowerBound(n, key, id);
      if (i < n.keys.length && cmpPair(n.keys[i]!, n.ids[i]!, key, id) === 0) return null; // pair no-op
      n.keys.splice(i, 0, key);
      n.ids.splice(i, 0, id);
      this.size++;
      if (n.keys.length <= ORDER) return null;
      const mid = n.keys.length >>> 1;
      const right: Leaf = { leaf: true, keys: n.keys.splice(mid), ids: n.ids.splice(mid), next: n.next };
      n.next = right;
      return { key: right.keys[0]!, id: right.ids[0]!, node: right };
    }
    const i = childIndex(n, key, id);
    const split = this.insertInto(n.children[i]!, key, id);
    if (!split) return null;
    n.keys.splice(i, 0, split.key);
    n.splitIds.splice(i, 0, split.id);
    n.children.splice(i + 1, 0, split.node);
    if (n.children.length <= ORDER) return null;
    const midIdx = n.keys.length >>> 1;
    const upKey = n.keys[midIdx]!;
    const upId = n.splitIds[midIdx]!;
    const right: Internal = {
      leaf: false,
      keys: n.keys.splice(midIdx + 1),
      splitIds: n.splitIds.splice(midIdx + 1),
      children: n.children.splice(midIdx + 1),
    };
    n.keys.pop(); // upKey moves up, not into either half
    n.splitIds.pop();
    return { key: upKey, id: upId, node: right };
  }
}
