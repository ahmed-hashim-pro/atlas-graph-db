# Atlas M3 — Algorithms Implementation Plan

**Goal:** Implement the spec §4.7 algorithm set as `db.algo.*` — BFS/DFS, Dijkstra/A* shortest paths, all-shortest-paths, degree, weak/strong components, topological sort, cycle detection, PageRank, Louvain communities, Brandes betweenness with sampling — all running under read leases with cooperative yielding and time budgets; plus the two M2-review carry-overs (deep index/schema invariants, randomized DDL coverage).

**Architecture:** Each algorithm is a standalone pure-ish function `(store, ticker, opts)` in `packages/core/src/algo/`, unit-testable without leases; the `AlgoFacade` (reached as `db.algo`) wraps every call in `withAlgoLease` — one read lease per invocation, a `Ticker` that yields to the event loop every N operations and aborts with `TIMEOUT` when the lease budget expires. Algorithms are read-only by contract: calling `db.transact` inside one deadlocks until the budget expires (documented).

**Tech Stack:** Existing stack (TypeScript strict ESM, Vitest, fast-check). No new dependencies; the binary heap is hand-built.

**Spec:** `docs/design/specs/2026-06-10-atlas-graph-platform-design.md` §4.7 (algorithm set, leases, yielding, Brandes guard), §5.2 CALL signature table (parameter names and YIELD columns are normative for the facade), §12 M3.

**Existing code anchors:** `acquireReadLease`/`ReadLease` in `packages/core/src/database.ts`; `LeaseProvider` in `src/traversal/traversal.ts`; `GraphStore.outEdges/inEdges/degree/nodes/edges` in `src/store.ts`; `IndexRegistry` in `src/index/registry.ts` (private `entries: Map<string, Entry>` where `Entry = { def, property?, fulltext? }`); `SchemaTracker` in `src/schema.ts`; property suite actions in `test/property.test.ts`; crash fixture `test/fixtures/crash-writer.ts`.

---

## File structure

```
packages/core/src/
  store.ts                MODIFY: checkInvariants() also calls indexes/schema deep checks
  index/registry.ts       MODIFY: add checkInvariants(store)
  index/fulltext.ts       MODIFY: add postingEntries() introspection for invariants
  schema.ts               MODIFY: add checkInvariants(store) (rebuild-and-compare)
  database.ts             MODIFY: add `algo` getter
  index.ts                MODIFY: export algo public surface
  algo/heap.ts            NEW: MinHeap
  algo/runner.ts          NEW: AlgoOptions, Ticker, withAlgoLease, neighbors()
  algo/traverse.ts        NEW: bfs, dfs, degree
  algo/shortest-path.ts   NEW: shortestPath (Dijkstra/A*), allShortestPaths
  algo/components.ts      NEW: weak (BFS) + strong (iterative Tarjan)
  algo/dag.ts             NEW: topoSort, cycles
  algo/pagerank.ts        NEW
  algo/louvain.ts         NEW
  algo/betweenness.ts     NEW: Brandes, exact-guard + deterministic sampling
  algo/facade.ts          NEW: AlgoFacade — lease-wrapped delegation, CALL-table signatures

packages/core/test/
  invariants-deep.test.ts NEW (Task 1)
  property.test.ts        MODIFY (Task 2: DDL actions)
  fixtures/crash-writer.ts MODIFY (Task 2: create an index)
  crash.test.ts           MODIFY (Task 2: assert index survives)
  heap.test.ts, algo-traverse.test.ts, algo-paths.test.ts, algo-components.test.ts,
  algo-dag.test.ts, algo-pagerank.test.ts, algo-louvain.test.ts,
  algo-betweenness.test.ts, algo-dataset.test.ts   NEW (one per task)

packages/core/bench/algo.bench.ts  NEW (Task 11)
.github/workflows/nightly.yml      MODIFY (Task 11: run algo bench)
```

Conventions carried from M0–M2: ESM imports use `.js` extensions; commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never run bare `vitest` (always `pnpm vitest run`).

---

### Task 1: Deep invariants — index postings and schema counters (M2 carry-over)

`GraphStore.checkInvariants()` cross-checks adjacency and the label index but a registry/schema hook desync would slip through. Add recompute-and-compare passes.

**Files:**
- Modify: `packages/core/src/index/registry.ts`, `packages/core/src/index/fulltext.ts`, `packages/core/src/schema.ts`, `packages/core/src/store.ts`
- Test: `packages/core/test/invariants-deep.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/invariants-deep.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/store.js';
import type { NodeId } from '../src/types.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createIndex', def: { kind: 'property', label: 'P', property: 'v' } });
  s.applyOp({ op: 'createIndex', def: { kind: 'fulltext', label: 'P', property: 'text' } });
  s.applyOp({ op: 'createIndex', def: { kind: 'unique', label: 'P', property: 'u' } });
  s.applyOp({ op: 'createNode', id: 1, labels: ['P'], props: { v: 5, text: 'graph theory', u: 'a' } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['P'], props: { v: 7, text: 'graph algebra', u: 'b' } });
  s.applyOp({ op: 'createEdge', id: 1, type: 'T', from: 1, to: 2, props: {} });
  return s;
}

describe('deep invariants', () => {
  it('pass on a healthy store with all index kinds populated', () => {
    expect(() => seeded().checkInvariants()).not.toThrow();
  });

  it('pass after mutations that exercise the maintenance hooks', () => {
    const s = seeded();
    s.applyOp({ op: 'setNodeProps', id: 1, set: { v: 9, text: 'lattice theory' }, remove: ['u'] });
    s.applyOp({ op: 'deleteEdge', id: 1 });
    s.applyOp({ op: 'deleteNode', id: 2 });
    expect(() => s.checkInvariants()).not.toThrow();
  });

  it('catch a property-index posting desync', () => {
    const s = seeded();
    const set = s.indexes.lookupExact('P', 'v', 5) as Set<NodeId>;
    set.delete(1); // simulate a hook bug corrupting the live posting
    expect(() => s.checkInvariants()).toThrow(/index/);
  });

  it('catch a fulltext posting desync', () => {
    const s = seeded();
    // Remove a value the node still carries — postings now disagree with the store.
    s.indexes.searchText('P', 'text', 'graph'); // sanity: token exists
    const entries = [...s.indexes.defs()];
    expect(entries.some((d) => d.kind === 'fulltext')).toBe(true);
    // Corrupt via the maintenance API itself: double-remove leaves postings short.
    s.indexes.beforeApply(
      { op: 'setNodeProps', id: 2, set: {}, remove: ['text'] },
      s,
    );
    expect(() => s.checkInvariants()).toThrow(/fulltext|index/);
  });

  it('catch a schema counter desync', () => {
    const s = seeded();
    // Fire a hook for a node the store never applied — counters drift from reality.
    s.schema.beforeApply({ op: 'createNode', id: 99, labels: ['P'], props: { v: 1 } }, s);
    expect(() => s.checkInvariants()).toThrow(/schema/);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/invariants-deep.test.ts`
Expected: the two desync tests FAIL (nothing throws — `checkInvariants` doesn't see postings yet). The healthy-store tests pass already.

- [x] **Step 3: Implement**

In `packages/core/src/index/fulltext.ts`, add introspection (below `tokenCount`):

```ts
  /** Token -> per-node occurrence counts. Read-only introspection for invariant checks. */
  *postingEntries(): IterableIterator<[string, ReadonlyMap<NodeId, number>]> {
    yield* this.postings.entries();
  }
```

In `packages/core/src/index/registry.ts`, add to `IndexRegistry`:

```ts
  /**
   * Recompute-and-compare deep check: every entry's postings must equal what
   * a fresh backfill over the store would produce. O(nodes x defs) — used by
   * tests and the property/crash suites, not the hot path.
   */
  checkInvariants(store: GraphStore): void {
    for (const entry of this.entries.values()) {
      const { def } = entry;
      if (entry.property) {
        const expected = new PropertyIndex();
        for (const n of store.nodesByLabel(def.label)) {
          const v = n.props[def.property];
          if (v !== undefined) expected.add(v, n.id);
        }
        if (expected.size !== entry.property.size)
          throw new AtlasError(
            'INTERNAL',
            `index ${indexDefKey(def)}: ${entry.property.size} postings, expected ${expected.size}`,
          );
        for (const n of store.nodesByLabel(def.label)) {
          const v = n.props[def.property];
          if (v === undefined || !isScalar(v)) continue;
          if (!entry.property.getExact(v)?.has(n.id))
            throw new AtlasError(
              'INTERNAL',
              `index ${indexDefKey(def)}: missing posting for node ${n.id}`,
            );
        }
      }
      if (entry.fulltext) {
        const expected = new FulltextIndex();
        for (const n of store.nodesByLabel(def.label)) {
          const v = n.props[def.property];
          if (v !== undefined) expected.add(v, n.id);
        }
        const live = new Map([...entry.fulltext.postingEntries()]);
        const want = new Map([...expected.postingEntries()]);
        if (live.size !== want.size)
          throw new AtlasError(
            'INTERNAL',
            `fulltext ${indexDefKey(def)}: ${live.size} tokens, expected ${want.size}`,
          );
        for (const [token, wantNodes] of want) {
          const liveNodes = live.get(token);
          if (!liveNodes || liveNodes.size !== wantNodes.size)
            throw new AtlasError('INTERNAL', `fulltext ${indexDefKey(def)}: token "${token}" postings diverge`);
          for (const [id, count] of wantNodes)
            if (liveNodes.get(id) !== count)
              throw new AtlasError(
                'INTERNAL',
                `fulltext ${indexDefKey(def)}: token "${token}" count diverges for node ${id}`,
              );
        }
      }
    }
  }
```

In `packages/core/src/schema.ts`, add to `SchemaTracker`:

```ts
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
```

(`schema.ts` must import `AtlasError` from `./errors.js` — add it.)

In `packages/core/src/store.ts`, append to the END of `checkInvariants()`:

```ts
    this.indexes.checkInvariants(this);
    this.schema.checkInvariants(this);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/invariants-deep.test.ts packages/core/test/property.test.ts packages/core/test/crash.test.ts packages/core/test/registry.test.ts`
Expected: PASS — the property and crash suites now implicitly deep-check on every run (they call `checkInvariants`); if any of them fail, a REAL hook desync existed — investigate before papering over.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): deep invariant checks for index postings and schema counters"
```

### Task 2: Randomized DDL coverage in property and crash suites (M2 carry-over)

**Files:**
- Modify: `packages/core/test/property.test.ts`, `packages/core/test/fixtures/crash-writer.ts`, `packages/core/test/crash.test.ts`

- [x] **Step 1: Extend the property-test action union**

In `packages/core/test/property.test.ts`, replace the `Action` type and `actionArb` with:

```ts
type Action =
  | { kind: 'addNode' }
  | { kind: 'addEdge'; fromPick: number; toPick: number }
  | { kind: 'setProps'; pick: number }
  | { kind: 'delEdge'; pick: number }
  | { kind: 'delNode'; pick: number }
  | { kind: 'ddl'; which: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ kind: 'addNode' }),
  fc.record({ kind: fc.constant('addEdge' as const), fromPick: fc.nat(99), toPick: fc.nat(99) }),
  fc.record({ kind: fc.constant('setProps' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delEdge' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delNode' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('ddl' as const), which: fc.nat(5) }),
);
```

In `applyActions`, add the `ddl` case to the switch (inside the `db.transact` callback). The six variants toggle each index kind on the `('N','v')` pair — create if `which` is even, drop if odd:

```ts
          case 'ddl': {
            const defs = [
              { kind: 'property', label: 'N', property: 'v' },
              { kind: 'fulltext', label: 'N', property: 'v' },
              { kind: 'unique', label: 'N', property: 'v' },
            ] as const;
            const def = defs[a.which % 3]!;
            const exists = db.listIndexes().some(
              (d) => d.kind === def.kind && d.label === def.label && d.property === def.property,
            );
            if (a.which < 3 && !exists) tx.createIndex(def);
            else if (a.which >= 3 && exists) tx.dropIndex(def);
            break;
          }
```

Notes for the implementer: `setProps` writes `{ v: a.pick }` (numbers) so unique constraints WILL sometimes reject a transact — the existing `.catch(() => undefined)` already treats rejected batches as no-ops, which is exactly right (rollback must leave invariants intact, and the deep checks from Task 1 verify that). Also extend the reopen-equality assertion to defs: after reopening as `db2`, add:

```ts
          if (JSON.stringify(db2.listIndexes()) !== JSON.stringify(db.listIndexes()))
            throw new Error('reopen index defs mismatch');
```

(Capture `db.listIndexes()` into a `defsBefore` variable **before** `db.close()`, mirroring how `before` captures stats.)

- [x] **Step 2: Run the property suite**

Run: `pnpm vitest run packages/core/test/property.test.ts`
Expected: PASS in a few minutes. A failure here is a shrunk counterexample exposing a real registry/recovery bug — debug it (most likely suspects: unique-rejection rollback paths or drop-then-create within one batch), never weaken the property.

- [x] **Step 3: Add an index to the crash fixture**

In `packages/core/test/fixtures/crash-writer.ts`, after `const db = await openDatabase(...)`:

```ts
if (db.listIndexes().length === 0)
  await db.createIndex({ kind: 'property', label: 'Crash', property: 'payload' });
```

In `packages/core/test/crash.test.ts`, after the `(db as unknown as { store: GraphStore }).store.checkInvariants();` line — which since M1 may instead read `db.checkInvariants();` (use whichever the file currently has as the anchor) — add:

```ts
    expect(db.listIndexes()).toHaveLength(1);
```

- [x] **Step 4: Run the crash suite**

Run: `pnpm vitest run packages/core/test/crash.test.ts`
Expected: PASS — five SIGKILL cycles now recover index definitions and deep-validate postings every time.

- [x] **Step 5: Full gate, then commit**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green.

```bash
git add -A
git commit -m "test(core): randomized index DDL in property suite; crash fixture carries an index"
```

### Task 3: Algorithm infrastructure — MinHeap, Ticker, withAlgoLease, neighbors

**Files:**
- Create: `packages/core/src/algo/heap.ts`, `packages/core/src/algo/runner.ts`
- Test: `packages/core/test/heap.test.ts`, runner behavior is covered inside `packages/core/test/algo-traverse.test.ts` (Task 4) — heap gets its own tests now.

- [x] **Step 1: Write the failing heap tests**

`packages/core/test/heap.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MinHeap } from '../src/algo/heap.js';

describe('MinHeap', () => {
  it('pops in ascending key order', () => {
    const h = new MinHeap<string>();
    h.push(5, 'five');
    h.push(1, 'one');
    h.push(3, 'three');
    expect(h.pop()).toEqual({ key: 1, value: 'one' });
    expect(h.pop()).toEqual({ key: 3, value: 'three' });
    expect(h.pop()).toEqual({ key: 5, value: 'five' });
    expect(h.pop()).toBeUndefined();
    expect(h.size).toBe(0);
  });

  it('matches a sorted reference under random pushes (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 300 }), (keys) => {
        const h = new MinHeap<number>();
        for (const k of keys) h.push(k, k);
        const out: number[] = [];
        for (let p = h.pop(); p !== undefined; p = h.pop()) out.push(p.key);
        expect(out).toEqual([...keys].sort((a, b) => a - b));
      }),
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/heap.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`packages/core/src/algo/heap.ts`:

```ts
export class MinHeap<T> {
  private readonly keys: number[] = [];
  private readonly values: T[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: T): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { key: number; value: T } | undefined {
    if (this.keys.length === 0) return undefined;
    const top = { key: this.keys[0]!, value: this.values[0]! };
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
  }
}
```

`packages/core/src/algo/runner.ts`:

```ts
import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { LeaseProvider } from '../traversal/traversal.js';
import type { EdgeRecord, NodeId } from '../types.js';

export interface AlgoOptions {
  /** Read-lease budget; the algorithm aborts with TIMEOUT when it elapses. Default 30s. */
  budgetMs?: number;
}

export type Direction = 'out' | 'in' | 'both';

export interface PathResult {
  nodes: NodeId[];
  edges: number[];
}

const YIELD_EVERY = 10_000;

/** Cooperative-yield ticker bound to a lease. Call tick() once per unit of work. */
export class Ticker {
  private count = 0;

  constructor(private readonly lease: { release(): void; readonly expired: boolean }) {}

  async tick(): Promise<void> {
    if (this.lease.expired) throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
    if (++this.count % YIELD_EVERY !== 0) return;
    await new Promise((r) => setImmediate(r));
    if (this.lease.expired) throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
  }
}

/**
 * One read lease per algorithm invocation: point-in-time view, writes buffer,
 * lease released in finally. Algorithms must never call db.transact inside —
 * the write would queue behind their own lease until the budget expires.
 */
export async function withAlgoLease<T>(
  leases: LeaseProvider,
  opts: AlgoOptions,
  fn: (ticker: Ticker) => Promise<T>,
): Promise<T> {
  const lease = await leases.acquireReadLease({ budgetMs: opts.budgetMs });
  try {
    // A non-positive budget is exhausted by definition. Checking here keeps the
    // semantics deterministic: the 0ms timer is a macrotask and would never
    // beat a small synchronous algorithm to the punch.
    if ((opts.budgetMs ?? 30_000) <= 0)
      throw new AtlasError('TIMEOUT', 'algorithm budget exhausted');
    return await fn(new Ticker(lease));
  } finally {
    lease.release();
  }
}

/** Directed/typed neighbor iteration shared by every algorithm. */
export function* neighbors(
  store: GraphStore,
  id: NodeId,
  direction: Direction,
  type?: string,
): IterableIterator<{ edge: EdgeRecord; next: NodeId }> {
  if (direction !== 'in') for (const e of store.outEdges(id, type)) yield { edge: e, next: e.to };
  if (direction !== 'out') for (const e of store.inEdges(id, type)) yield { edge: e, next: e.from };
}

export function requireNode(store: GraphStore, id: NodeId): void {
  if (!store.getNode(id)) throw new AtlasError('NOT_FOUND', `node ${id} not found`);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/heap.test.ts && pnpm build`
Expected: PASS; build clean.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): algorithm infrastructure — MinHeap, lease ticker, neighbor iteration"
```

### Task 4: bfs, dfs, degree + the AlgoFacade

**Files:**
- Create: `packages/core/src/algo/traverse.ts`, `packages/core/src/algo/facade.ts`
- Modify: `packages/core/src/database.ts` (add `algo` getter)
- Test: `packages/core/test/algo-traverse.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-traverse.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// Diamond with a tail: 0->1, 0->2, 1->3, 2->3, 3->4 (all REL), plus 5 isolated.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algotrav-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 6 }, () => tx.createNode(['V'], {}));
    tx.createEdge('REL', n[0]!, n[1]!);
    tx.createEdge('REL', n[0]!, n[2]!);
    tx.createEdge('REL', n[1]!, n[3]!);
    tx.createEdge('REL', n[2]!, n[3]!);
    tx.createEdge('REL', n[3]!, n[4]!);
    tx.createEdge('OTHER', n[4]!, n[5]!);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.bfs', () => {
  it('yields nodes with hop depths, each node once', async () => {
    const out = await db.algo.bfs({ from: n[0]! });
    const byNode = new Map(out.map((r) => [r.node, r.depth]));
    expect(byNode.get(n[0]!)).toBe(0);
    expect(byNode.get(n[1]!)).toBe(1);
    expect(byNode.get(n[2]!)).toBe(1);
    expect(byNode.get(n[3]!)).toBe(2);
    expect(byNode.get(n[4]!)).toBe(3);
    expect(byNode.get(n[5]!)).toBe(4); // via OTHER edge
    expect(out).toHaveLength(6);
  });

  it('respects maxDepth, type filter, and direction', async () => {
    expect(await db.algo.bfs({ from: n[0]!, maxDepth: 1 })).toHaveLength(3);
    expect((await db.algo.bfs({ from: n[0]!, type: 'REL' })).map((r) => r.node)).not.toContain(n[5]!);
    const up = await db.algo.bfs({ from: n[3]!, direction: 'in', type: 'REL' });
    expect(up.map((r) => r.node).sort()).toEqual([n[0]!, n[1]!, n[2]!, n[3]!].sort());
  });

  it('rejects a missing start node with NOT_FOUND', async () => {
    await expect(db.algo.bfs({ from: 99_999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('algo.dfs', () => {
  it('visits every reachable node exactly once with depths', async () => {
    const out = await db.algo.dfs({ from: n[0]!, type: 'REL' });
    expect(out.map((r) => r.node).sort()).toEqual([n[0]!, n[1]!, n[2]!, n[3]!, n[4]!].sort());
    expect(out.find((r) => r.node === n[0]!)?.depth).toBe(0);
    expect(out.filter((r) => r.node === n[3]!)).toHaveLength(1);
  });
});

describe('algo.degree', () => {
  it('scores by direction', async () => {
    const both = new Map((await db.algo.degree()).map((r) => [r.node, r.score]));
    expect(both.get(n[3]!)).toBe(3);
    expect(both.get(n[5]!)).toBe(1);
    const out = new Map((await db.algo.degree({ direction: 'out' })).map((r) => [r.node, r.score]));
    expect(out.get(n[0]!)).toBe(2);
    expect(out.get(n[4]!)).toBe(1);
    expect(out.get(n[5]!)).toBe(0);
  });

  it('aborts with TIMEOUT when the budget is exhausted', async () => {
    // budgetMs: 0 expires the lease before the first tick fires.
    await expect(db.algo.degree({ budgetMs: 0 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-traverse.test.ts`
Expected: FAIL — `db.algo` undefined.

- [x] **Step 3: Implement**

`packages/core/src/algo/traverse.ts`:

```ts
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, requireNode, type Direction, type Ticker } from './runner.js';

export interface TraverseOptions {
  from: NodeId;
  type?: string;
  maxDepth?: number;
  direction?: Direction;
}

export async function bfs(
  store: GraphStore,
  ticker: Ticker,
  opts: TraverseOptions,
): Promise<{ node: NodeId; depth: number }[]> {
  requireNode(store, opts.from);
  const direction = opts.direction ?? 'out';
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: { node: NodeId; depth: number }[] = [];
  const seen = new Set<NodeId>([opts.from]);
  let frontier: NodeId[] = [opts.from];
  let depth = 0;
  while (frontier.length > 0 && depth <= maxDepth) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      await ticker.tick();
      out.push({ node: id, depth });
      for (const { next: nb } of neighbors(store, id, direction, opts.type)) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

export async function dfs(
  store: GraphStore,
  ticker: Ticker,
  opts: TraverseOptions,
): Promise<{ node: NodeId; depth: number }[]> {
  requireNode(store, opts.from);
  const direction = opts.direction ?? 'out';
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: { node: NodeId; depth: number }[] = [];
  const seen = new Set<NodeId>();
  const stack: { id: NodeId; depth: number }[] = [{ id: opts.from, depth: 0 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (seen.has(id) || depth > maxDepth) continue;
    seen.add(id);
    await ticker.tick();
    out.push({ node: id, depth });
    for (const { next } of neighbors(store, id, direction, opts.type))
      if (!seen.has(next)) stack.push({ id: next, depth: depth + 1 });
  }
  return out;
}

export async function degree(
  store: GraphStore,
  ticker: Ticker,
  opts: { direction?: Direction } = {},
): Promise<{ node: NodeId; score: number }[]> {
  const direction = opts.direction ?? 'both';
  const out: { node: NodeId; score: number }[] = [];
  for (const id of store.nodes.keys()) {
    await ticker.tick();
    let score = 0;
    if (direction !== 'in') score += store.outEdges(id).length;
    if (direction !== 'out') score += store.inEdges(id).length;
    out.push({ node: id, score });
  }
  return out;
}
```

`packages/core/src/algo/facade.ts` (grows in later tasks — this is its full Task 4 form):

```ts
import type { GraphStore } from '../store.js';
import type { LeaseProvider } from '../traversal/traversal.js';
import type { NodeId } from '../types.js';
import { withAlgoLease, type AlgoOptions, type Direction } from './runner.js';
import { bfs, dfs, degree, type TraverseOptions } from './traverse.js';

/**
 * db.algo — every method runs read-only under one read lease with cooperative
 * yielding; budgets via { budgetMs }. Parameter names and result columns
 * mirror the spec §5.2 CALL table. Never call db.transact from inside an
 * algorithm callback path: the write would buffer behind the lease.
 */
export class AlgoFacade {
  constructor(
    private readonly store: GraphStore,
    private readonly leases: LeaseProvider,
  ) {}

  bfs(opts: TraverseOptions & AlgoOptions): Promise<{ node: NodeId; depth: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => bfs(this.store, t, opts));
  }

  dfs(opts: TraverseOptions & AlgoOptions): Promise<{ node: NodeId; depth: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => dfs(this.store, t, opts));
  }

  degree(opts: { direction?: Direction } & AlgoOptions = {}): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => degree(this.store, t, opts));
  }
}
```

In `packages/core/src/database.ts`:

```ts
import { AlgoFacade } from './algo/facade.js';
```

```ts
  private algoFacade: AlgoFacade | undefined;

  /** Graph algorithms (spec §4.7), lease-protected. */
  get algo(): AlgoFacade {
    return (this.algoFacade ??= new AlgoFacade(this.store, this));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-traverse.test.ts packages/core/test/lease.test.ts`
Expected: PASS — including the `budgetMs: 0` TIMEOUT path (the lease expires before the first `tick`).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): bfs/dfs/degree algorithms behind a leased db.algo facade"
```

### Task 5: shortestPath (Dijkstra/A*) and allShortestPaths

**Files:**
- Create: `packages/core/src/algo/shortest-path.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-paths.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-paths.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// Weighted square + shortcut: 0-1 (1), 1-3 (1), 0-2 (5), 2-3 (1), 0-3 (10 direct).
// Unweighted: two distinct 2-hop paths 0->3 plus the 1-hop direct edge.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algopaths-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!, { w: 1 });
    tx.createEdge('R', n[1]!, n[3]!, { w: 1 });
    tx.createEdge('R', n[0]!, n[2]!, { w: 5 });
    tx.createEdge('R', n[2]!, n[3]!, { w: 1 });
    tx.createEdge('R', n[0]!, n[3]!, { w: 10 });
    // n[4] is unreachable from n[0].
    tx.createEdge('R', n[4]!, n[0]!, { w: 1 });
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.shortestPath', () => {
  it('unweighted: fewest hops wins (the direct edge)', async () => {
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]! });
    expect(r).not.toBeNull();
    expect(r!.cost).toBe(1);
    expect(r!.path.nodes).toEqual([n[0]!, n[3]!]);
    expect(r!.path.edges).toHaveLength(1);
  });

  it('weighted: cheapest total weight wins', async () => {
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]!, weightProp: 'w' });
    expect(r!.cost).toBe(2);
    expect(r!.path.nodes).toEqual([n[0]!, n[1]!, n[3]!]);
  });

  it('returns null when unreachable; rejects negative weights', async () => {
    expect(await db.algo.shortestPath({ from: n[0]!, to: n[4]! })).toBeNull();
    await db.transact((tx) => void tx.createEdge('R', n[0]!, n[4]!, { w: -2 }));
    await expect(
      db.algo.shortestPath({ from: n[0]!, to: n[4]!, weightProp: 'w' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // restore graph for later tests by removing that edge
    const bad = db.outEdges(n[0]!).find((e) => e.props.w === -2)!;
    await db.transact((tx) => void tx.deleteEdge(bad.id));
  });

  it('A*: a consistent heuristic finds the same cost', async () => {
    const h = (id: number): number => (id === n[3]! ? 0 : 1);
    const r = await db.algo.shortestPath({ from: n[0]!, to: n[3]!, weightProp: 'w', heuristic: h });
    expect(r!.cost).toBe(2);
  });
});

describe('algo.allShortestPaths', () => {
  it('returns every minimal-hop path', async () => {
    // Remove the direct 0->3 edge so the two 2-hop routes tie.
    const direct = db.outEdges(n[0]!).find((e) => e.to === n[3]! && e.props.w === 10)!;
    await db.transact((tx) => void tx.deleteEdge(direct.id));
    const rs = await db.algo.allShortestPaths({ from: n[0]!, to: n[3]! });
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      expect(r.cost).toBe(2);
      expect(r.path.nodes[0]).toBe(n[0]!);
      expect(r.path.nodes.at(-1)).toBe(n[3]!);
    }
    const middles = rs.map((r) => r.path.nodes[1]).sort();
    expect(middles).toEqual([n[1]!, n[2]!].sort());
  });

  it('returns [] when unreachable', async () => {
    expect(await db.algo.allShortestPaths({ from: n[1]!, to: n[4]! })).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-paths.test.ts`
Expected: FAIL — `shortestPath` is not a function.

- [x] **Step 3: Implement**

`packages/core/src/algo/shortest-path.ts`:

```ts
import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { EdgeRecord, NodeId } from '../types.js';
import { MinHeap } from './heap.js';
import { neighbors, requireNode, type PathResult, type Ticker } from './runner.js';

export interface ShortestPathOptions {
  from: NodeId;
  to: NodeId;
  type?: string;
  /** Edge property holding the weight; absent/non-number values count as 1. */
  weightProp?: string;
  /** Optional admissible heuristic turns Dijkstra into A*. */
  heuristic?: (node: NodeId) => number;
}

function weightOf(e: EdgeRecord, weightProp?: string): number {
  if (!weightProp) return 1;
  const v = e.props[weightProp];
  const w = typeof v === 'number' ? v : 1;
  if (w < 0)
    throw new AtlasError('VALIDATION', `negative weight ${w} on edge ${e.id}; Dijkstra requires >= 0`);
  return w;
}

export async function shortestPath(
  store: GraphStore,
  ticker: Ticker,
  opts: ShortestPathOptions,
): Promise<{ path: PathResult; cost: number } | null> {
  requireNode(store, opts.from);
  requireNode(store, opts.to);
  const h = opts.heuristic ?? (() => 0);
  const dist = new Map<NodeId, number>([[opts.from, 0]]);
  const prev = new Map<NodeId, { node: NodeId; edge: EdgeRecord }>();
  const settled = new Set<NodeId>();
  const heap = new MinHeap<NodeId>();
  heap.push(h(opts.from), opts.from);
  while (heap.size > 0) {
    const { value: id } = heap.pop()!;
    if (settled.has(id)) continue;
    settled.add(id);
    await ticker.tick();
    if (id === opts.to) break;
    const base = dist.get(id)!;
    for (const { edge, next } of neighbors(store, id, 'out', opts.type)) {
      const alt = base + weightOf(edge, opts.weightProp);
      if (alt < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, alt);
        prev.set(next, { node: id, edge });
        heap.push(alt + h(next), next);
      }
    }
  }
  if (!settled.has(opts.to)) return null;
  const nodes: NodeId[] = [opts.to];
  const edges: number[] = [];
  for (let at = opts.to; at !== opts.from; ) {
    const p = prev.get(at)!;
    edges.unshift(p.edge.id);
    nodes.unshift(p.node);
    at = p.node;
  }
  return { path: { nodes, edges }, cost: dist.get(opts.to)! };
}

const MAX_ALL_PATHS = 1000;

/** Unweighted: every distinct minimal-hop path (capped at MAX_ALL_PATHS), cost = hop count. */
export async function allShortestPaths(
  store: GraphStore,
  ticker: Ticker,
  opts: { from: NodeId; to: NodeId; type?: string },
): Promise<{ path: PathResult; cost: number }[]> {
  requireNode(store, opts.from);
  requireNode(store, opts.to);
  // BFS recording ALL minimal predecessors per node.
  const dist = new Map<NodeId, number>([[opts.from, 0]]);
  const preds = new Map<NodeId, { node: NodeId; edge: EdgeRecord }[]>();
  let frontier: NodeId[] = [opts.from];
  while (frontier.length > 0 && !dist.has(opts.to)) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      await ticker.tick();
      const d = dist.get(id)!;
      for (const { edge, next: nb } of neighbors(store, id, 'out', opts.type)) {
        const known = dist.get(nb);
        if (known === undefined) {
          dist.set(nb, d + 1);
          preds.set(nb, [{ node: id, edge }]);
          next.push(nb);
        } else if (known === d + 1) {
          preds.get(nb)!.push({ node: id, edge });
        }
      }
    }
    frontier = next;
  }
  if (!dist.has(opts.to)) return [];
  const cost = dist.get(opts.to)!;
  // Walk every predecessor combination backward from `to`.
  const out: { path: PathResult; cost: number }[] = [];
  const walk: { node: NodeId; nodes: NodeId[]; edges: number[] }[] = [
    { node: opts.to, nodes: [opts.to], edges: [] },
  ];
  while (walk.length > 0 && out.length < MAX_ALL_PATHS) {
    const cur = walk.pop()!;
    await ticker.tick();
    if (cur.node === opts.from) {
      out.push({ path: { nodes: cur.nodes, edges: cur.edges }, cost });
      continue;
    }
    for (const p of preds.get(cur.node) ?? [])
      walk.push({ node: p.node, nodes: [p.node, ...cur.nodes], edges: [p.edge.id, ...cur.edges] });
  }
  return out;
}
```

Add to `AlgoFacade` in `packages/core/src/algo/facade.ts` (new imports: `shortestPath`, `allShortestPaths`, `type ShortestPathOptions` from `./shortest-path.js`; `type PathResult` from `./runner.js`):

```ts
  shortestPath(
    opts: ShortestPathOptions & AlgoOptions,
  ): Promise<{ path: PathResult; cost: number } | null> {
    return withAlgoLease(this.leases, opts, (t) => shortestPath(this.store, t, opts));
  }

  allShortestPaths(
    opts: { from: NodeId; to: NodeId; type?: string } & AlgoOptions,
  ): Promise<{ path: PathResult; cost: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => allShortestPaths(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-paths.test.ts`
Expected: PASS — including the negative-weight rejection and the two-way tie in `allShortestPaths`.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): Dijkstra/A* shortest path and all-shortest-paths algorithms"
```

### Task 6: Connected components — weak (BFS) and strong (iterative Tarjan)

**Files:**
- Create: `packages/core/src/algo/components.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-components.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-components.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;
let n: number[];

// 0->1->2->0 (a directed 3-cycle), 0->3 (dangling), 4<->5 (2-cycle), 6 isolated.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algocomp-'));
  db = await openDatabase(dir);
  await db.transact((tx) => {
    n = Array.from({ length: 7 }, () => tx.createNode(['V'], {}));
    tx.createEdge('R', n[0]!, n[1]!);
    tx.createEdge('R', n[1]!, n[2]!);
    tx.createEdge('R', n[2]!, n[0]!);
    tx.createEdge('R', n[0]!, n[3]!);
    tx.createEdge('R', n[4]!, n[5]!);
    tx.createEdge('R', n[5]!, n[4]!);
  });
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function groups(rows: { node: number; component: number }[]): Set<string> {
  const byComp = new Map<number, number[]>();
  for (const r of rows) {
    if (!byComp.has(r.component)) byComp.set(r.component, []);
    byComp.get(r.component)!.push(r.node);
  }
  return new Set([...byComp.values()].map((g) => g.sort((a, b) => a - b).join(',')));
}

describe('algo.components', () => {
  it('weak: direction-blind grouping', async () => {
    const rows = await db.algo.components(); // default mode 'weak'
    expect(rows).toHaveLength(7);
    expect(groups(rows)).toEqual(
      new Set([
        [n[0]!, n[1]!, n[2]!, n[3]!].sort((a, b) => a - b).join(','),
        [n[4]!, n[5]!].sort((a, b) => a - b).join(','),
        String(n[6]!),
      ]),
    );
  });

  it('strong: the 3-cycle and the 2-cycle are SCCs; the dangling node is its own', async () => {
    const rows = await db.algo.components({ mode: 'strong' });
    expect(rows).toHaveLength(7);
    expect(groups(rows)).toEqual(
      new Set([
        [n[0]!, n[1]!, n[2]!].sort((a, b) => a - b).join(','),
        [n[4]!, n[5]!].sort((a, b) => a - b).join(','),
        String(n[3]!),
        String(n[6]!),
      ]),
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-components.test.ts`
Expected: FAIL — `components` is not a function.

- [x] **Step 3: Implement**

`packages/core/src/algo/components.ts`:

```ts
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, type Ticker } from './runner.js';

export interface ComponentsOptions {
  mode?: 'weak' | 'strong';
}

export async function components(
  store: GraphStore,
  ticker: Ticker,
  opts: ComponentsOptions = {},
): Promise<{ node: NodeId; component: number }[]> {
  return (opts.mode ?? 'weak') === 'weak' ? weak(store, ticker) : strong(store, ticker);
}

async function weak(store: GraphStore, ticker: Ticker): Promise<{ node: NodeId; component: number }[]> {
  const assigned = new Map<NodeId, number>();
  let comp = 0;
  for (const root of store.nodes.keys()) {
    if (assigned.has(root)) continue;
    const queue: NodeId[] = [root];
    assigned.set(root, comp);
    while (queue.length > 0) {
      const id = queue.pop()!;
      await ticker.tick();
      for (const { next } of neighbors(store, id, 'both')) {
        if (assigned.has(next)) continue;
        assigned.set(next, comp);
        queue.push(next);
      }
    }
    comp++;
  }
  return [...assigned].map(([node, component]) => ({ node, component }));
}

/** Iterative Tarjan — explicit frames, no recursion (1M-node graphs would blow the call stack). */
async function strong(store: GraphStore, ticker: Ticker): Promise<{ node: NodeId; component: number }[]> {
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const result = new Map<NodeId, number>();
  let nextIndex = 0;
  let comp = 0;

  interface Frame {
    id: NodeId;
    iter: Iterator<{ next: NodeId }>;
  }

  for (const root of store.nodes.keys()) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);
    const frames: Frame[] = [{ id: root, iter: neighbors(store, root, 'out') }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const step = frame.iter.next();
      if (!step.done) {
        await ticker.tick();
        const w = step.value.next;
        if (!index.has(w)) {
          index.set(w, nextIndex);
          low.set(w, nextIndex);
          nextIndex++;
          stack.push(w);
          onStack.add(w);
          frames.push({ id: w, iter: neighbors(store, w, 'out') });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!));
        }
      } else {
        frames.pop();
        if (low.get(frame.id) === index.get(frame.id)) {
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            result.set(w, comp);
            if (w === frame.id) break;
          }
          comp++;
        }
        const parent = frames[frames.length - 1];
        if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
    }
  }
  return [...result].map(([node, component]) => ({ node, component }));
}
```

Add to `AlgoFacade` (import `components`, `type ComponentsOptions` from `./components.js`):

```ts
  components(
    opts: ComponentsOptions & AlgoOptions = {},
  ): Promise<{ node: NodeId; component: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => components(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-components.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): weak and strong connected components (iterative Tarjan)"
```

### Task 7: topoSort and cycles

**Files:**
- Create: `packages/core/src/algo/dag.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-dag.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-dag.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algodag-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.topoSort', () => {
  it('emits a valid topological order with positions', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 4 }, () => tx.createNode(['Pkg'], {}));
      tx.createEdge('DEP', n[0]!, n[1]!); // 0 depends-on 1 => 1 must come... order: edges point 0->1
      tx.createEdge('DEP', n[0]!, n[2]!);
      tx.createEdge('DEP', n[1]!, n[3]!);
      tx.createEdge('DEP', n[2]!, n[3]!);
    });
    const rows = await db.algo.topoSort();
    expect(rows).toHaveLength(4);
    const orderOf = new Map(rows.map((r) => [r.node, r.order]));
    // Every edge from->to must satisfy order(from) < order(to).
    for (const e of db.outEdges(n[0]!)) expect(orderOf.get(n[0]!)!).toBeLessThan(orderOf.get(e.to)!);
    expect(orderOf.get(n[1]!)!).toBeLessThan(orderOf.get(n[3]!)!);
    expect(orderOf.get(n[2]!)!).toBeLessThan(orderOf.get(n[3]!)!);
    expect(new Set(rows.map((r) => r.order))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('throws VALIDATION on a cyclic graph', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['Pkg'], {});
      const b = tx.createNode(['Pkg'], {});
      tx.createEdge('DEP', a, b);
      tx.createEdge('DEP', b, a);
    });
    await expect(db.algo.topoSort()).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('respects the type filter', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['Pkg'], {});
      const b = tx.createNode(['Pkg'], {});
      tx.createEdge('DEP', a, b);
      tx.createEdge('SOFT', b, a); // would be a cycle if SOFT counted
    });
    const rows = await db.algo.topoSort({ type: 'DEP' });
    expect(rows).toHaveLength(2);
  });
});

describe('algo.cycles', () => {
  it('finds directed cycles as closed paths', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[1]!, n[2]!);
      tx.createEdge('R', n[2]!, n[0]!); // 3-cycle
      tx.createEdge('R', n[3]!, n[4]!); // acyclic tail
    });
    const found = await db.algo.cycles();
    expect(found).toHaveLength(1);
    const cyc = found[0]!.cycle;
    expect(new Set(cyc.nodes)).toEqual(new Set([n[0]!, n[1]!, n[2]!]));
    expect(cyc.edges).toHaveLength(3); // closing edge included
  });

  it('returns [] for a DAG and respects the limit', async () => {
    await db.transact((tx) => {
      const a = tx.createNode(['V'], {});
      const b = tx.createNode(['V'], {});
      tx.createEdge('R', a, b);
      // two self-loops = two 1-cycles
      const c = tx.createNode(['V'], {});
      const d = tx.createNode(['V'], {});
      tx.createEdge('R', c, c);
      tx.createEdge('R', d, d);
    });
    expect(await db.algo.cycles({ limit: 1 })).toHaveLength(1);
    const all = await db.algo.cycles();
    expect(all).toHaveLength(2);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-dag.test.ts`
Expected: FAIL — module/method missing.

- [x] **Step 3: Implement**

`packages/core/src/algo/dag.ts`:

```ts
import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { MinHeap } from './heap.js';
import { neighbors, type PathResult, type Ticker } from './runner.js';

/** Kahn's algorithm over out-edges; deterministic (id-ascending among ready nodes). */
export async function topoSort(
  store: GraphStore,
  ticker: Ticker,
  opts: { type?: string } = {},
): Promise<{ node: NodeId; order: number }[]> {
  const indegree = new Map<NodeId, number>();
  for (const id of store.nodes.keys()) indegree.set(id, store.inEdges(id, opts.type).length);
  const ready = new MinHeap<NodeId>();
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id, id);
  const out: { node: NodeId; order: number }[] = [];
  while (ready.size > 0) {
    const { value: id } = ready.pop()!;
    await ticker.tick();
    out.push({ node: id, order: out.length });
    for (const { next } of neighbors(store, id, 'out', opts.type)) {
      const deg = indegree.get(next)! - 1;
      indegree.set(next, deg);
      if (deg === 0) ready.push(next, next);
    }
  }
  if (out.length < store.nodes.size)
    throw new AtlasError('VALIDATION', 'graph contains a cycle; topoSort requires a DAG');
  return out;
}

const DEFAULT_CYCLE_LIMIT = 100;

function canonicalSignature(nodes: NodeId[]): string {
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i]! < nodes[minIdx]!) minIdx = i;
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(',');
}

/**
 * Directed cycle detection via DFS back edges. Returns up to `limit` distinct
 * simple cycles (deduped by rotation-canonical node signature). NOT an
 * exhaustive enumeration (that is exponential); [] means acyclic.
 */
export async function cycles(
  store: GraphStore,
  ticker: Ticker,
  opts: { type?: string; limit?: number } = {},
): Promise<{ cycle: PathResult }[]> {
  const limit = opts.limit ?? DEFAULT_CYCLE_LIMIT;
  const colors = new Map<NodeId, 1 | 2>(); // absent = white, 1 = on current path, 2 = done
  const out: { cycle: PathResult }[] = [];
  const seen = new Set<string>();

  interface Frame {
    id: NodeId;
    iter: Iterator<{ edge: { id: number }; next: NodeId }>;
  }

  for (const root of store.nodes.keys()) {
    if (out.length >= limit) break;
    if (colors.has(root)) continue;
    colors.set(root, 1);
    const frames: Frame[] = [{ id: root, iter: neighbors(store, root, 'out', opts.type) }];
    const pathNodes: NodeId[] = [root];
    const pathEdges: number[] = [];
    while (frames.length > 0 && out.length < limit) {
      const frame = frames[frames.length - 1]!;
      const step = frame.iter.next();
      if (!step.done) {
        await ticker.tick();
        const { edge, next } = step.value;
        const color = colors.get(next);
        if (color === 1) {
          const start = pathNodes.indexOf(next);
          const nodes = pathNodes.slice(start);
          const edges = [...pathEdges.slice(start), edge.id];
          const sig = canonicalSignature(nodes);
          if (!seen.has(sig)) {
            seen.add(sig);
            out.push({ cycle: { nodes, edges } });
          }
        } else if (color === undefined) {
          colors.set(next, 1);
          frames.push({ id: next, iter: neighbors(store, next, 'out', opts.type) });
          pathNodes.push(next);
          pathEdges.push(edge.id);
        }
      } else {
        colors.set(frame.id, 2);
        frames.pop();
        pathNodes.pop();
        pathEdges.pop();
      }
    }
  }
  return out;
}
```

Add to `AlgoFacade` (import `topoSort`, `cycles` from `./dag.js`):

```ts
  topoSort(opts: { type?: string } & AlgoOptions = {}): Promise<{ node: NodeId; order: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => topoSort(this.store, t, opts));
  }

  cycles(
    opts: { type?: string; limit?: number } & AlgoOptions = {},
  ): Promise<{ cycle: PathResult }[]> {
    return withAlgoLease(this.leases, opts, (t) => cycles(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-dag.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): topological sort and bounded cycle detection"
```

### Task 8: PageRank

**Files:**
- Create: `packages/core/src/algo/pagerank.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-pagerank.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-pagerank.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algopr-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.pagerank', () => {
  it('a symmetric cycle converges to uniform scores summing to 1', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 3 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[1]!, n[2]!);
      tx.createEdge('R', n[2]!, n[0]!);
    });
    const rows = await db.algo.pagerank();
    expect(rows).toHaveLength(3);
    const total = rows.reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1, 6);
    for (const r of rows) expect(r.score).toBeCloseTo(1 / 3, 6);
  });

  it('a sink hub outranks its pointers; dangling mass is redistributed (sum stays 1)', async () => {
    let hub = 0;
    const leaves: number[] = [];
    await db.transact((tx) => {
      hub = tx.createNode(['V'], {});
      for (let i = 0; i < 4; i++) {
        const leaf = tx.createNode(['V'], {});
        leaves.push(leaf);
        tx.createEdge('R', leaf, hub);
      }
    });
    const rows = await db.algo.pagerank({ iterations: 30 });
    const score = new Map(rows.map((r) => [r.node, r.score]));
    for (const leaf of leaves) expect(score.get(hub)!).toBeGreaterThan(score.get(leaf)!);
    expect(rows.reduce((s, r) => s + r.score, 0)).toBeCloseTo(1, 6);
  });

  it('rejects invalid damping', async () => {
    await db.transact((tx) => void tx.createNode(['V'], {}));
    await expect(db.algo.pagerank({ damping: 1.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('empty graph returns []', async () => {
    expect(await db.algo.pagerank()).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-pagerank.test.ts`
Expected: FAIL — method missing.

- [x] **Step 3: Implement**

`packages/core/src/algo/pagerank.ts`:

```ts
import { AtlasError } from '../errors.js';
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import type { Ticker } from './runner.js';

export interface PagerankOptions {
  damping?: number;
  iterations?: number;
}

export async function pagerank(
  store: GraphStore,
  ticker: Ticker,
  opts: PagerankOptions = {},
): Promise<{ node: NodeId; score: number }[]> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 20;
  if (damping <= 0 || damping >= 1)
    throw new AtlasError('VALIDATION', `damping must be in (0,1), got ${damping}`);
  if (iterations < 1) throw new AtlasError('VALIDATION', 'iterations must be >= 1');

  const ids = [...store.nodes.keys()];
  const n = ids.length;
  if (n === 0) return [];
  const pos = new Map<NodeId, number>(ids.map((id, i) => [id, i]));
  // Dense out-target lists once up front — iteration then never touches the store.
  const outs: number[][] = [];
  for (const id of ids) {
    await ticker.tick();
    outs.push(store.outEdges(id).map((e) => pos.get(e.to)!));
  }

  let rank = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      await ticker.tick();
      const targets = outs[i]!;
      if (targets.length === 0) {
        danglingMass += rank[i]!;
        continue;
      }
      const share = (damping * rank[i]!) / targets.length;
      for (const t of targets) next[t]! += share;
    }
    const danglingShare = (damping * danglingMass) / n;
    for (let i = 0; i < n; i++) next[i]! += danglingShare;
    rank = next;
  }
  return ids.map((id, i) => ({ node: id, score: rank[i]! }));
}
```

Add to `AlgoFacade` (import `pagerank`, `type PagerankOptions` from `./pagerank.js`):

```ts
  pagerank(opts: PagerankOptions & AlgoOptions = {}): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => pagerank(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-pagerank.test.ts`
Expected: PASS — uniform cycle, hub dominance, sum-to-1 conservation.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): PageRank with dangling-mass redistribution"
```

### Task 9: Louvain community detection

Undirected, weight-1 view (parallel edges accumulate weight; self-loops count double per modularity convention). Two phases per level: deterministic local moves until no gain, then community aggregation; at most `maxLevels` levels.

**Files:**
- Create: `packages/core/src/algo/louvain.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-louvain.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-louvain.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algolv-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function clique(size: number): Promise<number[]> {
  const ids: number[] = [];
  await db.transact((tx) => {
    for (let i = 0; i < size; i++) ids.push(tx.createNode(['V'], {}));
    for (let i = 0; i < size; i++)
      for (let j = i + 1; j < size; j++) tx.createEdge('R', ids[i]!, ids[j]!);
  });
  return ids;
}

describe('algo.louvain', () => {
  it('two cliques joined by one bridge edge form two communities', async () => {
    const a = await clique(5);
    const b = await clique(5);
    await db.transact((tx) => void tx.createEdge('R', a[0]!, b[0]!));
    const rows = await db.algo.louvain();
    const comm = new Map(rows.map((r) => [r.node, r.community]));
    const aComms = new Set(a.map((id) => comm.get(id)));
    const bComms = new Set(b.map((id) => comm.get(id)));
    expect(aComms.size).toBe(1);
    expect(bComms.size).toBe(1);
    expect([...aComms][0]).not.toBe([...bComms][0]);
  });

  it('a single clique is one community', async () => {
    await clique(6);
    const rows = await db.algo.louvain();
    expect(new Set(rows.map((r) => r.community)).size).toBe(1);
  });

  it('edge-free nodes each get their own community; empty graph returns []', async () => {
    expect(await db.algo.louvain()).toEqual([]);
    await db.transact((tx) => {
      tx.createNode(['V'], {});
      tx.createNode(['V'], {});
    });
    const rows = await db.algo.louvain();
    expect(new Set(rows.map((r) => r.community)).size).toBe(2);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-louvain.test.ts`
Expected: FAIL — method missing.

- [x] **Step 3: Implement**

`packages/core/src/algo/louvain.ts`:

```ts
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import type { Ticker } from './runner.js';

export interface LouvainOptions {
  maxLevels?: number;
}

interface Level {
  adj: Map<number, number>[]; // neighbor -> accumulated weight (undirected, no self entries)
  selfW: Float64Array; // self-loop weight, doubled per convention
}

export async function louvain(
  store: GraphStore,
  ticker: Ticker,
  opts: LouvainOptions = {},
): Promise<{ node: NodeId; community: number }[]> {
  const maxLevels = opts.maxLevels ?? 10;
  const ids = [...store.nodes.keys()];
  const n = ids.length;
  if (n === 0) return [];
  const pos = new Map<NodeId, number>(ids.map((id, i) => [id, i]));

  let level: Level = { adj: Array.from({ length: n }, () => new Map()), selfW: new Float64Array(n) };
  let m2 = 0; // total weight x2
  for (const e of store.edges.values()) {
    await ticker.tick();
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    m2 += 2;
    if (a === b) {
      level.selfW[a]! += 2;
      continue;
    }
    level.adj[a]!.set(b, (level.adj[a]!.get(b) ?? 0) + 1);
    level.adj[b]!.set(a, (level.adj[b]!.get(a) ?? 0) + 1);
  }
  if (m2 === 0) return ids.map((id, i) => ({ node: id, community: i }));

  let mapping = ids.map((_, i) => i); // original index -> current-level node
  for (let l = 0; l < maxLevels; l++) {
    const { communities, moved } = await localMove(level, m2, ticker);
    mapping = mapping.map((cur) => communities[cur]!);
    if (!moved) break;
    const prevN = level.adj.length;
    const k = Math.max(...communities) + 1;
    const next: Level = { adj: Array.from({ length: k }, () => new Map()), selfW: new Float64Array(k) };
    for (let v = 0; v < prevN; v++) {
      await ticker.tick();
      const cv = communities[v]!;
      next.selfW[cv]! += level.selfW[v]!;
      for (const [w, wt] of level.adj[v]!) {
        const cw = communities[w]!;
        if (cv === cw) next.selfW[cv]! += wt; // both directions land here -> doubled, as required
        else next.adj[cv]!.set(cw, (next.adj[cv]!.get(cw) ?? 0) + wt);
      }
    }
    level = next;
    if (k === prevN) break; // no aggregation progress
  }
  return ids.map((id, i) => ({ node: id, community: mapping[i]! }));
}

async function localMove(
  level: Level,
  m2: number,
  ticker: Ticker,
): Promise<{ communities: number[]; moved: boolean }> {
  const n = level.adj.length;
  const comm = Array.from({ length: n }, (_, i) => i);
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let d = level.selfW[i]!;
    for (const wt of level.adj[i]!.values()) d += wt;
    degree[i] = d;
  }
  const commTot = Float64Array.from(degree);
  let movedAny = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (let v = 0; v < n; v++) {
      await ticker.tick();
      const cv = comm[v]!;
      const links = new Map<number, number>();
      for (const [w, wt] of level.adj[v]!) {
        const cw = comm[w]!;
        links.set(cw, (links.get(cw) ?? 0) + wt);
      }
      commTot[cv]! -= degree[v]!;
      let bestC = cv;
      let bestScore = (links.get(cv) ?? 0) - (degree[v]! * commTot[cv]!) / m2;
      for (const [c, lw] of links) {
        if (c === cv) continue;
        const score = lw - (degree[v]! * commTot[c]!) / m2;
        if (score > bestScore + 1e-12) {
          bestScore = score;
          bestC = c;
        }
      }
      commTot[bestC]! += degree[v]!;
      if (bestC !== cv) {
        comm[v] = bestC;
        movedAny = true;
        improved = true;
      }
    }
  }
  const renumber = new Map<number, number>();
  const communities = comm.map((c) => {
    let r = renumber.get(c);
    if (r === undefined) {
      r = renumber.size;
      renumber.set(c, r);
    }
    return r;
  });
  return { communities, moved: movedAny };
}
```

Add to `AlgoFacade` (import `louvain`, `type LouvainOptions` from `./louvain.js`):

```ts
  louvain(opts: LouvainOptions & AlgoOptions = {}): Promise<{ node: NodeId; community: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => louvain(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-louvain.test.ts`
Expected: PASS. If the two-clique test flakes toward one community, the gain comparison or `commTot` bookkeeping has a sign bug — debug, don't loosen.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): Louvain community detection (deterministic local moves + aggregation)"
```

### Task 10: Betweenness centrality (Brandes, exact guard + deterministic sampling)

**Files:**
- Create: `packages/core/src/algo/betweenness.ts`
- Modify: `packages/core/src/algo/facade.ts`
- Test: `packages/core/test/algo-betweenness.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/algo-betweenness.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algobc-'));
  db = await openDatabase(dir);
});
afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algo.betweenness', () => {
  it('directed path: interior nodes carry exact pair counts', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      for (let i = 0; i < 4; i++) tx.createEdge('R', n[i]!, n[i + 1]!);
    });
    const score = new Map((await db.algo.betweenness()).map((r) => [r.node, r.score]));
    // Ordered (s,t) pairs whose shortest path passes through w:
    expect(score.get(n[0]!)).toBe(0);
    expect(score.get(n[1]!)).toBe(3); // (0,2) (0,3) (0,4)
    expect(score.get(n[2]!)).toBe(4); // (0,3) (0,4) (1,3) (1,4)
    expect(score.get(n[3]!)).toBe(3); // (0,4) (1,4) (2,4)
    expect(score.get(n[4]!)).toBe(0);
  });

  it('split shortest paths share credit', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 4 }, () => tx.createNode(['V'], {}));
      tx.createEdge('R', n[0]!, n[1]!);
      tx.createEdge('R', n[0]!, n[2]!);
      tx.createEdge('R', n[1]!, n[3]!);
      tx.createEdge('R', n[2]!, n[3]!);
    });
    const score = new Map((await db.algo.betweenness()).map((r) => [r.node, r.score]));
    expect(score.get(n[1]!)).toBeCloseTo(0.5, 9); // two equal 0->3 paths split the credit
    expect(score.get(n[2]!)).toBeCloseTo(0.5, 9);
  });

  it('sampleK = n matches the exact computation', async () => {
    let n: number[] = [];
    await db.transact((tx) => {
      n = Array.from({ length: 5 }, () => tx.createNode(['V'], {}));
      for (let i = 0; i < 4; i++) tx.createEdge('R', n[i]!, n[i + 1]!);
    });
    const exact = await db.algo.betweenness();
    const sampled = await db.algo.betweenness({ sampleK: 5 });
    expect(sampled).toEqual(exact);
  });

  it('the exact guard switches to scaled sampling', async () => {
    await db.transact((tx) => {
      const hub = tx.createNode(['V'], {});
      for (let i = 0; i < 20; i++) {
        const a = tx.createNode(['V'], {});
        const b = tx.createNode(['V'], {});
        tx.createEdge('R', a, hub);
        tx.createEdge('R', hub, b);
      }
    });
    const rows = await db.algo.betweenness({ exactGuard: 10, sampleK: 11 });
    const top = rows.reduce((best, r) => (r.score > best.score ? r : best));
    const hubId = Math.min(...rows.map((r) => r.node));
    expect(top.node).toBe(hubId); // the hub dominates even under sampling
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/algo-betweenness.test.ts`
Expected: FAIL — method missing.

- [x] **Step 3: Implement**

`packages/core/src/algo/betweenness.ts`:

```ts
import type { GraphStore } from '../store.js';
import type { NodeId } from '../types.js';
import { neighbors, type Ticker } from './runner.js';

export interface BetweennessOptions {
  /** Source-sample size; forces sampling even below the guard. */
  sampleK?: number;
  /** Above this node count, sampling kicks in automatically. Default 2000. */
  exactGuard?: number;
}

/**
 * Brandes betweenness (unweighted, directed, out-edges). Exact when the node
 * count is within exactGuard and no sampleK is given; otherwise runs from a
 * deterministic evenly-spaced sample of k sources (over id-sorted nodes) and
 * scales contributions by n/k.
 */
export async function betweenness(
  store: GraphStore,
  ticker: Ticker,
  opts: BetweennessOptions = {},
): Promise<{ node: NodeId; score: number }[]> {
  const ids = [...store.nodes.keys()].sort((a, b) => a - b);
  const n = ids.length;
  if (n === 0) return [];
  const guard = opts.exactGuard ?? 2000;
  let sources: NodeId[];
  let scale = 1;
  if (opts.sampleK !== undefined || n > guard) {
    const k = Math.min(opts.sampleK ?? 200, n);
    const stride = n / k;
    sources = Array.from({ length: k }, (_, i) => ids[Math.floor(i * stride)]!);
    scale = n / k;
  } else {
    sources = ids;
  }

  const bc = new Map<NodeId, number>(ids.map((id) => [id, 0]));
  for (const s of sources) {
    const stack: NodeId[] = [];
    const preds = new Map<NodeId, NodeId[]>();
    const sigma = new Map<NodeId, number>([[s, 1]]);
    const dist = new Map<NodeId, number>([[s, 0]]);
    const queue: NodeId[] = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++]!;
      await ticker.tick();
      stack.push(v);
      for (const { next: w } of neighbors(store, v, 'out')) {
        if (!dist.has(w)) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!);
          let p = preds.get(w);
          if (!p) {
            p = [];
            preds.set(w, p);
          }
          p.push(v);
        }
      }
    }
    const delta = new Map<NodeId, number>();
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i]!;
      await ticker.tick();
      for (const v of preds.get(w) ?? []) {
        const inc = (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + inc);
      }
      if (w !== s) bc.set(w, bc.get(w)! + (delta.get(w) ?? 0) * scale);
    }
  }
  return ids.map((id) => ({ node: id, score: bc.get(id)! }));
}
```

Add to `AlgoFacade` (import `betweenness`, `type BetweennessOptions` from `./betweenness.js`):

```ts
  betweenness(
    opts: BetweennessOptions & AlgoOptions = {},
  ): Promise<{ node: NodeId; score: number }[]> {
    return withAlgoLease(this.leases, opts, (t) => betweenness(this.store, t, opts));
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/algo-betweenness.test.ts`
Expected: PASS — exact pair counts on the path graph and split credit on the diamond pin the delta accumulation.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): Brandes betweenness with exact guard and deterministic sampling"
```

### Task 11: Exports, dataset smoke test, algo bench, README, full gate

**Files:**
- Modify: `packages/core/src/index.ts`, `README.md`, `.github/workflows/nightly.yml`
- Create: `packages/core/test/algo-dataset.test.ts`, `packages/core/bench/algo.bench.ts`

- [x] **Step 1: Export the algorithm surface**

Add to `packages/core/src/index.ts`:

```ts
export { AlgoFacade } from './algo/facade.js';
export {
  type AlgoOptions,
  type Direction,
  type PathResult,
} from './algo/runner.js';
```

- [x] **Step 2: Write the dataset smoke test**

`packages/core/test/algo-dataset.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AtlasDatabase } from '../src/database.js';

let dir: string;
let db: AtlasDatabase;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-algods-'));
  db = await openDatabase(dir, { fsync: { intervalMs: 1000 } });
  await loadDataset(db, scienceHistory());
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('algorithms over science-history (500 nodes)', () => {
  it('pagerank conserves probability mass and ranks cited works highly', async () => {
    const rows = await db.algo.pagerank();
    expect(rows).toHaveLength(500);
    expect(rows.reduce((s, r) => s + r.score, 0)).toBeCloseTo(1, 4);
  });

  it('louvain finds a plausible community structure', async () => {
    const rows = await db.algo.louvain();
    const k = new Set(rows.map((r) => r.community)).size;
    expect(k).toBeGreaterThan(2);
    expect(k).toBeLessThan(250);
  });

  it('CITES is acyclic by construction', async () => {
    expect(await db.algo.cycles({ type: 'CITES' })).toEqual([]);
    await expect(db.algo.topoSort({ type: 'CITES' })).resolves.toHaveLength(500);
  });

  it('betweenness completes under sampling and is non-trivial', async () => {
    const rows = await db.algo.betweenness({ sampleK: 50 });
    expect(rows.some((r) => r.score > 0)).toBe(true);
  });
});
```

Run: `pnpm build && pnpm vitest run packages/core/test/algo-dataset.test.ts`
Expected: PASS in a few seconds.

- [x] **Step 3: Write the algo bench + nightly lane**

`packages/core/bench/algo.bench.ts`:

```ts
// Algorithm benchmark over a synthetic graph.
// Usage: SCALE=0.05 node --expose-gc --import tsx packages/core/bench/algo.bench.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGraph } from '@atlas/datasets';
import { openDatabase } from '../src/database.js';

const SCALE = Number(process.env.SCALE ?? '0.05');
const N = Math.round(1_000_000 * SCALE);
const E = Math.round(5_000_000 * SCALE);
const BATCH = 10_000;

const dir = await mkdtemp(join(tmpdir(), 'atlas-algobench-'));
try {
  console.log(`atlas algo bench — SCALE=${SCALE} → ${N} nodes / ${E} edges`);
  const graph = generateGraph({ nodes: N, edges: E, seed: 42 });
  const db = await openDatabase(dir, { fsync: { intervalMs: 5000 }, snapshotWalBytes: 1024 * 1024 * 1024 });
  const ids = new Array<number>(N);
  for (let i = 0; i < N; i += BATCH)
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, N); j++)
        ids[j] = tx.createNode(graph.nodes[j]!.labels, graph.nodes[j]!.props);
    });
  for (let i = 0; i < E; i += BATCH)
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, E); j++) {
        const e = graph.edges[j]!;
        tx.createEdge(e.type, ids[e.from]!, ids[e.to]!);
      }
    });

  const timed = async (name: string, fn: () => Promise<unknown>): Promise<Record<string, unknown>> => {
    const t = performance.now();
    await fn();
    return { name, ms: Math.round(performance.now() - t) };
  };
  const budget = { budgetMs: 600_000 };
  const results = [
    await timed('pagerank x20', () => db.algo.pagerank(budget)),
    await timed('components weak', () => db.algo.components({ ...budget })),
    await timed('components strong', () => db.algo.components({ mode: 'strong', ...budget })),
    await timed('louvain', () => db.algo.louvain(budget)),
    await timed('betweenness k=64', () => db.algo.betweenness({ sampleK: 64, ...budget })),
  ];
  console.table(results);
  await db.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

In `.github/workflows/nightly.yml`, add after the storage bench step:

```yaml
      - run: SCALE=${{ github.event.inputs.scale || '0.25' }} node --expose-gc --import tsx packages/core/bench/algo.bench.ts
```

Run locally: `SCALE=0.01 node --expose-gc --import tsx packages/core/bench/algo.bench.ts`
Expected: exits 0 with a timing table (10k nodes / 50k edges — all five algorithms in seconds).

- [x] **Step 4: README + full gate**

In `README.md`, update the `**Status:**` block to:

```markdown
**Status:** M3 — graph algorithms (`db.algo.*`): BFS/DFS, Dijkstra/A*,
all-shortest-paths, degree, weak/strong components, topoSort, cycles,
PageRank, Louvain, sampled Brandes betweenness — all lease-protected with
cooperative yielding and budgets.
```

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): algo exports, science-history smoke tests, algorithm benchmark"
```

---

## Plan self-review notes

- **Spec coverage:** §4.7 full set → Tasks 4–10 (BFS/DFS T4, Dijkstra+A*+all-shortest T5, WCC/SCC T6, topoSort+cycles T7, PageRank T8, Louvain T9, degree T4, betweenness with Brandes guard+sampling T10); lease+yield+budget mechanism → T3 (`withAlgoLease`/`Ticker`) used by every facade method; §5.2 CALL-table parameter names (`damping`, `iterations`, `maxLevels`, `mode`, `direction`, `sampleK`, `from`, `to`, `type`, `weightProp`, `maxDepth`) and YIELD columns (`node`/`depth`/`score`/`component`/`order`/`path`/`cost`/`community`/`cycle`) → facade signatures; M2 carry-overs → T1–T2 (matching [[m3-carryovers]] memory).
- **Deliberate decisions (spec reviewers: in-plan, not creep):** A* exposed as an optional `heuristic` on `shortestPath` (embedded-only; AQL CALL in M4 maps to plain Dijkstra); `allShortestPaths` capped at 1000 paths; `cycles` returns ≤limit distinct cycles via DFS back edges, explicitly NOT exhaustive enumeration; betweenness sampling is deterministic (evenly spaced over sorted ids), trading statistical purity for reproducible tests; `exactGuard` is exposed as an option (spec calls it "configurable node-count guard").
- **Known simplifications:** PageRank/Louvain/betweenness operate on the whole graph (no type filter — per the CALL table); Louvain is unweighted v1; algorithms hold one lease for their full runtime, so write stalls are bounded by `budgetMs` (spec §4.7 trade-off, surfaced in M1's risk list).
- **Type anchors:** algorithm functions are `(store: GraphStore, ticker: Ticker, opts) => Promise<...>`; the facade alone touches leases via `withAlgoLease(this.leases, opts, fn)`; `PathResult = { nodes: NodeId[]; edges: number[] }` lives in `algo/runner.ts`; `neighbors()` returns `{ edge, next }`; facade construction is `new AlgoFacade(store, leaseProvider)` cached behind the `db.algo` getter.



