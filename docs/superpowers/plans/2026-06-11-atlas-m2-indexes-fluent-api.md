# Atlas M2 — Indexes + Fluent API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the query-acceleration layer to `@atlas/core` — exact/range/full-text indexes with unique constraints, a label index, the lazy fluent traversal API with read-leased streaming, schema introspection, the change feed — plus the curated science-history dataset, and close out two M1 review carry-overs (directory fsync, test typechecking).

**Architecture:** Index/schema maintenance hooks into `GraphStore.applyOp` *before* each mutation (old values are still readable), so recovery and snapshot-load rebuild them for free. Index definitions are new `Op` variants persisted through the WAL and snapshots. Unique constraints validate in `transact` before the WAL append. The fluent API composes lazy generators over committed state; only `stream()` (which yields to the event loop) takes a read lease that holds the write queue, bounded by a time budget.

**Tech Stack:** Existing M1 stack (TypeScript strict ESM, Vitest, fast-check). No new runtime dependencies; the B+ tree and full-text index are hand-built.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` §4.2 (label interning/layout), §4.5 (indexes + constraints), §4.4/§4.7 (read leases), §4.6 (schema introspection), §4.8 (change feed), §5.1 (fluent API), §8 (science-history), §12 M2.

**Existing code anchors (read these before deviating):** `Op`/`Props`/`validateProps` in `packages/core/src/types.ts`; `GraphStore.applyOp` in `src/store.ts`; `TxBuilder` in `src/tx.ts`; `AtlasDatabase.transact`/`open`/`close` in `src/database.ts`; `SnapshotData` in `src/snapshot.ts`.

---

## File structure

```
packages/core/src/
  files.ts                 MODIFY: add fsyncDir
  database.ts              MODIFY: fsyncDir call sites; validateBatch hook; read leases;
                           graph(), schema(), subscribe(), createIndex/dropIndex/listIndexes
  types.ts                 MODIFY: Op gains createIndex/dropIndex; IndexDef types
  tx.ts                    MODIFY: TxBuilder.createIndex/dropIndex
  store.ts                 MODIFY: label index; route ops through IndexRegistry + SchemaTracker
  snapshot.ts              MODIFY: SnapshotData.indexes (backward-compatible)
  index/keys.ts            NEW: scalar key encoding + total order comparator
  index/btree.ts           NEW: in-memory B+ tree (duplicate keys, range scans)
  index/property-index.ts  NEW: exact Map + B+ tree per (label, property)
  index/fulltext.ts        NEW: tokenizer + inverted index + prefix search
  index/registry.ts        NEW: IndexRegistry — defs, backfill, op maintenance, unique validation
  traversal/traversal.ts   NEW: NodeTraversal/EdgeTraversal/PathTraversal + GraphView
  schema.ts                NEW: SchemaTracker + SchemaSummary
  change-feed.ts           NEW: ring buffer + subscriptions + resync protocol
  index.ts                 MODIFY: export new public surface

packages/core/test/        one new test file per module (named per task)
packages/core/test/tsconfig.json    NEW: typechecks tests (was IDE-only noise)
packages/core/bench/tsconfig.json   NEW: typechecks bench
packages/datasets/src/
  science-history.ts       NEW: curated core + deterministic expansion (~500 nodes)
  load.ts                  NEW: structural-typed loader (no @atlas/core import — would cycle)
  index.ts                 MODIFY: exports
packages/datasets/test/tsconfig.json NEW
.github/workflows/ci.yml   MODIFY: add typecheck:test step
```

Convention carried from M1: ESM imports use `.js` extensions; every commit message ends with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Directory fsync after durability-critical directory operations

M1's final review found that snapshot rename, WAL rotation, and segment cleanup fsync file *contents* but never the parent directory entry, so strict power-loss consistency relied on filesystem journal ordering.

**Files:**
- Modify: `packages/core/src/files.ts`
- Modify: `packages/core/src/database.ts`
- Test: `packages/core/test/files.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`packages/core/test/files.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsyncDir } from '../src/files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-files-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fsyncDir', () => {
  it('resolves on an existing directory', async () => {
    await expect(fsyncDir(dir)).resolves.toBeUndefined();
  });

  it('rejects on a missing directory', async () => {
    await expect(fsyncDir(join(dir, 'missing'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/files.test.ts`
Expected: FAIL — `fsyncDir` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/files.ts`:

```ts
/**
 * Fsync a directory so renames/creations/deletions of its entries are durable
 * across power loss, not just process crash. On platforms where directory
 * fsync is a no-op the call is harmless.
 */
export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
```

In `packages/core/src/database.ts`, import `fsyncDir` from `./files.js` (extend the existing import) and add three call sites:

1. In `runCheckpoint` phase 2, after `await rename(tmpPath, finalPath);`:

```ts
    await fsyncDir(this.dir);
```

2. In `runCheckpoint` phase 1, after the new `WalWriter.open(...)` line (the rotation creates a directory entry):

```ts
      await fsyncDir(this.dir);
```

3. At the end of `cleanupBefore` (after both deletion loops):

```ts
    await fsyncDir(this.dir);
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `pnpm vitest run packages/core/test/files.test.ts packages/core/test/checkpoint.test.ts packages/core/test/crash.test.ts`
Expected: PASS (checkpoint + crash suites confirm no regression).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(core): fsync parent directory after snapshot rename, WAL rotation, cleanup"
```

### Task 2: Typecheck test and bench code (kills the IDE noise, catches real bugs)

Tests and bench are currently outside every tsconfig project: `tsc -b` never sees them and the IDE shows inferred-project errors. Give them real (noEmit) tsconfigs and wire a `typecheck:test` script into CI.

**Files:**
- Create: `packages/core/test/tsconfig.json`, `packages/core/bench/tsconfig.json`, `packages/datasets/test/tsconfig.json`
- Modify: `package.json` (root), `.github/workflows/ci.yml`, plus any test file the new typecheck flags

- [ ] **Step 1: Create the tsconfigs**

`packages/core/test/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["./**/*.ts", "../src/**/*.ts"]
}
```

`packages/core/bench/tsconfig.json` — identical content.

`packages/datasets/test/tsconfig.json` — identical content (its `include` paths resolve relative to that directory automatically).

- [ ] **Step 2: Add the script and run it**

In root `package.json` scripts add:

```json
    "typecheck:test": "tsc -p packages/core/test/tsconfig.json && tsc -p packages/core/bench/tsconfig.json && tsc -p packages/datasets/test/tsconfig.json"
```

Run: `pnpm typecheck:test`
Expected: a SMALL number of real errors surface. Known one: `packages/core/test/codec.test.ts` casts an `Op` to `{ props: { when: unknown } }` directly — change that cast to go through `unknown`:

```ts
    expect((decoded.ops[0] as unknown as { props: { when: unknown } }).props.when).toBeInstanceOf(Date);
```

Fix every surfaced error **minimally** (casts through `unknown`, missing type annotations). Do not refactor test logic. Re-run until clean.

- [ ] **Step 3: Wire into CI**

In `.github/workflows/ci.yml`, after the `- run: pnpm build` step add:

```yaml
      - run: pnpm typecheck:test
```

- [ ] **Step 4: Full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: typecheck test and bench code via dedicated noEmit tsconfigs"
```

### Task 3: Label index in GraphStore

`nodesByLabel` is a full scan today. Add a `Map<label, Set<NodeId>>` maintained in `applyOp` — O(1) label lookup, the natural source for fluent `nodes(label)` and index backfills.

**Files:**
- Modify: `packages/core/src/store.ts`
- Test: `packages/core/test/label-index.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`packages/core/test/label-index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store.js';

describe('label index', () => {
  it('serves nodesByLabel from the index, including multi-label nodes', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['Person', 'Author'], props: {} });
    s.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: {} });
    expect([...s.nodesByLabel('Person')].map((n) => n.id).sort()).toEqual([1, 2]);
    expect([...s.nodesByLabel('Author')].map((n) => n.id)).toEqual([1]);
    expect(s.labelCount('Person')).toBe(2);
    expect(s.labelCount('Nope')).toBe(0);
  });

  it('removes deleted nodes from the index and prunes empty labels', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: {} });
    s.applyOp({ op: 'deleteNode', id: 1 });
    expect([...s.nodesByLabel('A')]).toEqual([]);
    expect(s.labelCount('A')).toBe(0);
    expect(() => s.checkInvariants()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/label-index.test.ts`
Expected: FAIL — `labelCount` is not a function.

- [ ] **Step 3: Implement in `packages/core/src/store.ts`**

Add a private field next to the adjacency maps:

```ts
  private readonly byLabel = new Map<string, Set<NodeId>>();
```

In `applyOp` case `'createNode'`, after `this.nodes.set(...)`:

```ts
        for (const label of op.labels) {
          let set = this.byLabel.get(label);
          if (!set) {
            set = new Set();
            this.byLabel.set(label, set);
          }
          set.add(op.id);
        }
```

In case `'deleteNode'`, before `this.nodes.delete(op.id)` (the record is still readable):

```ts
        for (const label of this.nodes.get(op.id)!.labels) {
          const set = this.byLabel.get(label);
          set?.delete(op.id);
          if (set?.size === 0) this.byLabel.delete(label);
        }
```

Replace `nodesByLabel` and add `labelCount` + `nodeIdsByLabel`:

```ts
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
```

Add at module scope (below the `unlink` helper):

```ts
const EMPTY_IDS: ReadonlySet<NodeId> = new Set();
```

Extend `checkInvariants()` with a label-index cross-check (append before the dangling-endpoint loop):

```ts
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
    for (const n of this.nodes.values()) expectedRefs += n.labels.length;
    if (labelRefs !== expectedRefs)
      throw new AtlasError('INTERNAL', `label index has ${labelRefs} refs, expected ${expectedRefs}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/label-index.test.ts packages/core/test/store.test.ts packages/core/test/store-mutation.test.ts packages/core/test/property.test.ts`
Expected: PASS (property suite re-validates invariants over random sequences).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): label index with O(1) nodesByLabel and invariant checks"
```

### Task 4: Scalar key encoding and ordering

**Files:**
- Create: `packages/core/src/index/keys.ts`
- Test: `packages/core/test/keys.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compareValues, encodeKey, isScalar, typeRank } from '../src/index/keys.js';

describe('keys', () => {
  it('isScalar accepts primitives and Dates, rejects arrays', () => {
    expect(isScalar('x')).toBe(true);
    expect(isScalar(3)).toBe(true);
    expect(isScalar(false)).toBe(true);
    expect(isScalar(new Date(0))).toBe(true);
    expect(isScalar(['x'])).toBe(false);
  });

  it('encodeKey distinguishes equal-looking values of different types', () => {
    expect(encodeKey(1)).not.toBe(encodeKey('1'));
    expect(encodeKey(true)).not.toBe(encodeKey('true'));
    expect(encodeKey(new Date(5))).not.toBe(encodeKey(5));
    expect(encodeKey(1)).toBe(encodeKey(1));
  });

  it('compareValues orders within a type and ranks across types', () => {
    expect(compareValues(1, 2)).toBeLessThan(0);
    expect(compareValues('b', 'a')).toBeGreaterThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(new Date(1), new Date(2))).toBeLessThan(0);
    expect(compareValues(99, 'a')).toBeLessThan(0); // number ranks before string
    expect(typeRank(true)).toBeGreaterThan(typeRank('s'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/index/keys.ts`:

```ts
import type { PropertyValue } from '../types.js';

/** Indexable scalar property values. Arrays are not indexable in v1. */
export type ScalarValue = string | number | boolean | Date;

export function isScalar(v: PropertyValue): v is ScalarValue {
  return !Array.isArray(v);
}

/** Cross-type ordering rank: number < string < boolean < date. */
export function typeRank(v: ScalarValue): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/** Canonical exact-match key; the type tag keeps 1 and '1' distinct. */
export function encodeKey(v: ScalarValue): string {
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `d:${v.getTime()}`;
}

/** Total order over scalars: type rank first, then natural order within the type. */
export function compareValues(a: ScalarValue, b: ScalarValue): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a - (b as number);
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  if (typeof a === 'boolean') return Number(a) - Number(b as boolean);
  return a.getTime() - (b as Date).getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/test/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): scalar index key encoding and total-order comparator"
```

### Task 5: In-memory B+ tree

Order-64 B+ tree mapping `(ScalarValue key, NodeId id)` pairs — duplicate keys allowed, pair-unique — with linked leaves for range scans. This backs range queries and `ORDER BY` in later milestones.

**Files:**
- Create: `packages/core/src/index/btree.ts`
- Test: `packages/core/test/btree.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/btree.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BTree } from '../src/index/btree.js';
import { compareValues, type ScalarValue } from '../src/index/keys.js';

function entries(t: BTree, q: Parameters<BTree['range']>[0] = {}): [ScalarValue, number][] {
  return [...t.range(q)];
}

describe('BTree basics', () => {
  it('inserts, iterates in order, and supports duplicate keys', () => {
    const t = new BTree();
    t.insert(5, 50);
    t.insert(1, 10);
    t.insert(5, 51);
    t.insert(3, 30);
    expect(entries(t)).toEqual([
      [1, 10],
      [3, 30],
      [5, 50],
      [5, 51],
    ]);
    expect(t.size).toBe(4);
  });

  it('range respects gt/gte/lt/lte bounds', () => {
    const t = new BTree();
    for (let i = 1; i <= 9; i++) t.insert(i, i * 10);
    expect(entries(t, { gte: 3, lte: 5 }).map(([k]) => k)).toEqual([3, 4, 5]);
    expect(entries(t, { gt: 3, lt: 5 }).map(([k]) => k)).toEqual([4]);
    expect(entries(t, { gte: 8 }).map(([k]) => k)).toEqual([8, 9]);
    expect(entries(t, { lt: 2 }).map(([k]) => k)).toEqual([1]);
  });

  it('removes exactly the (key, id) pair', () => {
    const t = new BTree();
    t.insert(5, 50);
    t.insert(5, 51);
    expect(t.remove(5, 50)).toBe(true);
    expect(t.remove(5, 99)).toBe(false);
    expect(entries(t)).toEqual([[5, 51]]);
  });

  it('orders mixed types by type rank', () => {
    const t = new BTree();
    t.insert('a', 1);
    t.insert(7, 2);
    t.insert(true, 3);
    expect(entries(t).map(([k]) => k)).toEqual([7, 'a', true]);
  });
});

describe('BTree vs reference model (property)', () => {
  it('matches a sorted-array model under random insert/remove/range at splitting sizes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('insert', 'remove'),
            key: fc.integer({ min: 0, max: 200 }),
            id: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 200, maxLength: 600 },
        ),
        fc.record({ lo: fc.integer({ min: 0, max: 200 }), hi: fc.integer({ min: 0, max: 200 }) }),
        (actions, bounds) => {
          const t = new BTree();
          const model: [number, number][] = [];
          for (const a of actions) {
            if (a.kind === 'insert') {
              const dup = model.some(([k, i]) => k === a.key && i === a.id);
              if (!dup) {
                t.insert(a.key, a.id);
                model.push([a.key, a.id]);
              }
            } else {
              const idx = model.findIndex(([k, i]) => k === a.key && i === a.id);
              expect(t.remove(a.key, a.id)).toBe(idx !== -1);
              if (idx !== -1) model.splice(idx, 1);
            }
          }
          model.sort((x, y) => compareValues(x[0], y[0]) || x[1] - y[1]);
          expect(entries(t)).toEqual(model);
          const [lo, hi] = bounds.lo <= bounds.hi ? [bounds.lo, bounds.hi] : [bounds.hi, bounds.lo];
          expect(entries(t, { gte: lo, lte: hi })).toEqual(
            model.filter(([k]) => k >= lo && k <= hi),
          );
          expect(t.size).toBe(model.length);
        },
      ),
      { numRuns: 40 },
    );
  }, 60_000);
});
```

Note: `BTree.insert` treats an exact duplicate `(key, id)` pair as a no-op; the model mirrors that by skipping duplicates.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/btree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/index/btree.ts`:

```ts
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
  /** keys[i] = smallest key in children[i+1]'s subtree (split keys). */
  keys: ScalarValue[];
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

export class BTree {
  private root: BNode = { leaf: true, keys: [], ids: [], next: null };
  size = 0;

  insert(key: ScalarValue, id: number): void {
    const split = this.insertInto(this.root, key, id);
    if (split) {
      this.root = { leaf: false, keys: [split.key], children: [this.root, split.node] };
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
      // -Infinity id: land at the first pair with key >= start.
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
    while (!n.leaf) {
      let i = 0;
      // Descend right while the split key <= probe. Split keys use key-only
      // comparison; duplicates of a key never straddle a split incorrectly
      // because inserts place equal keys by (key, id) order.
      while (i < n.keys.length && compareValues(n.keys[i]!, key) <= 0) i++;
      // Equal keys may start in the child left of the split — back up one when probing the lower edge.
      if (i > 0 && id === Number.NEGATIVE_INFINITY && compareValues(n.keys[i - 1]!, key) === 0) i--;
      n = n.children[i]!;
    }
    return n;
  }

  private insertInto(n: BNode, key: ScalarValue, id: number): { key: ScalarValue; node: BNode } | null {
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
      return { key: right.keys[0]!, node: right };
    }
    let i = 0;
    while (i < n.keys.length && compareValues(n.keys[i]!, key) <= 0) i++;
    const split = this.insertInto(n.children[i]!, key, id);
    if (!split) return null;
    n.keys.splice(i, 0, split.key);
    n.children.splice(i + 1, 0, split.node);
    if (n.children.length <= ORDER) return null;
    const midIdx = n.keys.length >>> 1;
    const upKey = n.keys[midIdx]!;
    const right: Internal = {
      leaf: false,
      keys: n.keys.splice(midIdx + 1),
      children: n.children.splice(midIdx + 1),
    };
    n.keys.pop(); // upKey moves up, not into either half
    return { key: upKey, node: right };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/btree.test.ts`
Expected: PASS, including the 40-run property test against the reference model. If the property test finds a counterexample, fast-check prints the shrunk action list — debug the tree (likely split-key handling around duplicates), never weaken the model.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): in-memory B+ tree with duplicate keys and range scans"
```

### Task 6: Property index (exact + range per label/property)

**Files:**
- Create: `packages/core/src/index/property-index.ts`
- Test: `packages/core/test/property-index.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/property-index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PropertyIndex } from '../src/index/property-index.js';

describe('PropertyIndex', () => {
  it('answers exact lookups, distinguishing value types', () => {
    const ix = new PropertyIndex();
    ix.add(1815, 1);
    ix.add('1815', 2);
    ix.add(1815, 3);
    expect([...(ix.getExact(1815) ?? [])].sort()).toEqual([1, 3]);
    expect([...(ix.getExact('1815') ?? [])]).toEqual([2]);
    expect(ix.getExact(9999)).toBeUndefined();
  });

  it('answers range queries in order', () => {
    const ix = new PropertyIndex();
    ix.add(1809, 1); // Darwin
    ix.add(1815, 2); // Lovelace
    ix.add(1791, 3); // Babbage
    ix.add(1867, 4); // Curie
    expect([...ix.getRange({ gte: 1800, lt: 1867 })]).toEqual([1, 2]);
    expect([...ix.getRange({ gt: 1815 })]).toEqual([4]);
  });

  it('removes ids and ignores non-scalar values entirely', () => {
    const ix = new PropertyIndex();
    ix.add(['tag'], 1); // arrays are not indexable — silently skipped
    expect(ix.size).toBe(0);
    ix.add(5, 2);
    ix.remove(5, 2);
    expect(ix.getExact(5)).toBeUndefined();
    expect([...ix.getRange({})]).toEqual([]);
    expect(ix.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/property-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/index/property-index.ts`:

```ts
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
    return this.exact.get(encodeKey(value));
  }

  *getRange(q: RangeQuery): IterableIterator<NodeId> {
    for (const [, id] of this.tree.range(q)) yield id;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/property-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): exact+range property index over B+ tree"
```

### Task 7: Full-text index

**Files:**
- Create: `packages/core/src/index/fulltext.ts`
- Test: `packages/core/test/fulltext.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/fulltext.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FulltextIndex, tokenize } from '../src/index/fulltext.js';

describe('tokenize', () => {
  it('lowercases and splits on non-letter/number runs, unicode included', () => {
    expect(tokenize('Notes on the Analytical Engine!')).toEqual([
      'notes',
      'on',
      'the',
      'analytical',
      'engine',
    ]);
    expect(tokenize('Ada—Lovelace 1815')).toEqual(['ada', 'lovelace', '1815']);
    expect(tokenize('Théorie analytique')).toEqual(['théorie', 'analytique']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('FulltextIndex', () => {
  function seeded(): FulltextIndex {
    const ix = new FulltextIndex();
    ix.add('Notes on the Analytical Engine', 1);
    ix.add('Sketch of the Analytical Engine', 2);
    ix.add('On the Origin of Species', 3);
    return ix;
  }

  it('ANDs all query tokens', () => {
    const ix = seeded();
    expect([...ix.search('analytical engine')].sort()).toEqual([1, 2]);
    expect([...ix.search('notes engine')]).toEqual([1]);
    expect([...ix.search('engine species')]).toEqual([]);
    expect([...ix.search('')]).toEqual([]);
  });

  it('prefix mode expands the final token (search-as-you-type)', () => {
    const ix = seeded();
    expect([...ix.search('anal', { prefix: true })].sort()).toEqual([1, 2]);
    expect([...ix.search('origin of spec', { prefix: true })]).toEqual([3]);
    expect([...ix.search('anal', {})]).toEqual([]); // exact token 'anal' matches nothing
  });

  it('indexes string arrays, ignores non-strings, and removes cleanly', () => {
    const ix = new FulltextIndex();
    ix.add(['graph theory', 'algebra'], 7);
    ix.add(1815, 8); // numbers are not text — skipped
    expect([...ix.search('algebra')]).toEqual([7]);
    ix.remove(['graph theory', 'algebra'], 7);
    expect([...ix.search('algebra')]).toEqual([]);
    expect(ix.tokenCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/fulltext.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/index/fulltext.ts`:

```ts
import type { NodeId, PropertyValue } from '../types.js';

const WORD = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

function textOf(value: PropertyValue): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  return null;
}

/**
 * Inverted index over one (label, property) pair. Postings count token
 * occurrences per node so removing a value only drops a node when its last
 * occurrence of the token goes. A parallel sorted token array serves prefix
 * scans for search-as-you-type.
 */
export class FulltextIndex {
  private readonly postings = new Map<string, Map<NodeId, number>>();
  private sortedTokens: string[] = [];
  private sortedDirty = false;

  get tokenCount(): number {
    return this.postings.size;
  }

  add(value: PropertyValue, id: NodeId): void {
    const text = textOf(value);
    if (text === null) return;
    for (const token of tokenize(text)) {
      let nodes = this.postings.get(token);
      if (!nodes) {
        nodes = new Map();
        this.postings.set(token, nodes);
        this.sortedDirty = true;
      }
      nodes.set(id, (nodes.get(id) ?? 0) + 1);
    }
  }

  remove(value: PropertyValue, id: NodeId): void {
    const text = textOf(value);
    if (text === null) return;
    for (const token of tokenize(text)) {
      const nodes = this.postings.get(token);
      const count = nodes?.get(id);
      if (!nodes || count === undefined) continue;
      if (count <= 1) {
        nodes.delete(id);
        if (nodes.size === 0) {
          this.postings.delete(token);
          this.sortedDirty = true;
        }
      } else {
        nodes.set(id, count - 1);
      }
    }
  }

  /** AND-semantics over query tokens; `prefix` expands the final token. */
  search(query: string, opts: { prefix?: boolean } = {}): Set<NodeId> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return new Set();
    const last = tokens.length - 1;
    let result: Set<NodeId> | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const ids =
        opts.prefix && i === last
          ? this.idsForPrefix(tokens[i]!)
          : new Set(this.postings.get(tokens[i]!)?.keys() ?? []);
      result = result === null ? ids : new Set([...result].filter((id) => ids.has(id)));
      if (result.size === 0) return result;
    }
    return result ?? new Set();
  }

  private idsForPrefix(prefix: string): Set<NodeId> {
    if (this.sortedDirty) {
      this.sortedTokens = [...this.postings.keys()].sort();
      this.sortedDirty = false;
    }
    const ids = new Set<NodeId>();
    let lo = 0;
    let hi = this.sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedTokens[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.sortedTokens.length; i++) {
      const token = this.sortedTokens[i]!;
      if (!token.startsWith(prefix)) break;
      for (const id of this.postings.get(token)?.keys() ?? []) ids.add(id);
    }
    return ids;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/fulltext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): full-text inverted index with prefix search"
```

### Task 8: IndexRegistry, index ops, TxBuilder DDL, GraphStore routing

Index definitions become `Op` variants so the WAL and snapshots persist them; the registry maintains postings by observing every op *before* the store mutates (old values still readable).

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/tx.ts`, `packages/core/src/store.ts`
- Create: `packages/core/src/index/registry.ts`
- Test: `packages/core/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { IdAllocator } from '../src/id-allocator.js';
import { GraphStore } from '../src/store.js';
import { TxBuilder } from '../src/tx.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada', born: 1815 } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: { name: 'Charles', born: 1791 } });
  s.applyOp({ op: 'createNode', id: 3, labels: ['Document'], props: { title: 'Notes' } });
  return s;
}

describe('index ops through GraphStore', () => {
  it('createIndex backfills existing nodes (label-scoped, multi-label aware)', () => {
    const s = seeded();
    s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'Person', property: 'born' } });
    expect([...(s.indexes.lookupExact('Person', 'born', 1815) ?? [])]).toEqual([1]);
    expect([...s.indexes.lookupRange('Person', 'born', { gte: 1800 })]).toEqual([1]);
    expect(s.indexes.lookupExact('Document', 'born', 1815)).toBeUndefined(); // no such index
  });

  it('maintains postings across create/set/remove/delete', () => {
    const s = seeded();
    s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'Person', property: 'born' } });
    s.applyOp({ op: 'createNode', id: 4, labels: ['Person'], props: { born: 1809 } });
    expect([...s.indexes.lookupRange('Person', 'born', { lt: 1815 })]).toEqual([2, 4]);
    s.applyOp({ op: 'setNodeProps', id: 4, set: { born: 1882 }, remove: [] });
    expect([...s.indexes.lookupRange('Person', 'born', { gt: 1815 })]).toEqual([4]);
    s.applyOp({ op: 'setNodeProps', id: 4, set: {}, remove: ['born'] });
    expect([...s.indexes.lookupRange('Person', 'born', { gt: 1815 })]).toEqual([]);
    s.applyOp({ op: 'deleteNode', id: 3 }); // unindexed label — must not throw
  });

  it('fulltext indexes answer searchText and dropIndex removes lookups', () => {
    const s = seeded();
    s.applyOp({ op: 'createIndex', def: { kind: 'fulltext', label: 'Document', property: 'title' } });
    expect([...s.indexes.searchText('Document', 'title', 'notes')]).toEqual([3]);
    s.applyOp({ op: 'dropIndex', def: { kind: 'fulltext', label: 'Document', property: 'title' } });
    expect(s.indexes.searchText('Document', 'title', 'notes')).toBeUndefined();
  });
});

describe('TxBuilder index DDL', () => {
  it('stages createIndex/dropIndex with duplicate/missing validation', () => {
    const s = seeded();
    const tx = new TxBuilder(s, new IdAllocator(10, 10));
    const def = { kind: 'property', label: 'Person', property: 'born' } as const;
    tx.createIndex(def);
    expect(() => tx.createIndex(def)).toThrowError(AtlasError); // duplicate within tx
    tx.dropIndex(def); // staged create can be dropped
    expect(() => tx.dropIndex(def)).toThrowError(AtlasError); // now missing
    expect(tx.build().map((o) => o.op)).toEqual(['createIndex', 'dropIndex']);
  });

  it('rejects malformed defs', () => {
    const s = seeded();
    const tx = new TxBuilder(s, new IdAllocator(10, 10));
    expect(() => tx.createIndex({ kind: 'property', label: '', property: 'x' })).toThrowError(
      AtlasError,
    );
    expect(() =>
      tx.createIndex({ kind: 'nope' as never, label: 'A', property: 'x' }),
    ).toThrowError(AtlasError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/registry.test.ts`
Expected: FAIL — `registry.js` missing, `createIndex` not on TxBuilder.

- [ ] **Step 3: Implement**

Add to `packages/core/src/types.ts` (above `Op`):

```ts
export type IndexKind = 'property' | 'fulltext' | 'unique';

export interface IndexDef {
  kind: IndexKind;
  label: string;
  property: string;
}

const INDEX_KINDS: ReadonlySet<string> = new Set(['property', 'fulltext', 'unique']);

export function validateIndexDef(def: IndexDef): void {
  if (!INDEX_KINDS.has(def.kind))
    throw new AtlasError('VALIDATION', `unknown index kind "${def.kind}"`);
  if (def.label.length === 0 || def.property.length === 0)
    throw new AtlasError('VALIDATION', 'index label and property must be non-empty');
}
```

Extend the `Op` union with:

```ts
  | { op: 'createIndex'; def: IndexDef }
  | { op: 'dropIndex'; def: IndexDef };
```

Create `packages/core/src/index/registry.ts`:

```ts
import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { IndexDef, NodeId, Op } from '../types.js';
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
    if (this.has(def))
      throw new AtlasError('INTERNAL', `index ${indexDefKey(def)} already exists`);
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
  lookupExact(label: string, property: string, value: ScalarValue): ReadonlySet<NodeId> | undefined {
    const ix = this.scalarIndex(label, property);
    if (!ix) return undefined;
    return ix.getExact(value) ?? new Set();
  }

  /** Throws NOT_FOUND when no scalar index exists — range scans never fall back to table scans silently. */
  lookupRange(label: string, property: string, q: RangeQuery): IterableIterator<NodeId> {
    const ix = this.scalarIndex(label, property);
    if (!ix)
      throw new AtlasError('NOT_FOUND', `no property index on ${label}.${property}`);
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

  private scalarIndex(label: string, property: string): PropertyIndex | undefined {
    return (
      this.entries.get(indexDefKey({ kind: 'property', label, property }))?.property ??
      this.entries.get(indexDefKey({ kind: 'unique', label, property }))?.property
    );
  }
}
```

In `packages/core/src/store.ts`: import the registry —

```ts
import { IndexRegistry } from './index/registry.js';
```

add the field next to `types`:

```ts
  readonly indexes = new IndexRegistry();
```

and at the **top** of `applyOp`, before the `switch`:

```ts
    this.indexes.beforeApply(op, this);
```

then add two cases to the `switch`:

```ts
      case 'createIndex': {
        this.indexes.create(op.def, this);
        return;
      }
      case 'dropIndex': {
        this.indexes.drop(op.def);
        return;
      }
```

In `packages/core/src/tx.ts`: extend imports (`validateIndexDef`, `IndexDef` type, and `indexDefKey` from `./index/registry.js`), add two fields:

```ts
  private readonly stagedIndexes = new Set<string>();
  private readonly droppedIndexes = new Set<string>();
```

and two methods:

```ts
  createIndex(def: IndexDef): void {
    validateIndexDef(def);
    const key = indexDefKey(def);
    const exists =
      (this.store.indexes.has(def) && !this.droppedIndexes.has(key)) || this.stagedIndexes.has(key);
    if (exists) throw new AtlasError('VALIDATION', `index ${key} already exists`);
    this.droppedIndexes.delete(key);
    this.stagedIndexes.add(key);
    this.ops.push({ op: 'createIndex', def });
  }

  dropIndex(def: IndexDef): void {
    const key = indexDefKey(def);
    const exists =
      (this.store.indexes.has(def) && !this.droppedIndexes.has(key)) || this.stagedIndexes.has(key);
    if (!exists) throw new AtlasError('NOT_FOUND', `index ${key} does not exist`);
    this.stagedIndexes.delete(key);
    this.droppedIndexes.add(key);
    this.ops.push({ op: 'dropIndex', def });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/registry.test.ts packages/core/test/store.test.ts packages/core/test/property.test.ts packages/core/test/codec.test.ts`
Expected: PASS — registry behavior plus no regression in store/property/codec suites (the codec round-trips the new op variants without changes since they're plain data).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): index registry with op-driven maintenance and TxBuilder DDL"
```

### Task 9: Unique constraint enforcement at commit

Constraints must reject a batch **before** the WAL append — a violating batch must never become durable (recovery replays whatever the WAL holds, and `applyBatch` half-applying then throwing would corrupt state).

**Files:**
- Modify: `packages/core/src/index/registry.ts` (add `validateBatch`), `packages/core/src/database.ts` (hook)
- Test: `packages/core/test/constraints.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/constraints.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { AtlasError } from '../src/errors.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-uniq-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UNIQ = { kind: 'unique', label: 'Person', property: 'email' } as const;

describe('unique constraints', () => {
  it('rejects committed duplicates and rolls back the whole batch', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      tx.createNode(['Person'], { email: 'ada@example.com' });
    });
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { name: 'innocent bystander' });
        tx.createNode(['Person'], { email: 'ada@example.com' });
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    expect(db.stats().nodeCount).toBe(1); // bystander rolled back too
    await db.close();
  });

  it('rejects duplicates within a single batch', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => tx.createIndex(UNIQ));
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { email: 'x@x' });
        tx.createNode(['Person'], { email: 'x@x' });
      }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATION' });
    await db.close();
  });

  it('allows a value to move between nodes in one batch', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      tx.createIndex(UNIQ);
      a = tx.createNode(['Person'], { email: 'shared@x' });
    });
    await db.transact((tx) => {
      tx.setNodeProps(a, { email: 'new@x' });
      tx.createNode(['Person'], { email: 'shared@x' }); // old value freed earlier in batch
    });
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });

  it('rejects creating a constraint over existing duplicate data', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      tx.createNode(['Person'], { email: 'dup@x' });
      tx.createNode(['Person'], { email: 'dup@x' });
    });
    await expect(db.transact((tx) => tx.createIndex(UNIQ))).rejects.toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
    });
    expect(db.listIndexes()).toEqual([]); // nothing half-created
    await db.close();
  });

  it('does not conflate equal-looking values of different types', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => tx.createIndex({ kind: 'unique', label: 'P', property: 'v' }));
    await db.transact((tx) => {
      tx.createNode(['P'], { v: 1 });
      tx.createNode(['P'], { v: '1' });
    });
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });
});
```

(`db.listIndexes()` arrives in Task 10 — for THIS task stub it onto `AtlasDatabase` now as specified in Step 3; Task 10 keeps it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/constraints.test.ts`
Expected: FAIL — duplicates are accepted (no `validateBatch` yet).

- [ ] **Step 3: Implement**

Append to `IndexRegistry` in `packages/core/src/index/registry.ts`:

```ts
  /**
   * Pre-commit constraint validation. Simulates the batch's effect on every
   * touched node, then checks each unique index (existing and staged in this
   * batch) for conflicts — both within the batch and against committed state.
   * Throws CONSTRAINT_VIOLATION; called before the WAL append so a violating
   * batch never becomes durable.
   */
  validateBatch(ops: Op[], store: GraphStore): void {
    const staged: IndexDef[] = [];
    const droppedKeys = new Set<string>();
    for (const op of ops) {
      if (op.op === 'createIndex' && op.def.kind === 'unique') staged.push(op.def);
      if (op.op === 'dropIndex') droppedKeys.add(indexDefKey(op.def));
    }
    const active = [
      ...this.uniqueEntries().filter((u) => !droppedKeys.has(indexDefKey(u.def))),
      ...staged.filter((d) => !droppedKeys.has(indexDefKey(d))).map((def) => ({ def, index: undefined })),
    ];
    if (active.length === 0) return;

    // Final state of every node the batch touches: null = deleted.
    type Sim = { labels: string[]; props: Record<string, unknown> } | null;
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
        if (v === undefined || !isScalar(v as never)) continue;
        claim(encodeKey(v as ScalarValue), id);
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
```

This needs one tiny accessor on `PropertyIndex` (in `packages/core/src/index/property-index.ts`):

```ts
  /** Exact postings by pre-encoded key — used by unique validation. */
  getExactByKey(key: string): ReadonlySet<NodeId> | undefined {
    return this.exact.get(key);
  }
```

In `packages/core/src/database.ts` `transact()`, insert between `if (ops.length === 0)` and `const batch = ...`:

```ts
      this.store.indexes.validateBatch(ops, this.store);
```

And add the accessor the tests use (kept by Task 10):

```ts
  listIndexes(): IndexDef[] {
    return this.store.indexes.defs();
  }
```

(import `IndexDef` as a type from `./types.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/constraints.test.ts packages/core/test/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): unique constraints validated before WAL append"
```

### Task 10: Index persistence (snapshots + recovery) and database-level API

**Files:**
- Modify: `packages/core/src/snapshot.ts`, `packages/core/src/database.ts`
- Test: `packages/core/test/index-persistence.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/index-persistence.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ixp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DEF = { kind: 'property', label: 'Person', property: 'born' } as const;

describe('index persistence', () => {
  it('recovers definitions and postings from WAL alone', async () => {
    const db = await openDatabase(dir);
    await db.createIndex(DEF);
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1815 }));
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect([...db2.lookupRange('Person', 'born', { gte: 1800 })]).toHaveLength(1);
    await db2.close();
  });

  it('recovers definitions through a snapshot, backfilled over snapshot nodes', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1791 }));
    await db.createIndex(DEF);
    await db.checkpoint();
    await db.transact((tx) => void tx.createNode(['Person'], { born: 1867 }));
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([DEF]);
    expect([...db2.lookupRange('Person', 'born', {})]).toHaveLength(2);
    await db2.close();
  });

  it('dropIndex persists too', async () => {
    const db = await openDatabase(dir);
    await db.createIndex(DEF);
    await db.dropIndex(DEF);
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.listIndexes()).toEqual([]);
    await db2.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/index-persistence.test.ts`
Expected: FAIL — `createIndex` is not a method on `AtlasDatabase` (and snapshots drop defs).

- [ ] **Step 3: Implement**

In `packages/core/src/snapshot.ts`: add to `SnapshotData`:

```ts
  /** Absent in pre-M2 snapshots — treat as []. */
  indexes?: IndexDef[];
```

(import `IndexDef` as a type), and in `encodeSnapshot` add to the literal:

```ts
    indexes: store.indexes.defs(),
```

In `packages/core/src/database.ts` `open()`, after the snapshot's nodes/edges loops (still inside the `if (state.snapshotSeq !== null)` block, after `maxEdgeId = ...`):

```ts
      for (const def of snap.indexes ?? []) store.applyOp({ op: 'createIndex', def });
```

(Backfill runs over the just-loaded nodes; WAL replay then maintains postings op-by-op, including any `createIndex`/`dropIndex` ops in the tail.)

Add the database-level API next to `listIndexes()`:

```ts
  createIndex(def: IndexDef): Promise<{ txId: number }> {
    return this.transact((tx) => tx.createIndex(def));
  }

  dropIndex(def: IndexDef): Promise<{ txId: number }> {
    return this.transact((tx) => tx.dropIndex(def));
  }

  /** undefined = no scalar index on (label, property); empty = indexed, no match. */
  lookupExact(label: string, property: string, value: ScalarValue): ReadonlySet<NodeId> | undefined {
    return this.store.indexes.lookupExact(label, property, value);
  }

  /** Throws NOT_FOUND if no scalar index exists. */
  lookupRange(label: string, property: string, q: RangeQuery): IterableIterator<NodeId> {
    return this.store.indexes.lookupRange(label, property, q);
  }

  /** undefined = no fulltext index on (label, property). */
  searchText(
    label: string,
    property: string,
    query: string,
    opts: { prefix?: boolean } = {},
  ): Set<NodeId> | undefined {
    return this.store.indexes.searchText(label, property, query, opts);
  }
```

(imports: `type ScalarValue` from `./index/keys.js`, `type RangeQuery` from `./index/property-index.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/index-persistence.test.ts packages/core/test/checkpoint.test.ts packages/core/test/crash.test.ts packages/core/test/property.test.ts`
Expected: PASS — persistence works and the M1 durability suites still hold with the registry in the apply path.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): persist index definitions through snapshots and WAL; db-level index API"
```

### Task 11: Read leases

Spec §4.4/§4.7: long reads hold the write queue (point-in-time consistency at zero copy cost), bounded by a time budget. Synchronous reads never need a lease — `applyBatch` is synchronous, so sync iteration cannot interleave with a commit.

**Files:**
- Modify: `packages/core/src/database.ts`
- Test: `packages/core/test/lease.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/lease.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-lease-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('read leases', () => {
  it('holds writes until released; reads still work during the lease', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    const lease = await db.acquireReadLease();
    let committed = false;
    const write = db.transact((tx) => void tx.createNode(['A'], {})).then(() => {
      committed = true;
    });
    await sleep(30);
    expect(committed).toBe(false); // write is buffered behind the lease
    expect(db.stats().nodeCount).toBe(1); // reads unaffected
    lease.release();
    await write;
    expect(committed).toBe(true);
    expect(db.stats().nodeCount).toBe(2);
    await db.close();
  });

  it('expires at the budget, marking the lease and letting writes through', async () => {
    const db = await openDatabase(dir);
    const lease = await db.acquireReadLease({ budgetMs: 40 });
    expect(lease.expired).toBe(false);
    await db.transact((tx) => void tx.createNode(['A'], {})); // resolves once budget expires
    expect(lease.expired).toBe(true);
    lease.release(); // releasing after expiry is a harmless no-op
    await db.close();
  });

  it('double release is a no-op and leases queue fairly with writes', async () => {
    const db = await openDatabase(dir);
    const l1 = await db.acquireReadLease();
    const order: string[] = [];
    const w = db.transact(() => void order.push('write'));
    const l2p = db.acquireReadLease().then((l) => {
      order.push('lease2');
      return l;
    });
    l1.release();
    l1.release();
    await w;
    const l2 = await l2p;
    expect(order).toEqual(['write', 'lease2']); // FIFO through the write queue
    l2.release();
    await db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/lease.test.ts`
Expected: FAIL — `acquireReadLease` is not a function.

- [ ] **Step 3: Implement in `packages/core/src/database.ts`**

Add the public type (top of file, after `OpenOptions`):

```ts
export interface ReadLease {
  /** Idempotent. Lets buffered writes proceed. */
  release(): void;
  /** True once the budget elapsed and the queue was force-released. */
  readonly expired: boolean;
}
```

Add the method (near `transact`):

```ts
  /**
   * Acquire a read lease: the write queue holds (writes buffer, nothing
   * applies) until release() or the budget elapses — whichever comes first.
   * Yielding readers (stream(), future algorithms) use this for a
   * point-in-time view; synchronous reads never need it.
   */
  acquireReadLease(opts: { budgetMs?: number } = {}): Promise<ReadLease> {
    const budgetMs = opts.budgetMs ?? 30_000;
    return new Promise<ReadLease>((resolveAcquire) => {
      void this.queue.run(
        () =>
          new Promise<void>((resolveHold) => {
            let expired = false;
            let done = false;
            const finish = (byExpiry: boolean): void => {
              if (done) return;
              done = true;
              expired = byExpiry;
              clearTimeout(timer);
              resolveHold();
            };
            const timer = setTimeout(() => finish(true), budgetMs);
            timer.unref();
            resolveAcquire({
              release: () => finish(false),
              get expired() {
                return expired;
              },
            });
          }),
      );
    });
  }
```

Note for `close()`: an unreleased lease delays `close()` until its budget expires — that is intentional (same contract as a long write); tests use small budgets.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/lease.test.ts packages/core/test/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): read leases — bounded write-queue holds for yielding readers"
```

### Task 12: Fluent traversal API — core node pipeline

Lazy generator pipeline over committed state. `where` predicates receive `(props, record)` so the spec's `p.born > 1800` shape works while labels/ids stay reachable.

**Files:**
- Create: `packages/core/src/traversal/traversal.ts`
- Modify: `packages/core/src/database.ts` (add `graph()`)
- Test: `packages/core/test/traversal.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/traversal.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let ids: Record<string, number>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-trav-'));
  db = await openDatabase(dir);
  ids = {};
  await db.transact((tx) => {
    ids.ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    ids.charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    ids.marie = tx.createNode(['Person'], { name: 'Marie', born: 1867 });
    ids.notes = tx.createNode(['Document'], { title: 'Notes', year: 1843 });
    ids.engine = tx.createNode(['Concept'], { name: 'Analytical Engine' });
    tx.createEdge('KNOWS', ids.ada, ids.charles);
    tx.createEdge('WROTE', ids.ada, ids.notes);
    tx.createEdge('CITES', ids.notes, ids.engine);
    tx.createEdge('INVENTED', ids.charles, ids.engine);
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('fluent traversal — nodes', () => {
  it('spec shape: nodes(label).where(props).out(type).toArray()', () => {
    const g = db.graph();
    const docs = g
      .nodes('Person')
      .where((p) => (p.born as number) > 1800)
      .out('WROTE')
      .toArray();
    expect(docs.map((d) => d.id)).toEqual([ids.notes]);
  });

  it('is lazy: limit() stops pulling from the source', () => {
    const g = db.graph();
    let predCalls = 0;
    const got = g
      .nodes('Person')
      .where(() => {
        predCalls++;
        return true;
      })
      .limit(1)
      .toArray();
    expect(got).toHaveLength(1);
    expect(predCalls).toBe(1);
  });

  it('out/in/both hop with optional type filter', () => {
    const g = db.graph();
    expect(g.node(ids.ada).out().count()).toBe(2);
    expect(g.node(ids.ada).out('KNOWS').toArray().map((n) => n.id)).toEqual([ids.charles]);
    expect(g.node(ids.engine).in().count()).toBe(2);
    expect(g.node(ids.charles).both().count()).toBe(2); // ada (in via KNOWS), engine (out)
  });

  it('dedup, skip, order, first, count compose', () => {
    const g = db.graph();
    // ada and charles both reach engine: notes->engine via cites? No — ada->notes->? two-hop;
    // use in()-side: engine.in() = [notes(CITES), charles(INVENTED)]
    const names = g
      .nodes('Person')
      .order((a, b) => (a.props.born as number) - (b.props.born as number))
      .toArray()
      .map((n) => n.props.name);
    expect(names).toEqual(['Charles', 'Ada', 'Marie']);
    expect(
      g.nodes('Person').order((a, b) => (a.props.born as number) - (b.props.born as number)).skip(1).first()?.props.name,
    ).toBe('Ada');
    expect(g.node(ids.ada).out().out().dedup().count()).toBe(1); // engine reached once via notes
    expect(g.nodes('Nope').count()).toBe(0);
  });

  it('node(id) of a missing id is an empty traversal', () => {
    expect(db.graph().node(999_999).toArray()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/traversal.test.ts`
Expected: FAIL — `graph` is not a function.

- [ ] **Step 3: Implement**

`packages/core/src/traversal/traversal.ts`:

```ts
import type { GraphStore } from '../store.js';
import type { EdgeRecord, NodeRecord, Props } from '../types.js';

/** Internal pipeline element: the current record plus the route that produced it. */
export interface Step<T> {
  value: T;
  path: { nodes: NodeRecord[]; edges: EdgeRecord[] };
}

export interface TraversalPath {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

type Source<T> = () => IterableIterator<Step<T>>;

function* mapIter<A, B>(it: IterableIterator<A>, f: (a: A) => B): IterableIterator<B> {
  for (const a of it) yield f(a);
}

abstract class BaseTraversal<T extends { id: number; props: Props }> {
  constructor(
    protected readonly store: GraphStore,
    protected readonly source: Source<T>,
  ) {}

  protected abstract clone(source: Source<T>): this;

  where(pred: (props: Props, record: T) => boolean): this {
    const src = this.source;
    return this.clone(function* () {
      for (const s of src()) if (pred(s.value.props, s.value)) yield s;
    });
  }

  dedup(): this {
    const src = this.source;
    return this.clone(function* () {
      const seen = new Set<number>();
      for (const s of src()) {
        if (seen.has(s.value.id)) continue;
        seen.add(s.value.id);
        yield s;
      }
    });
  }

  limit(n: number): this {
    const src = this.source;
    return this.clone(function* () {
      if (n <= 0) return;
      let count = 0;
      for (const s of src()) {
        yield s;
        if (++count >= n) return;
      }
    });
  }

  skip(n: number): this {
    const src = this.source;
    return this.clone(function* () {
      let count = 0;
      for (const s of src()) if (count++ >= n) yield s;
    });
  }

  /** Materializes the upstream — ordering cannot stream. */
  order(cmp: (a: T, b: T) => number): this {
    const src = this.source;
    return this.clone(function* () {
      yield* [...src()].sort((a, b) => cmp(a.value, b.value));
    });
  }

  toArray(): T[] {
    return [...mapIter(this.source(), (s) => s.value)];
  }

  first(): T | undefined {
    for (const s of this.source()) return s.value;
    return undefined;
  }

  count(): number {
    let n = 0;
    for (const _ of this.source()) n++;
    return n;
  }

  sum(sel: (record: T) => number): number {
    let total = 0;
    for (const s of this.source()) total += sel(s.value);
    return total;
  }

  min(sel: (record: T) => number): number | undefined {
    let best: number | undefined;
    for (const s of this.source()) {
      const v = sel(s.value);
      if (best === undefined || v < best) best = v;
    }
    return best;
  }

  max(sel: (record: T) => number): number | undefined {
    let best: number | undefined;
    for (const s of this.source()) {
      const v = sel(s.value);
      if (best === undefined || v > best) best = v;
    }
    return best;
  }

  avg(sel: (record: T) => number): number | undefined {
    let total = 0;
    let n = 0;
    for (const s of this.source()) {
      total += sel(s.value);
      n++;
    }
    return n === 0 ? undefined : total / n;
  }

  paths(): TraversalPath[] {
    return [...mapIter(this.source(), (s) => s.path)];
  }

  /** Internal: raw step iterator (stream() in a later task consumes this). */
  steps(): IterableIterator<Step<T>> {
    return this.source();
  }
}

export class NodeTraversal extends BaseTraversal<NodeRecord> {
  static fromIds(store: GraphStore, ids: () => Iterable<number>): NodeTraversal {
    return new NodeTraversal(store, function* () {
      for (const id of ids()) {
        const n = store.getNode(id);
        if (n) yield { value: n, path: { nodes: [n], edges: [] } };
      }
    });
  }

  protected clone(source: Source<NodeRecord>): this {
    return new NodeTraversal(this.store, source) as this;
  }

  private hop(dir: 'out' | 'in' | 'both', type?: string): NodeTraversal {
    const { store, source } = this;
    return new NodeTraversal(store, function* () {
      for (const s of source()) {
        const hops: { edge: EdgeRecord; nextId: number }[] = [];
        if (dir !== 'in')
          for (const e of store.outEdges(s.value.id, type)) hops.push({ edge: e, nextId: e.to });
        if (dir !== 'out')
          for (const e of store.inEdges(s.value.id, type)) hops.push({ edge: e, nextId: e.from });
        for (const h of hops) {
          const n = store.getNode(h.nextId)!;
          yield {
            value: n,
            path: { nodes: [...s.path.nodes, n], edges: [...s.path.edges, h.edge] },
          };
        }
      }
    });
  }

  out(type?: string): NodeTraversal {
    return this.hop('out', type);
  }

  in(type?: string): NodeTraversal {
    return this.hop('in', type);
  }

  both(type?: string): NodeTraversal {
    return this.hop('both', type);
  }

  outE(type?: string): EdgeTraversal {
    const { store, source } = this;
    return new EdgeTraversal(store, function* () {
      for (const s of source())
        for (const e of store.outEdges(s.value.id, type))
          yield { value: e, path: { nodes: s.path.nodes, edges: [...s.path.edges, e] } };
    });
  }

  inE(type?: string): EdgeTraversal {
    const { store, source } = this;
    return new EdgeTraversal(store, function* () {
      for (const s of source())
        for (const e of store.inEdges(s.value.id, type))
          yield { value: e, path: { nodes: s.path.nodes, edges: [...s.path.edges, e] } };
    });
  }
}

export class EdgeTraversal extends BaseTraversal<EdgeRecord> {
  constructor(store: GraphStore, source: Source<EdgeRecord>) {
    super(store, source);
  }

  protected clone(source: Source<EdgeRecord>): this {
    return new EdgeTraversal(this.store, source) as this;
  }

  /** Hop to each edge's source node. */
  fromNode(): NodeTraversal {
    return this.endpoint('from');
  }

  /** Hop to each edge's target node. */
  toNode(): NodeTraversal {
    return this.endpoint('to');
  }

  private endpoint(side: 'from' | 'to'): NodeTraversal {
    const { store, source } = this;
    return new NodeTraversal(store, function* () {
      for (const s of source()) {
        const n = store.getNode(s.value[side])!;
        yield { value: n, path: { nodes: [...s.path.nodes, n], edges: s.path.edges } };
      }
    });
  }
}

export class GraphView {
  constructor(private readonly store: GraphStore) {}

  /** All nodes, or all nodes with the given label (served by the label index). */
  nodes(label?: string): NodeTraversal {
    const store = this.store;
    return NodeTraversal.fromIds(store, () =>
      label === undefined ? store.nodes.keys() : store.nodeIdsByLabel(label),
    );
  }

  /** Single-node source; empty if the id does not exist. */
  node(id: number): NodeTraversal {
    return NodeTraversal.fromIds(this.store, () => [id]);
  }
}
```

(`BaseTraversal`'s constructor is public, so both subclasses are constructible across classes within the module — `EdgeTraversal.endpoint` builds `NodeTraversal`s and vice versa.)

In `packages/core/src/database.ts`, import and expose:

```ts
import { GraphView } from './traversal/traversal.js';
```

```ts
  /** Fluent traversal entry point over committed state. */
  graph(): GraphView {
    return new GraphView(this.store);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/traversal.test.ts`
Expected: PASS, including the laziness assertion (`predCalls === 1`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): fluent traversal API — lazy node/edge pipelines with paths"
```

### Task 13: Fluent traversal — index-backed sources, edge steps, paths

**Files:**
- Modify: `packages/core/src/traversal/traversal.ts` (extend `GraphView`)
- Test: `packages/core/test/traversal-extended.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/traversal-extended.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';
import { AtlasError } from '../src/errors.js';

let dir: string;
let db: AtlasDatabase;
let ids: Record<string, number>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-trav2-'));
  db = await openDatabase(dir);
  ids = {};
  await db.transact((tx) => {
    tx.createIndex({ kind: 'property', label: 'Person', property: 'born' });
    tx.createIndex({ kind: 'fulltext', label: 'Document', property: 'title' });
    ids.ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
    ids.charles = tx.createNode(['Person'], { name: 'Charles', born: 1791 });
    ids.notes = tx.createNode(['Document'], { title: 'Notes on the Analytical Engine' });
    tx.createEdge('WROTE', ids.ada, ids.notes, { year: 1843 });
    tx.createEdge('KNOWS', ids.ada, ids.charles, { since: 1833 });
  });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('index-backed sources', () => {
  it('nodesWhere serves exact and range queries from the index', () => {
    const g = db.graph();
    expect(g.nodesWhere('Person', 'born', 1815).toArray().map((n) => n.id)).toEqual([ids.ada]);
    expect(g.nodesWhere('Person', 'born', { lt: 1800 }).toArray().map((n) => n.id)).toEqual([
      ids.charles,
    ]);
  });

  it('nodesWhere without an index throws NOT_FOUND (no silent scans)', () => {
    expect(() => db.graph().nodesWhere('Person', 'name', 'Ada').toArray()).toThrowError(AtlasError);
  });

  it('search() rides the fulltext index, prefix mode included', () => {
    const g = db.graph();
    expect(g.search('Document', 'title', 'analytical engine').toArray().map((n) => n.id)).toEqual([
      ids.notes,
    ]);
    expect(g.search('Document', 'title', 'anal', { prefix: true }).count()).toBe(1);
    expect(() => g.search('Document', 'nope', 'x').toArray()).toThrowError(AtlasError);
  });
});

describe('edge steps and paths', () => {
  it('outE/where-on-edge-props/toNode composes', () => {
    const g = db.graph();
    const got = g
      .node(ids.ada)
      .outE()
      .where((p) => (p.year as number) === 1843)
      .toNode()
      .toArray();
    expect(got.map((n) => n.id)).toEqual([ids.notes]);
  });

  it('paths() returns the full route', () => {
    const paths = db.graph().node(ids.ada).out('WROTE').paths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.nodes.map((n) => n.id)).toEqual([ids.ada, ids.notes]);
    expect(paths[0]!.edges.map((e) => e.type)).toEqual(['WROTE']);
  });

  it('aggregations: sum/min/max/avg over selectors', () => {
    const people = db.graph().nodes('Person');
    expect(people.sum((n) => n.props.born as number)).toBe(3606);
    expect(people.min((n) => n.props.born as number)).toBe(1791);
    expect(people.max((n) => n.props.born as number)).toBe(1815);
    expect(people.avg((n) => n.props.born as number)).toBe(1803);
    expect(db.graph().nodes('Nope').avg((n) => 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/traversal-extended.test.ts`
Expected: FAIL — `nodesWhere`/`search` missing.

- [ ] **Step 3: Implement — extend `GraphView` in `packages/core/src/traversal/traversal.ts`**

Add imports at the top:

```ts
import { AtlasError } from '../errors.js';
import { isScalar, type ScalarValue } from '../index/keys.js';
import type { RangeQuery } from '../index/property-index.js';
```

Add to `GraphView`:

```ts
  /**
   * Index-backed source. Pass a scalar for exact match or a RangeQuery
   * ({gt/gte/lt/lte}) for ranges. Throws NOT_FOUND when (label, property) has
   * no scalar index — explicit beats a silent full scan.
   */
  nodesWhere(label: string, property: string, q: ScalarValue | RangeQuery): NodeTraversal {
    const store = this.store;
    if (typeof q === 'object' && !(q instanceof Date)) {
      return NodeTraversal.fromIds(store, () => store.indexes.lookupRange(label, property, q));
    }
    return NodeTraversal.fromIds(store, () => {
      const ids = store.indexes.lookupExact(label, property, q);
      if (ids === undefined)
        throw new AtlasError('NOT_FOUND', `no property index on ${label}.${property}`);
      return ids;
    });
  }

  /** Fulltext-backed source. Throws NOT_FOUND when (label, property) has no fulltext index. */
  search(
    label: string,
    property: string,
    query: string,
    opts: { prefix?: boolean } = {},
  ): NodeTraversal {
    const store = this.store;
    return NodeTraversal.fromIds(store, () => {
      const ids = store.indexes.searchText(label, property, query, opts);
      if (ids === undefined)
        throw new AtlasError('NOT_FOUND', `no fulltext index on ${label}.${property}`);
      return ids;
    });
  }
```

(`isScalar` guards the Date-vs-RangeQuery ambiguity: a `Date` is `typeof 'object'`, hence the explicit `instanceof` check above. If the imported `isScalar` ends up unused after writing this, drop the import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/traversal-extended.test.ts packages/core/test/traversal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): index-backed traversal sources, edge steps, paths, aggregations"
```

### Task 14: `stream()` — async traversal terminal under a read lease

The one traversal terminal that yields to the event loop, so it takes a read lease for point-in-time consistency and yields every `STREAM_YIELD_EVERY` items to keep the process responsive.

**Files:**
- Modify: `packages/core/src/traversal/traversal.ts`, `packages/core/src/database.ts`
- Test: `packages/core/test/stream.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/stream.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-stream-'));
  db = await openDatabase(dir);
  for (let batch = 0; batch < 3; batch++)
    await db.transact((tx) => {
      for (let i = 0; i < 1000; i++) tx.createNode(['N'], { i: batch * 1000 + i });
    });
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('stream()', () => {
  it('yields every node and sees a point-in-time view despite concurrent writes', async () => {
    // Acquire the lease FIRST (await the first element), then start the writer —
    // otherwise the write wins the queue race and the assertion is meaningless.
    const iter = db.graph().nodes('N').stream()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    let writeDone = false;
    const writer = db.transact((tx) => void tx.createNode(['N'], { i: 9999 })).then(() => {
      writeDone = true;
    });
    const seen: number[] = [(first.value as { id: number }).id];
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      seen.push((r.value as { id: number }).id);
      if (seen.length === 1500) expect(writeDone).toBe(false); // write buffered behind the lease
    }
    expect(seen).toHaveLength(3000); // the concurrent write is not visible to this stream
    await writer;
    expect(db.stats().nodeCount).toBe(3001);
  });

  it('releases the lease when the consumer breaks early', async () => {
    for await (const _ of db.graph().nodes('N').stream()) break;
    // If the lease leaked, this transact would block until the default budget.
    const before = Date.now();
    await db.transact((tx) => void tx.createNode(['N'], {}));
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('aborts with TIMEOUT when the budget expires mid-stream', async () => {
    const slow = db.graph().nodes('N').stream({ budgetMs: 30 });
    await expect(async () => {
      for await (const _ of slow) await new Promise((r) => setTimeout(r, 10));
    }).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/stream.test.ts`
Expected: FAIL — `stream` is not a function.

- [ ] **Step 3: Implement**

Traversals need the database's lease machinery, not just the store. Thread a lease factory through `GraphView` — in `packages/core/src/traversal/traversal.ts`:

```ts
export interface LeaseProvider {
  acquireReadLease(opts?: { budgetMs?: number }): Promise<{ release(): void; readonly expired: boolean }>;
}
```

Change `GraphView`'s constructor and `BaseTraversal` to carry it:

```ts
export class GraphView {
  constructor(
    private readonly store: GraphStore,
    private readonly leases: LeaseProvider,
  ) {}
  // every NodeTraversal.fromIds / new NodeTraversal call in GraphView passes `this.leases` as the
  // new third argument (update fromIds' signature: fromIds(store, leases, ids))
}
```

`BaseTraversal` gains the field and `stream()` (constructor becomes `(store, leases, source)` — update both subclasses and every construction site in this file accordingly):

```ts
const STREAM_YIELD_EVERY = 1000;

  async *stream(opts: { budgetMs?: number } = {}): AsyncIterableIterator<T> {
    const lease = await this.leases.acquireReadLease(opts);
    try {
      let sinceYield = 0;
      for (const s of this.source()) {
        if (lease.expired) throw new AtlasError('TIMEOUT', 'read lease budget exhausted mid-stream');
        yield s.value;
        if (++sinceYield >= STREAM_YIELD_EVERY) {
          sinceYield = 0;
          await new Promise((r) => setImmediate(r));
          if (lease.expired) throw new AtlasError('TIMEOUT', 'read lease budget exhausted mid-stream');
        }
      }
    } finally {
      lease.release();
    }
  }
```

(`AtlasError` is already imported after Task 13.) In `packages/core/src/database.ts`, `graph()` now passes the database itself as the lease provider:

```ts
  graph(): GraphView {
    return new GraphView(this.store, this);
  }
```

(`AtlasDatabase` already satisfies `LeaseProvider` structurally via Task 11's `acquireReadLease`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/stream.test.ts packages/core/test/traversal.test.ts packages/core/test/traversal-extended.test.ts packages/core/test/lease.test.ts`
Expected: PASS — including the early-break lease release (the `finally` in the generator runs on `break` via iterator `return()`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): leased async stream() traversal terminal with cooperative yields"
```

### Task 15: Schema introspection

Observed-schema statistics maintained incrementally in the same before-mutation hook pattern as indexes; recovery rebuilds them for free because snapshot load and WAL replay both go through `applyOp`.

**Files:**
- Create: `packages/core/src/schema.ts`
- Modify: `packages/core/src/store.ts`, `packages/core/src/database.ts`
- Test: `packages/core/test/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/schema.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-schema-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('schema introspection', () => {
  it('tracks labels, property types, and edge-type label distributions', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      const ada = tx.createNode(['Person'], { name: 'Ada', born: 1815 });
      const charles = tx.createNode(['Person'], { name: 'Charles' });
      const notes = tx.createNode(['Document'], { title: 'Notes', when: new Date(0) });
      tx.createEdge('WROTE', ada, notes);
      tx.createEdge('KNOWS', ada, charles);
    });
    const s = db.schema();
    const person = s.labels.find((l) => l.label === 'Person')!;
    expect(person.count).toBe(2);
    expect(person.properties.find((p) => p.property === 'name')?.types).toEqual({ string: 2 });
    expect(person.properties.find((p) => p.property === 'born')?.types).toEqual({ number: 1 });
    const doc = s.labels.find((l) => l.label === 'Document')!;
    expect(doc.properties.find((p) => p.property === 'when')?.types).toEqual({ datetime: 1 });
    const wrote = s.edgeTypes.find((t) => t.type === 'WROTE')!;
    expect(wrote.count).toBe(1);
    expect(wrote.from).toEqual({ Person: 1 });
    expect(wrote.to).toEqual({ Document: 1 });
    await db.close();
  });

  it('decrements on prop changes and deletes, pruning empty entries', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    let b = 0;
    await db.transact((tx) => {
      a = tx.createNode(['P'], { x: 1 });
      b = tx.createNode(['P'], { x: 'one' });
      tx.createEdge('T', a, b);
    });
    await db.transact((tx) => {
      tx.setNodeProps(a, {}, ['x']); // remove a's x
      tx.deleteNode(b, { detach: true }); // removes the edge and b
    });
    const s = db.schema();
    const p = s.labels.find((l) => l.label === 'P')!;
    expect(p.count).toBe(1);
    expect(p.properties).toEqual([]); // both x entries gone
    expect(s.edgeTypes).toEqual([]);
    await db.close();
  });

  it('rebuilds identically after reopen (snapshot + WAL)', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => {
      const n = tx.createNode(['A'], { k: 1, tags: ['x', 'y'] });
      tx.createEdge('R', n, n);
    });
    await db.checkpoint();
    await db.transact((tx) => void tx.createNode(['B'], { k: '2' }));
    const before = JSON.stringify(db.schema());
    await db.close();
    const db2 = await openDatabase(dir);
    expect(JSON.stringify(db2.schema())).toBe(before);
    await db2.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/schema.test.ts`
Expected: FAIL — `schema` is not a function.

- [ ] **Step 3: Implement**

`packages/core/src/schema.ts`:

```ts
import type { GraphStore } from './store.js';
import type { Op, PropertyValue } from './types.js';

export interface SchemaSummary {
  labels: {
    label: string;
    count: number;
    properties: { property: string; types: Record<string, number> }[];
  }[];
  edgeTypes: { type: string; count: number; from: Record<string, number>; to: Record<string, number> }[];
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
```

Wire into `packages/core/src/store.ts` — import, add the field, and call in `applyOp` right after the `indexes.beforeApply` line:

```ts
import { SchemaTracker } from './schema.js';
```

```ts
  readonly schema = new SchemaTracker();
```

```ts
    this.schema.beforeApply(op, this);
```

Edge-deletion subtlety: `deleteNode` with prior `deleteEdge` ops in the same batch is safe — by the time `deleteNode`'s hook runs, the edges were already applied (deleted) by earlier `applyOp` calls, so endpoint labels are decremented exactly once, at `deleteEdge` time, while both endpoints still exist.

In `packages/core/src/database.ts`:

```ts
  schema(): SchemaSummary {
    return this.store.schema.summary();
  }
```

(import `type SchemaSummary` from `./schema.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/schema.test.ts packages/core/test/property.test.ts packages/core/test/crash.test.ts`
Expected: PASS — property/crash suites confirm the tracker never desyncs or breaks recovery.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): incrementally maintained schema introspection"
```

### Task 16: Change feed

Bounded ring buffer of committed batches; subscriptions deliver asynchronously (microtask) so a slow handler never blocks `transact`. Spec §4.8: overflow sends `resync_required` and closes the subscription; `fromTxId` replays from the window when possible.

**Files:**
- Create: `packages/core/src/change-feed.ts`
- Modify: `packages/core/src/database.ts`
- Test: `packages/core/test/change-feed.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/change-feed.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeFeed, type ChangeEvent } from '../src/change-feed.js';
import { openDatabase } from '../src/database.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ChangeFeed unit', () => {
  it('delivers batches in order, asynchronously', async () => {
    const feed = new ChangeFeed(8);
    const got: number[] = [];
    feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    });
    feed.emit({ txId: 1, ops: [] });
    feed.emit({ txId: 2, ops: [] });
    expect(got).toEqual([]); // not synchronous
    await tick();
    expect(got).toEqual([1, 2]);
  });

  it('replays from fromTxId within the window', async () => {
    const feed = new ChangeFeed(8);
    feed.emit({ txId: 1, ops: [] });
    feed.emit({ txId: 2, ops: [] });
    feed.emit({ txId: 3, ops: [] });
    const got: number[] = [];
    feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    }, { fromTxId: 2 });
    await tick();
    expect(got).toEqual([2, 3]);
  });

  it('overflow evicts; lagging subscriber gets resync_required and is closed', async () => {
    const feed = new ChangeFeed(2);
    const events: ChangeEvent[] = [];
    feed.subscribe((e) => events.push(e));
    await tick(); // settle the empty subscription
    // Burst past capacity before the microtask drain runs:
    for (let txId = 1; txId <= 5; txId++) feed.emit({ txId, ops: [] });
    await tick();
    expect(events.some((e) => e.type === 'resync_required')).toBe(true);
    const before = events.length;
    feed.emit({ txId: 6, ops: [] });
    await tick();
    expect(events.length).toBe(before); // closed — no further deliveries
  });

  it('fromTxId older than the window resyncs immediately', async () => {
    const feed = new ChangeFeed(2);
    for (let txId = 1; txId <= 5; txId++) feed.emit({ txId, ops: [] });
    const events: ChangeEvent[] = [];
    feed.subscribe((e) => events.push(e), { fromTxId: 1 });
    await tick();
    expect(events).toEqual([{ type: 'resync_required' }]);
  });

  it('unsubscribe stops delivery', async () => {
    const feed = new ChangeFeed(8);
    const got: number[] = [];
    const unsub = feed.subscribe((e) => {
      if (e.type === 'batch') got.push(e.txId);
    });
    feed.emit({ txId: 1, ops: [] });
    await tick();
    unsub();
    feed.emit({ txId: 2, ops: [] });
    await tick();
    expect(got).toEqual([1]);
  });
});

describe('database integration', () => {
  it('subscribers observe committed batches with their ops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-feed-'));
    const db = await openDatabase(dir);
    const events: ChangeEvent[] = [];
    db.subscribe((e) => events.push(e));
    await db.transact((tx) => void tx.createNode(['A'], { hello: 'world' }));
    await tick();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('batch');
    if (e.type === 'batch') {
      expect(e.txId).toBe(1);
      expect(e.ops[0]).toMatchObject({ op: 'createNode', props: { hello: 'world' } });
    }
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/change-feed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/change-feed.ts`:

```ts
import type { CommittedBatch } from './types.js';

export type ChangeEvent =
  | { type: 'batch'; txId: number; ops: CommittedBatch['ops'] }
  | { type: 'resync_required' };

interface Subscription {
  handler: (e: ChangeEvent) => void;
  /** Next txId this subscriber expects. */
  cursor: number;
  closed: boolean;
  scheduled: boolean;
}

/**
 * Bounded in-process feed of committed batches. Delivery is asynchronous
 * (microtask) so handlers never block transact(). A subscriber whose cursor
 * falls out of the retained window receives one resync_required and is closed
 * — it must re-read current state and resubscribe.
 */
export class ChangeFeed {
  private readonly ring: CommittedBatch[] = [];
  private nextTxId = 1; // txId the NEXT emit is expected to carry
  private readonly subs = new Set<Subscription>();

  constructor(private readonly capacity = 1024) {}

  /** Oldest txId still retained, or nextTxId when the ring is empty. */
  private get oldest(): number {
    return this.nextTxId - this.ring.length;
  }

  emit(batch: CommittedBatch): void {
    this.nextTxId = batch.txId + 1;
    this.ring.push(batch);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const sub of this.subs) this.schedule(sub);
  }

  subscribe(handler: (e: ChangeEvent) => void, opts: { fromTxId?: number } = {}): () => void {
    const sub: Subscription = {
      handler,
      cursor: opts.fromTxId ?? this.nextTxId,
      closed: false,
      scheduled: false,
    };
    this.subs.add(sub);
    this.schedule(sub);
    return () => {
      sub.closed = true;
      this.subs.delete(sub);
    };
  }

  private schedule(sub: Subscription): void {
    if (sub.scheduled || sub.closed) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      this.drain(sub);
    });
  }

  private drain(sub: Subscription): void {
    if (sub.closed) return;
    if (sub.cursor < this.oldest) {
      sub.closed = true;
      this.subs.delete(sub);
      sub.handler({ type: 'resync_required' });
      return;
    }
    while (sub.cursor < this.nextTxId && !sub.closed) {
      const batch = this.ring[sub.cursor - this.oldest]!;
      sub.cursor++;
      sub.handler({ type: 'batch', txId: batch.txId, ops: batch.ops });
    }
  }
}
```

In `packages/core/src/database.ts`: add the field and wiring —

```ts
import { ChangeFeed, type ChangeEvent } from './change-feed.js';
```

```ts
  private readonly feed = new ChangeFeed();
```

In `transact()`, right after `this.lastTxId = batch.txId;`:

```ts
      this.feed.emit(batch);
```

And the public API:

```ts
  /**
   * Subscribe to committed batches. Delivery is asynchronous; on overflow the
   * subscriber receives one resync_required and is closed. Cursors are
   * per-process: after a restart, re-read state and subscribe fresh.
   */
  subscribe(handler: (e: ChangeEvent) => void, opts: { fromTxId?: number } = {}): () => void {
    return this.feed.subscribe(handler, opts);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/change-feed.test.ts packages/core/test/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): bounded change feed with cursors and resync protocol"
```

### Task 17: science-history dataset + loader

Curated core of real entities (people, concepts, documents, places with real relationships) expanded deterministically to ~500 nodes per spec §8. The loader uses **structural types only** — `@atlas/datasets` must NOT import `@atlas/core` (core already dev-depends on datasets; an import the other way creates a project-reference cycle).

**Files:**
- Create: `packages/datasets/src/science-history.ts`, `packages/datasets/src/load.ts`
- Modify: `packages/datasets/src/index.ts`
- Test: `packages/datasets/test/science-history.test.ts`, `packages/core/test/dataset-load.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/datasets/test/science-history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadDataset, type TxLike } from '../src/load.js';
import { scienceHistory } from '../src/science-history.js';

describe('scienceHistory', () => {
  it('is deterministic and hits the spec size (~500 nodes)', () => {
    const a = scienceHistory();
    const b = scienceHistory();
    expect(a).toEqual(b);
    expect(a.nodes).toHaveLength(500);
    expect(a.edges.length).toBeGreaterThan(900);
  });

  it('has valid endpoints and the expected label/edge vocabulary', () => {
    const g = scienceHistory();
    const labels = new Set(g.nodes.flatMap((n) => n.labels));
    expect(labels).toEqual(new Set(['Person', 'Concept', 'Document', 'Place']));
    const types = new Set(g.edges.map((e) => e.type));
    expect(types).toEqual(new Set(['WROTE', 'KNOWS', 'CITES', 'INFLUENCED', 'BORN_IN']));
    for (const e of g.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(g.nodes.length);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(g.nodes.length);
    }
  });

  it('contains the curated anchors', () => {
    const g = scienceHistory();
    const names = g.nodes.map((n) => n.props.name ?? n.props.title);
    expect(names).toContain('Ada Lovelace');
    expect(names).toContain('Notes on the Analytical Engine');
    expect(names).toContain('On the Origin of Species');
  });

  it('every WROTE edge goes Person -> Document', () => {
    const g = scienceHistory();
    for (const e of g.edges.filter((e) => e.type === 'WROTE')) {
      expect(g.nodes[e.from]!.labels).toContain('Person');
      expect(g.nodes[e.to]!.labels).toContain('Document');
    }
  });
});

describe('loadDataset', () => {
  it('replays nodes then edges through the tx interface in insertion order', async () => {
    const g = scienceHistory();
    const calls: string[] = [];
    let nextId = 1;
    const fakeTx: TxLike = {
      createNode: () => {
        calls.push('node');
        return nextId++;
      },
      createEdge: () => {
        calls.push('edge');
        return nextId++;
      },
    };
    const ids = await loadDataset({ transact: async (fn) => void fn(fakeTx) }, g);
    expect(ids).toHaveLength(g.nodes.length);
    expect(calls.filter((c) => c === 'node')).toHaveLength(g.nodes.length);
    expect(calls.filter((c) => c === 'edge')).toHaveLength(g.edges.length);
    expect(calls.indexOf('edge')).toBeGreaterThan(g.nodes.length - 1); // all nodes first
  });
});
```

`packages/core/test/dataset-load.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

describe('science-history into a real database', () => {
  it('loads, traverses, and shows up in the schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-scihist-'));
    const db = await openDatabase(dir, { fsync: { intervalMs: 1000 } }); // bulk load: no per-batch fsync
    const graph = scienceHistory();
    await loadDataset(db, graph);
    expect(db.stats().nodeCount).toBe(500);

    const g = db.graph();
    const ada = g
      .nodes('Person')
      .where((p) => p.name === 'Ada Lovelace')
      .first();
    expect(ada).toBeDefined();
    expect(g.node(ada!.id).out('WROTE').count()).toBeGreaterThan(0);

    const schema = db.schema();
    expect(schema.labels.map((l) => l.label)).toEqual(['Concept', 'Document', 'Person', 'Place']);
    expect(schema.edgeTypes.find((t) => t.type === 'WROTE')!.from).toEqual(
      expect.objectContaining({ Person: expect.any(Number) }),
    );
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/datasets/test/science-history.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/datasets/src/science-history.ts`:

```ts
import { mulberry32 } from './random.js';

export interface DatasetNode {
  labels: string[];
  props: Record<string, string | number>;
}

export interface DatasetEdge {
  from: number; // index into nodes
  to: number;
  type: string;
  props?: Record<string, string | number>;
}

export interface DatasetGraph {
  nodes: DatasetNode[];
  edges: DatasetEdge[];
}

const PEOPLE: [name: string, born: number, field: string][] = [
  ['Ada Lovelace', 1815, 'mathematics'],
  ['Charles Babbage', 1791, 'mathematics'],
  ['Charles Darwin', 1809, 'biology'],
  ['Marie Curie', 1867, 'physics'],
  ['Pierre Curie', 1859, 'physics'],
  ['James Clerk Maxwell', 1831, 'physics'],
  ['Michael Faraday', 1791, 'physics'],
  ['Isaac Newton', 1643, 'physics'],
  ['Gottfried Leibniz', 1646, 'mathematics'],
  ['Leonhard Euler', 1707, 'mathematics'],
  ['Carl Friedrich Gauss', 1777, 'mathematics'],
  ['Mary Somerville', 1780, 'astronomy'],
  ['John Herschel', 1792, 'astronomy'],
  ['Gregor Mendel', 1822, 'biology'],
  ['Louis Pasteur', 1822, 'biology'],
  ['Dmitri Mendeleev', 1834, 'chemistry'],
  ['Antoine Lavoisier', 1743, 'chemistry'],
  ['Alan Turing', 1912, 'computer science'],
  ['Kurt Gödel', 1906, 'logic'],
  ['Emmy Noether', 1882, 'mathematics'],
  ['Bernhard Riemann', 1826, 'mathematics'],
  ['George Boole', 1815, 'logic'],
  ['Augusta De Morgan', 1806, 'logic'],
  ['Lise Meitner', 1878, 'physics'],
];

const CONCEPTS = [
  'Analytical Engine',
  'Natural Selection',
  'Radioactivity',
  'Electromagnetism',
  'Calculus',
  'Number Theory',
  'Computability',
  'Genetics',
  'Periodic Table',
  'Boolean Algebra',
  'Abstract Algebra',
  'Nuclear Fission',
];

const DOCUMENTS: [title: string, year: number, authorIdx: number][] = [
  ['Notes on the Analytical Engine', 1843, 0],
  ['On the Economy of Machinery', 1832, 1],
  ['On the Origin of Species', 1859, 2],
  ['Recherches sur les substances radioactives', 1903, 3],
  ['A Treatise on Electricity and Magnetism', 1873, 5],
  ['Experimental Researches in Electricity', 1839, 6],
  ['Philosophiæ Naturalis Principia Mathematica', 1687, 7],
  ['Disquisitiones Arithmeticae', 1801, 10],
  ['On the Connexion of the Physical Sciences', 1834, 11],
  ['Experiments on Plant Hybridization', 1866, 13],
  ['On the Periodic Law', 1869, 15],
  ['On Computable Numbers', 1936, 17],
  ['An Investigation of the Laws of Thought', 1854, 21],
  ['Idealtheorie in Ringbereichen', 1921, 19],
];

const PLACES = ['London', 'Paris', 'Cambridge', 'Edinburgh', 'Berlin', 'Vienna', 'Warsaw', 'Basel'];

const BORN_IN: [personIdx: number, placeIdx: number][] = [
  [0, 0], [1, 0], [3, 6], [4, 1], [6, 0], [7, 2], [9, 7], [11, 3], [18, 5], [19, 4],
];

const KNOWS: [number, number][] = [
  [0, 1], [0, 11], [0, 22], [1, 12], [1, 11], [3, 4], [5, 6], [21, 22], [13, 14], [23, 19],
];

const INFLUENCED: [fromIdx: number, toIdx: number][] = [
  [7, 9], [8, 9], [9, 10], [10, 20], [1, 0], [6, 5], [21, 18], [21, 17], [2, 13], [16, 15], [19, 20],
];

// Document -> Concept citations from the curated core.
const DOC_CITES_CONCEPT: [docIdx: number, conceptIdx: number][] = [
  [0, 0], [0, 6], [2, 1], [3, 2], [4, 3], [5, 3], [6, 4], [7, 5], [9, 7], [10, 8], [11, 6], [12, 9], [13, 10],
];

const TARGET_NODES = 500;

/**
 * Deterministic build: a curated core of real entities, expanded with
 * generated period documents (correspondence and lectures attributed to the
 * curated people, citing curated concepts/documents) up to exactly
 * TARGET_NODES nodes. Same output on every call.
 */
export function scienceHistory(): DatasetGraph {
  const nodes: DatasetNode[] = [];
  const edges: DatasetEdge[] = [];

  const personBase = nodes.length;
  for (const [name, born, field] of PEOPLE) nodes.push({ labels: ['Person'], props: { name, born, field } });
  const conceptBase = nodes.length;
  for (const name of CONCEPTS) nodes.push({ labels: ['Concept'], props: { name } });
  const docBase = nodes.length;
  for (const [title, year] of DOCUMENTS) nodes.push({ labels: ['Document'], props: { title, year } });
  const placeBase = nodes.length;
  for (const name of PLACES) nodes.push({ labels: ['Place'], props: { name } });

  for (const [d, [, , authorIdx]] of DOCUMENTS.entries())
    edges.push({ from: personBase + authorIdx, to: docBase + d, type: 'WROTE' });
  for (const [p, place] of BORN_IN) edges.push({ from: personBase + p, to: placeBase + place, type: 'BORN_IN' });
  for (const [a, b] of KNOWS) edges.push({ from: personBase + a, to: personBase + b, type: 'KNOWS' });
  for (const [a, b] of INFLUENCED)
    edges.push({ from: personBase + a, to: personBase + b, type: 'INFLUENCED' });
  for (const [d, c] of DOC_CITES_CONCEPT)
    edges.push({ from: docBase + d, to: conceptBase + c, type: 'CITES' });

  // Deterministic expansion: generated documents until TARGET_NODES.
  const rand = mulberry32(11);
  const pick = (n: number): number => Math.floor(rand() * n);
  let serial = 1;
  while (nodes.length < TARGET_NODES) {
    const author = pick(PEOPLE.length);
    const [authorName, authorBorn] = PEOPLE[author]!;
    const kind = rand() < 0.5 ? 'Letter' : 'Lecture';
    const concept = pick(CONCEPTS.length);
    const year = authorBorn + 25 + pick(35);
    const idx = nodes.length;
    nodes.push({
      labels: ['Document'],
      props: { title: `${kind} ${serial++} of ${authorName} on ${CONCEPTS[concept]!}`, year },
    });
    edges.push({ from: personBase + author, to: idx, type: 'WROTE' });
    edges.push({ from: idx, to: conceptBase + concept, type: 'CITES' });
    if (rand() < 0.6)
      edges.push({ from: idx, to: docBase + pick(DOCUMENTS.length), type: 'CITES' });
  }

  return { nodes, edges };
}
```

`packages/datasets/src/load.ts`:

```ts
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
```

Update `packages/datasets/src/index.ts`:

```ts
export { generateGraph } from './generator.js';
export type { GeneratedGraph, GenEdge, GenNode, GeneratorOptions } from './generator.js';
export { loadDataset, type DbLike, type TxLike } from './load.js';
export { mulberry32 } from './random.js';
export {
  scienceHistory,
  type DatasetEdge,
  type DatasetGraph,
  type DatasetNode,
} from './science-history.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/datasets/test/science-history.test.ts packages/core/test/dataset-load.test.ts`
Expected: PASS (`pnpm build` first so `@atlas/datasets` dist exists for the core-side import). The KNOWS/INFLUENCED index pairs reference the PEOPLE array — if an index is out of range the endpoint test fails loudly; fix the table, not the test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(datasets): curated science-history dataset with deterministic expansion + loader"
```

### Task 18: Public exports, README, full gate

**Files:**
- Modify: `packages/core/src/index.ts`, `README.md`

- [ ] **Step 1: Extend the public surface**

Replace `packages/core/src/index.ts` with:

```ts
export { ChangeFeed, type ChangeEvent } from './change-feed.js';
export {
  AtlasDatabase,
  openDatabase,
  type OpenOptions,
  type ReadLease,
} from './database.js';
export { AtlasError, type AtlasErrorCode } from './errors.js';
export { type RangeQuery } from './index/btree.js';
export { type ScalarValue } from './index/keys.js';
export { type SchemaSummary } from './schema.js';
export { GraphStore } from './store.js';
export {
  EdgeTraversal,
  GraphView,
  NodeTraversal,
  type TraversalPath,
} from './traversal/traversal.js';
export { TxBuilder } from './tx.js';
export {
  validateIndexDef,
  validateProps,
  type CommittedBatch,
  type EdgeId,
  type EdgeRecord,
  type IndexDef,
  type IndexKind,
  type NodeId,
  type NodeRecord,
  type Op,
  type Primitive,
  type Props,
  type PropertyValue,
} from './types.js';
```

- [ ] **Step 2: Update the README status block**

In `README.md`, change the `**Status:**` line to:

```markdown
**Status:** M2 — indexes (exact/range/full-text), unique constraints, fluent
traversal API with leased streaming, schema introspection, change feed,
science-history dataset.
```

- [ ] **Step 3: Full gate + bench smoke**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green.

Run: `SCALE=0.01 node --expose-gc --import tsx packages/core/bench/storage.bench.ts`
Expected: exits 0 — confirms the registry/schema hooks in the apply path didn't wreck write throughput (expect some slowdown vs M1; anything above ~30% off the M1 numbers at this scale deserves a look before committing).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): export M2 public surface; README status"
```

---

## Plan self-review notes

- **Spec coverage:** §4.5 indexes/constraints/DDL-rebuild → Tasks 4–10; §4.2 label layout → Task 3; §4.4+§4.7 read-lease mechanism → Tasks 11, 14; §4.6 schema → Task 15; §4.8 change feed (ring, cursors, resync) → Task 16; §5.1 fluent surface (`nodes/where/out/in/both/outE/inE/dedup/limit/skip/path/order`, aggregations, `toArray/first/count/stream`) → Tasks 12–14; §8 science-history → Task 17; M1-review carry-overs (dir fsync, test typecheck) → Tasks 1–2.
- **Deliberate additions beyond the spec's literal step list** (spec reviewers: these are in-plan, not scope creep): `fromNode()/toNode()` on edge traversals (without them `outE` is a dead end), `nodesWhere`/`search` index-backed sources (explicit index use until the M4 planner arrives), `node(id)` source, `paths()` terminal naming for the spec's `path()` step.
- **Known simplifications (documented, intentional):** node-property indexes only (no edge indexes); B+ tree deletes don't rebalance (checkpoint reload rebuilds tight trees); `order()` materializes upstream; `stream()` paths carry O(path-length) copies per hop; change-feed cursors are per-process (spec §4.8 — server reconnect semantics arrive in M5); fulltext prefix list rebuilds lazily after token-set changes.
- **Type anchors for implementers:** registry/schema hooks are `beforeApply(op, store)` called BEFORE the store mutates; `Op` gains exactly `createIndex`/`dropIndex` with an `IndexDef` payload; `lookupExact → ReadonlySet | undefined` vs `lookupRange → throws NOT_FOUND` vs `searchText → Set | undefined` (deliberate asymmetry: range scans must never silently degrade); traversal constructors are `(store, leases, source)` after Task 14 refactors Task 12's `(store, source)` — Task 14 explicitly owns that signature change.






