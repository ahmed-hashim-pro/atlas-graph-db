# Atlas M0+M1 — Scaffold & Engine Storage Implementation Plan

**Goal:** Stand up the Atlas pnpm monorepo (tooling, CI, Docker skeleton) and build the crash-safe storage layer of `@atlas/core`: in-memory property graph store, atomic single-writer transactions, binary WAL with group commit, snapshot rotation, recovery with torn-tail truncation, a kill-the-process crash suite, plus the synthetic graph generator and benchmark harness.

**Architecture:** Committed graph state lives in `GraphStore` (Maps + per-type adjacency sets). All writes flow through one `WriteQueue`; a `TxBuilder` stages and validates ops, which are MessagePack-encoded into a CRC-framed WAL (group commit) before being applied to memory. Snapshots rotate the WAL segment, encode state during a brief write pause, and persist via tmp-file + atomic rename; recovery = newest snapshot + replay of newer WAL segments.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, pnpm workspaces, Vitest, fast-check, `@msgpack/msgpack`, `node:zlib` crc32, tsx, ESLint flat + Prettier, GitHub Actions, Docker.

**Spec:** `docs/design/specs/2026-06-10-atlas-graph-platform-design.md` (§3 architecture, §4.1–4.4 + parts of 4.3 storage, §8 generator, §10 testing, §12 M0–M1).

---

## File structure

```
package.json                      root scripts, devDeps (typescript, vitest, eslint, prettier, tsx)
pnpm-workspace.yaml               packages/*, apps/*
tsconfig.base.json                strict compiler base (composite, NodeNext)
tsconfig.json                     solution file: references to packages
vitest.config.ts                  test discovery for packages/*/test
eslint.config.js                  flat config, typescript-eslint
.prettierrc / .prettierignore
.github/workflows/ci.yml          build, lint, format, test on push/PR
.github/workflows/nightly.yml     nightly benchmark lane
Dockerfile / .dockerignore        multi-stage skeleton (real server entry lands in M5)
README.md

packages/core/
  package.json                    @atlas/core (dep: @msgpack/msgpack; devDeps: fast-check, @atlas/datasets)
  tsconfig.json
  src/index.ts                    public exports
  src/errors.ts                   AtlasError + codes
  src/types.ts                    ids, Props, records, Op, CommittedBatch, validateProps
  src/interner.ts                 string <-> small-int registry (edge types)
  src/store.ts                    GraphStore: applyOp/applyBatch, adjacency, getters, checkInvariants
  src/write-queue.ts              WriteQueue: promise-chain single-writer mutex
  src/id-allocator.ts             IdAllocator (monotonic, never-reused persisted ids)
  src/tx.ts                       TxBuilder: staging + validation + detach expansion
  src/codec.ts                    encodeBatch/decodeBatch (MessagePack)
  src/wal.ts                      encodeFrame, readWal (torn tail), WalWriter (group commit, fsync modes)
  src/snapshot.ts                 encodeSnapshot/decodeSnapshot (magic + version + MessagePack)
  src/files.ts                    data-dir layout: walPath, snapshotPath, scanDataDir, fsyncFile
  src/database.ts                 AtlasDatabase: open/recovery, transact, checkpoint, close
  test/*.test.ts                  one test file per module (paths given per task)
  test/fixtures/crash-writer.ts   child-process fixture for the crash suite
  bench/storage.bench.ts          load/traverse/recover benchmark harness

packages/datasets/
  package.json                    @atlas/datasets (no runtime deps)
  tsconfig.json
  src/index.ts
  src/random.ts                   mulberry32 seeded RNG
  src/generator.ts                generateGraph (deterministic synthetic graphs)
  test/generator.test.ts
```

Curated datasets (science-history, movies) are **M2/M4 scope** — only the synthetic generator lands here.

---

## M0 — Scaffold

### Task 1: pnpm workspace + TypeScript + formatting/lint config

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `tsconfig.json`, `.prettierrc`, `.prettierignore`, `eslint.config.js`, `.nvmrc`

- [x] **Step 1: Write the workspace files**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`package.json`:

```json
{
  "name": "atlas",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "lint": "eslint .",
    "format": "prettier --check .",
    "format:fix": "prettier --write ."
  },
  "devDependencies": {}
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`tsconfig.json` (solution file — references grow as packages land):

```json
{
  "files": [],
  "references": []
}
```

`.prettierrc`:

```json
{ "singleQuote": true, "printWidth": 100 }
```

`.prettierignore`:

```
pnpm-lock.yaml
dist
docs/
.superpowers/
```

`eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'docs/**', '.superpowers/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
);
```

`.nvmrc`:

```
22
```

- [x] **Step 2: Install root dev tooling**

Run:

```bash
pnpm add -D -w typescript vitest eslint typescript-eslint prettier tsx
```

Expected: `devDependencies` populated, `pnpm-lock.yaml` created.

- [x] **Step 3: Verify the empty solution builds and formats**

Run: `pnpm build && pnpm format`
Expected: `tsc -b` exits 0 (no projects yet); prettier reports all matched files use Prettier style. (`pnpm lint` becomes meaningful in Task 2 once TS files exist.)

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(m0): pnpm workspace, TypeScript base config, lint/format tooling"
```

### Task 2: `@atlas/core` package skeleton + Vitest wiring

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `vitest.config.ts`
- Modify: `tsconfig.json`
- Test: `packages/core/test/smoke.test.ts`

- [x] **Step 1: Write the package files**

`packages/core/package.json`:

```json
{
  "name": "@atlas/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "dependencies": { "@msgpack/msgpack": "^3.0.0" },
  "devDependencies": { "fast-check": "^3.23.0" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:

```ts
export const ATLAS_CORE_VERSION = '0.0.0';
```

`vitest.config.ts` (root):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
```

Update root `tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "packages/core" }]
}
```

- [x] **Step 2: Write the failing smoke test**

`packages/core/test/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ATLAS_CORE_VERSION } from '../src/index.js';

describe('smoke', () => {
  it('exports a version', () => {
    expect(ATLAS_CORE_VERSION).toBe('0.0.0');
  });
});
```

- [x] **Step 3: Install, then verify everything is green**

Run: `pnpm install && pnpm build && pnpm lint && pnpm format && pnpm test`
Expected: install links the workspace package; build emits `packages/core/dist/`; lint/format clean; vitest reports `1 passed`.

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(m0): @atlas/core package skeleton with vitest wiring"
```

### Task 3: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [x] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm format
      - run: pnpm test
```

- [x] **Step 2: Verify the workflow is well-formed**

Run: `pnpm exec tsx -e "import { readFileSync } from 'node:fs'; import { parse } from 'yaml'; parse(readFileSync('.github/workflows/ci.yml','utf8')); console.log('yaml ok')"` — if `yaml` isn't installed, `pnpm add -D -w yaml` first.
Expected: `yaml ok`.

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "ci(m0): build, lint, format, test on push and PR"
```

### Task 4: Docker skeleton

**Files:**
- Create: `Dockerfile`, `.dockerignore`

- [x] **Step 1: Write the files**

`Dockerfile`:

```dockerfile
# Skeleton image: builds the workspace; the real server entrypoint replaces CMD in M5.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/packages /app/packages
COPY --from=build /app/package.json /app/package.json
CMD ["node", "-e", "console.log('atlas skeleton image — server entrypoint lands in M5')"]
```

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
.git
docs
.superpowers
data
```

- [x] **Step 2: Verify (only if Docker is available locally — otherwise skip; CI does not build the image yet)**

Run: `docker build -t atlas:dev . && docker run --rm atlas:dev`
Expected: image builds; container prints the skeleton banner.

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(m0): multi-stage Dockerfile skeleton"
```

---

## M1 — Engine storage

### Task 5: Errors + types + property validation

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/types.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { validateProps } from '../src/types.js';

describe('validateProps', () => {
  it('accepts primitives, Dates, and homogeneous arrays', () => {
    expect(() =>
      validateProps({
        name: 'Ada',
        born: 1815,
        active: true,
        when: new Date(0),
        tags: ['a', 'b'],
        scores: [1, 2.5],
      }),
    ).not.toThrow();
  });

  it.each([
    ['nested object', { x: { y: 1 } }],
    ['null', { x: null }],
    ['undefined', { x: undefined }],
    ['NaN', { x: Number.NaN }],
    ['Infinity', { x: Infinity }],
    ['mixed array', { x: [1, 'a'] }],
    ['empty key', { '': 1 }],
  ])('rejects %s with VALIDATION', (_name, props) => {
    try {
      validateProps(props as never);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AtlasError);
      expect((e as AtlasError).code).toBe('VALIDATION');
    }
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/types.test.ts`
Expected: FAIL — cannot find `../src/errors.js` / `../src/types.js`.

- [x] **Step 3: Write the implementation**

`packages/core/src/errors.ts`:

```ts
export type AtlasErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONSTRAINT_VIOLATION'
  | 'TIMEOUT'
  | 'WAL_CORRUPT_TAIL'
  | 'INTERNAL';

export class AtlasError extends Error {
  constructor(
    public readonly code: AtlasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AtlasError';
  }
}
```

`packages/core/src/types.ts`:

```ts
import { AtlasError } from './errors.js';

export type NodeId = number;
export type EdgeId = number;

export type Primitive = string | number | boolean | Date;
export type PropertyValue = Primitive | string[] | number[] | boolean[] | Date[];
export type Props = Record<string, PropertyValue>;

export interface NodeRecord {
  id: NodeId;
  labels: string[];
  props: Props;
}

export interface EdgeRecord {
  id: EdgeId;
  type: string;
  from: NodeId;
  to: NodeId;
  props: Props;
}

export type Op =
  | { op: 'createNode'; id: NodeId; labels: string[]; props: Props }
  | { op: 'createEdge'; id: EdgeId; type: string; from: NodeId; to: NodeId; props: Props }
  | { op: 'setNodeProps'; id: NodeId; set: Props; remove: string[] }
  | { op: 'setEdgeProps'; id: EdgeId; set: Props; remove: string[] }
  | { op: 'deleteEdge'; id: EdgeId }
  | { op: 'deleteNode'; id: NodeId };

export interface CommittedBatch {
  txId: number;
  ops: Op[];
}

function isPrimitive(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    v instanceof Date
  );
}

export function validateProps(props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (key.length === 0) throw new AtlasError('VALIDATION', 'property name must not be empty');
    if (Array.isArray(value)) {
      if (value.length > 0) {
        const kind = typeof value[0] === 'object' ? 'date' : typeof value[0];
        for (const item of value) {
          const itemKind = typeof item === 'object' ? 'date' : typeof item;
          if (!isPrimitive(item) || itemKind !== kind)
            throw new AtlasError('VALIDATION', `property "${key}": arrays must be homogeneous primitives`);
        }
      }
    } else if (!isPrimitive(value)) {
      throw new AtlasError('VALIDATION', `property "${key}": unsupported value`);
    }
  }
}
```

Replace `packages/core/src/index.ts`:

```ts
export { AtlasError, type AtlasErrorCode } from './errors.js';
export {
  validateProps,
  type CommittedBatch,
  type EdgeId,
  type EdgeRecord,
  type NodeId,
  type NodeRecord,
  type Op,
  type Primitive,
  type Props,
  type PropertyValue,
} from './types.js';
```

(The Task 2 smoke test's `ATLAS_CORE_VERSION` export is gone — update `packages/core/test/smoke.test.ts` to import and assert `typeof AtlasError === 'function'` instead.)

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/types.test.ts packages/core/test/smoke.test.ts`
Expected: PASS (all).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): AtlasError hierarchy, graph types, property validation"
```

### Task 6: Interner

**Files:**
- Create: `packages/core/src/interner.ts`
- Test: `packages/core/test/interner.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/interner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Interner } from '../src/interner.js';

describe('Interner', () => {
  it('assigns stable sequential ids and resolves both directions', () => {
    const i = new Interner();
    expect(i.intern('KNOWS')).toBe(0);
    expect(i.intern('WROTE')).toBe(1);
    expect(i.intern('KNOWS')).toBe(0);
    expect(i.idOf('WROTE')).toBe(1);
    expect(i.idOf('MISSING')).toBeUndefined();
    expect(i.stringOf(0)).toBe('KNOWS');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/interner.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/interner.ts`:

```ts
export class Interner {
  private readonly byString = new Map<string, number>();
  private readonly byId: string[] = [];

  intern(s: string): number {
    const existing = this.byString.get(s);
    if (existing !== undefined) return existing;
    const id = this.byId.length;
    this.byString.set(s, id);
    this.byId.push(s);
    return id;
  }

  idOf(s: string): number | undefined {
    return this.byString.get(s);
  }

  stringOf(id: number): string {
    const s = this.byId[id];
    if (s === undefined) throw new RangeError(`unknown interned id ${id}`);
    return s;
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/interner.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): string interner for edge-type adjacency keys"
```

### Task 7: GraphStore — creation, adjacency, invariants

**Files:**
- Create: `packages/core/src/store.ts`
- Modify: `packages/core/src/index.ts` (add `export { GraphStore } from './store.js';`)
- Test: `packages/core/test/store.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { GraphStore } from '../src/store.js';

function seeded(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada' } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: { name: 'Charles' } });
  s.applyOp({ op: 'createNode', id: 3, labels: ['Document'], props: { title: 'Notes' } });
  s.applyOp({ op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 2, props: {} });
  s.applyOp({ op: 'createEdge', id: 2, type: 'WROTE', from: 1, to: 3, props: {} });
  return s;
}

describe('GraphStore creation + adjacency', () => {
  it('stores nodes and edges and answers typed adjacency both ways', () => {
    const s = seeded();
    expect(s.getNode(1)?.props.name).toBe('Ada');
    expect(s.getEdge(2)?.type).toBe('WROTE');
    expect(s.outEdges(1).map((e) => e.id).sort()).toEqual([1, 2]);
    expect(s.outEdges(1, 'KNOWS').map((e) => e.id)).toEqual([1]);
    expect(s.inEdges(3, 'WROTE').map((e) => e.id)).toEqual([2]);
    expect(s.inEdges(3, 'KNOWS')).toEqual([]);
    expect(s.stats()).toEqual({ nodeCount: 3, edgeCount: 2 });
  });

  it('scans nodes by label', () => {
    const s = seeded();
    expect([...s.nodesByLabel('Person')].map((n) => n.id).sort()).toEqual([1, 2]);
    expect([...s.nodesByLabel('Nope')]).toEqual([]);
  });

  it('rejects duplicate ids and dangling endpoints with INTERNAL', () => {
    const s = seeded();
    expect(() => s.applyOp({ op: 'createNode', id: 1, labels: ['X'], props: {} })).toThrowError(AtlasError);
    expect(() =>
      s.applyOp({ op: 'createEdge', id: 9, type: 'KNOWS', from: 1, to: 99, props: {} }),
    ).toThrowError(AtlasError);
  });

  it('passes invariant checks on a healthy store', () => {
    expect(() => seeded().checkInvariants()).not.toThrow();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/store.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/store.ts`:

```ts
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
        this.edges.set(op.id, { id: op.id, type: op.type, from: op.from, to: op.to, props: { ...op.props } });
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
          throw new AtlasError('INTERNAL', `node ${op.id} still has edges (batch not pre-validated?)`);
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
            if (!e) throw new AtlasError('INTERNAL', `${dir}-adjacency references missing edge ${edgeId}`);
            const endpoint = dir === 'out' ? e.from : e.to;
            if (endpoint !== nodeId || this.types.idOf(e.type) !== typeId)
              throw new AtlasError('INTERNAL', `adjacency mismatch for edge ${edgeId}`);
            if (dir === 'out') seen.add(edgeId);
          }
        }
      }
    }
    if (seen.size !== this.edges.size)
      throw new AtlasError('INTERNAL', `adjacency covers ${seen.size} edges, store has ${this.edges.size}`);
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
      for (const set of byType.values()) for (const edgeId of set) out.push(this.edges.get(edgeId)!);
    }
    return out;
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/store.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): GraphStore with typed adjacency and invariant checks"
```

### Task 8: GraphStore — mutation paths

**Files:**
- Modify: `packages/core/src/store.ts` (already implemented above — this task locks behavior with tests)
- Test: `packages/core/test/store-mutation.test.ts`

- [x] **Step 1: Write the failing-or-passing tests (they pin behavior; some pass immediately, all must be present)**

`packages/core/test/store-mutation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { GraphStore } from '../src/store.js';

function pair(): GraphStore {
  const s = new GraphStore();
  s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: { keep: 1, drop: 2 } });
  s.applyOp({ op: 'createNode', id: 2, labels: ['A'], props: {} });
  s.applyOp({ op: 'createEdge', id: 1, type: 'T', from: 1, to: 2, props: { w: 1 } });
  return s;
}

describe('GraphStore mutations', () => {
  it('merges and removes properties', () => {
    const s = pair();
    s.applyOp({ op: 'setNodeProps', id: 1, set: { added: true }, remove: ['drop'] });
    expect(s.getNode(1)?.props).toEqual({ keep: 1, added: true });
    s.applyOp({ op: 'setEdgeProps', id: 1, set: { w: 2 }, remove: [] });
    expect(s.getEdge(1)?.props).toEqual({ w: 2 });
  });

  it('deleteEdge clears adjacency on both sides', () => {
    const s = pair();
    s.applyOp({ op: 'deleteEdge', id: 1 });
    expect(s.getEdge(1)).toBeUndefined();
    expect(s.outEdges(1)).toEqual([]);
    expect(s.inEdges(2)).toEqual([]);
    expect(() => s.checkInvariants()).not.toThrow();
  });

  it('deleteNode refuses while edges remain, succeeds after', () => {
    const s = pair();
    expect(() => s.applyOp({ op: 'deleteNode', id: 1 })).toThrowError(AtlasError);
    s.applyOp({ op: 'deleteEdge', id: 1 });
    s.applyOp({ op: 'deleteNode', id: 1 });
    expect(s.getNode(1)).toBeUndefined();
    expect(s.stats()).toEqual({ nodeCount: 1, edgeCount: 0 });
  });
});
```

- [x] **Step 2: Run tests**

Run: `pnpm vitest run packages/core/test/store-mutation.test.ts`
Expected: PASS (implementation landed in Task 7; if any case fails, fix `store.ts` until green).

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "test(core): pin GraphStore mutation semantics"
```

### Task 9: WriteQueue

**Files:**
- Create: `packages/core/src/write-queue.ts`
- Test: `packages/core/test/write-queue.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/write-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WriteQueue } from '../src/write-queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WriteQueue', () => {
  it('serializes concurrent tasks in submission order', async () => {
    const q = new WriteQueue();
    const order: number[] = [];
    await Promise.all([
      q.run(async () => {
        await sleep(20);
        order.push(1);
      }),
      q.run(async () => {
        order.push(2);
      }),
      q.run(() => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates errors without poisoning the queue', async () => {
    const q = new WriteQueue();
    await expect(q.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(q.run(() => 42)).resolves.toBe(42);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/write-queue.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/write-queue.ts`:

```ts
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/write-queue.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): single-writer promise queue"
```

### Task 10: IdAllocator + TxBuilder

**Files:**
- Create: `packages/core/src/id-allocator.ts`, `packages/core/src/tx.ts`
- Modify: `packages/core/src/index.ts` (add `export { TxBuilder } from './tx.js';`)
- Test: `packages/core/test/tx.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/tx.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/errors.js';
import { IdAllocator } from '../src/id-allocator.js';
import { GraphStore } from '../src/store.js';
import { TxBuilder } from '../src/tx.js';

function setup(): { store: GraphStore; ids: IdAllocator } {
  const store = new GraphStore();
  store.applyOp({ op: 'createNode', id: 1, labels: ['Person'], props: {} });
  store.applyOp({ op: 'createNode', id: 2, labels: ['Person'], props: {} });
  store.applyOp({ op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 2, props: {} });
  return { store, ids: new IdAllocator(3, 2) };
}

describe('TxBuilder', () => {
  it('builds ops referencing both committed and tx-created elements', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Person'], { name: 'New' });
    expect(n).toBe(3);
    const e = tx.createEdge('KNOWS', 1, n);
    expect(e).toBe(2);
    tx.setNodeProps(n, { name: 'Renamed' });
    const ops = tx.build();
    expect(ops.map((o) => o.op)).toEqual(['createNode', 'createEdge', 'setNodeProps']);
  });

  it('rejects edges to missing or tx-deleted nodes with NOT_FOUND', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    expect(() => tx.createEdge('KNOWS', 1, 99)).toThrowError(AtlasError);
    tx.deleteEdge(1);
    tx.deleteNode(2);
    expect(() => tx.createEdge('KNOWS', 1, 2)).toThrowError(AtlasError);
  });

  it('deleteNode without detach throws VALIDATION while edges remain', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    try {
      tx.deleteNode(1);
      expect.unreachable();
    } catch (e) {
      expect((e as AtlasError).code).toBe('VALIDATION');
    }
  });

  it('deleteNode with detach expands deleteEdge ops for committed and tx-created edges', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Person'], {});
    tx.createEdge('KNOWS', n, 1);
    tx.deleteNode(1, { detach: true });
    const ops = tx.build();
    const deletes = ops.filter((o) => o.op === 'deleteEdge').map((o) => o.id).sort();
    expect(deletes).toEqual([1, 2]);
    expect(ops.at(-1)).toEqual({ op: 'deleteNode', id: 1 });
  });

  it('applying built ops keeps store invariants', () => {
    const { store, ids } = setup();
    const tx = new TxBuilder(store, ids);
    const n = tx.createNode(['Doc'], {});
    tx.createEdge('WROTE', 1, n);
    tx.deleteNode(2, { detach: true });
    store.applyBatch({ txId: 1, ops: tx.build() });
    expect(() => store.checkInvariants()).not.toThrow();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/tx.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/id-allocator.ts`:

```ts
export class IdAllocator {
  constructor(
    private nodeNext = 1,
    private edgeNext = 1,
  ) {}

  nextNode(): number {
    return this.nodeNext++;
  }

  nextEdge(): number {
    return this.edgeNext++;
  }

  peek(): { nodeNext: number; edgeNext: number } {
    return { nodeNext: this.nodeNext, edgeNext: this.edgeNext };
  }
}
```

`packages/core/src/tx.ts`:

```ts
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
        throw new AtlasError('VALIDATION', `node ${id} has ${incident.size} edge(s); pass { detach: true }`);
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
    const visible = (this.createdNodes.has(id) || this.store.nodes.has(id)) && !this.deletedNodes.has(id);
    if (!visible) throw new AtlasError('NOT_FOUND', `node ${id} not found in transaction view`);
  }

  private requireEdge(id: EdgeId): void {
    const visible = (this.createdEdges.has(id) || this.store.edges.has(id)) && !this.deletedEdges.has(id);
    if (!visible) throw new AtlasError('NOT_FOUND', `edge ${id} not found in transaction view`);
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/tx.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): IdAllocator and validating TxBuilder with detach expansion"
```

### Task 11: Batch codec (MessagePack)

**Files:**
- Create: `packages/core/src/codec.ts`
- Test: `packages/core/test/codec.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/codec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeBatch, encodeBatch } from '../src/codec.js';
import type { CommittedBatch } from '../src/types.js';

describe('batch codec', () => {
  it('round-trips a batch including Date properties', () => {
    const batch: CommittedBatch = {
      txId: 7,
      ops: [
        { op: 'createNode', id: 1, labels: ['Person'], props: { name: 'Ada', when: new Date(123456789) } },
        { op: 'createEdge', id: 1, type: 'KNOWS', from: 1, to: 1, props: { tags: ['x'] } },
        { op: 'setNodeProps', id: 1, set: { born: 1815 }, remove: ['name'] },
        { op: 'deleteEdge', id: 1 },
        { op: 'deleteNode', id: 1 },
      ],
    };
    const decoded = decodeBatch(encodeBatch(batch));
    expect(decoded).toEqual(batch);
    expect((decoded.ops[0] as { props: { when: unknown } }).props.when).toBeInstanceOf(Date);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/codec.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/codec.ts`:

```ts
import { decode, encode } from '@msgpack/msgpack';
import type { CommittedBatch } from './types.js';

export function encodeBatch(batch: CommittedBatch): Uint8Array {
  return encode(batch);
}

export function decodeBatch(payload: Uint8Array): CommittedBatch {
  return decode(payload) as CommittedBatch;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/codec.test.ts`
Expected: PASS (msgpack timestamp extension preserves `Date`).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): MessagePack batch codec"
```

### Task 12: WAL framing + torn-tail reader

**Files:**
- Create: `packages/core/src/wal.ts` (framing + reader half)
- Test: `packages/core/test/wal-frame.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/wal-frame.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFrame, readWal } from '../src/wal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-wal-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WAL framing', () => {
  it('reads back appended frames', async () => {
    const p = join(dir, 'wal-000001.log');
    const a = new TextEncoder().encode('alpha');
    const b = new TextEncoder().encode('bravo');
    await writeFile(p, Buffer.concat([encodeFrame(a), encodeFrame(b)]));
    const res = await readWal(p);
    expect(res.payloads.map((x) => new TextDecoder().decode(x))).toEqual(['alpha', 'bravo']);
    expect(res.corruptTail).toBe(false);
  });

  it('stops at a torn final frame and reports validBytes', async () => {
    const p = join(dir, 'wal-000001.log');
    const full = encodeFrame(new TextEncoder().encode('whole'));
    const torn = encodeFrame(new TextEncoder().encode('partial')).subarray(0, 9);
    await writeFile(p, Buffer.concat([full, torn]));
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
    expect(res.validBytes).toBe(full.length);
    expect(res.corruptTail).toBe(true);
  });

  it('stops at a corrupted CRC', async () => {
    const p = join(dir, 'wal-000001.log');
    const frame = encodeFrame(new TextEncoder().encode('data'));
    frame[frame.length - 1] ^= 0xff;
    await writeFile(p, frame);
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(0);
    expect(res.validBytes).toBe(0);
    expect(res.corruptTail).toBe(true);
  });

  it('treats a missing file as empty', async () => {
    const res = await readWal(join(dir, 'nope.log'));
    expect(res).toEqual({ payloads: [], validBytes: 0, corruptTail: false });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/wal-frame.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/wal.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export function encodeFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt32LE(crc32(payload) >>> 0, 4);
  frame.set(payload, 8);
  return frame;
}

export interface WalReadResult {
  payloads: Uint8Array[];
  validBytes: number;
  corruptTail: boolean;
}

export async function readWal(path: string): Promise<WalReadResult> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { payloads: [], validBytes: 0, corruptTail: false };
    throw e;
  }
  const payloads: Uint8Array[] = [];
  let off = 0;
  while (off + 8 <= data.length) {
    const len = data.readUInt32LE(off);
    const crc = data.readUInt32LE(off + 4);
    if (off + 8 + len > data.length) break;
    const payload = data.subarray(off + 8, off + 8 + len);
    if ((crc32(payload) >>> 0) !== crc) break;
    payloads.push(payload);
    off += 8 + len;
  }
  return { payloads, validBytes: off, corruptTail: off < data.length };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/wal-frame.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): CRC-framed WAL encoding and torn-tail-aware reader"
```

### Task 13: WalWriter with group commit and fsync modes

**Files:**
- Modify: `packages/core/src/wal.ts` (append `WalWriter`)
- Test: `packages/core/test/wal-writer.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/wal-writer.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalWriter, readWal } from '../src/wal.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-walw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WalWriter', () => {
  it('persists appended payloads durably (fsync always)', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await w.append(new TextEncoder().encode('one'));
    await w.append(new TextEncoder().encode('two'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads.map((x) => new TextDecoder().decode(x))).toEqual(['one', 'two']);
  });

  it('group-commits concurrent appends with fewer fsyncs than appends', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, 'always');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.append(new TextEncoder().encode(`p${i}`))),
    );
    expect(w.syncCount).toBeGreaterThan(0);
    expect(w.syncCount).toBeLessThan(20);
    await w.close();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(20);
  });

  it('interval mode resolves appends without awaiting fsync', async () => {
    const p = join(dir, 'wal-000001.log');
    const w = await WalWriter.open(p, { intervalMs: 50 });
    await w.append(new TextEncoder().encode('x'));
    await w.close();
    const res = await readWal(p);
    expect(res.payloads).toHaveLength(1);
  });

  it('tracks bytesWritten across reopen', async () => {
    const p = join(dir, 'wal-000001.log');
    const w1 = await WalWriter.open(p, 'always');
    await w1.append(new Uint8Array(100));
    await w1.close();
    const w2 = await WalWriter.open(p, 'always');
    expect(w2.bytesWritten).toBe(108);
    await w2.close();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/wal-writer.test.ts`
Expected: FAIL — `WalWriter` not exported.

- [x] **Step 3: Append the implementation to `packages/core/src/wal.ts`**

```ts
import { open, type FileHandle } from 'node:fs/promises';

export type FsyncMode = 'always' | { intervalMs: number };

interface PendingAppend {
  frame: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class WalWriter {
  bytesWritten: number;
  syncCount = 0;
  private pending: PendingAppend[] = [];
  private flushing = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly fh: FileHandle,
    private readonly mode: FsyncMode,
    initialSize: number,
  ) {
    this.bytesWritten = initialSize;
    if (typeof mode === 'object') {
      this.timer = setInterval(() => {
        void this.fh.sync().then(() => this.syncCount++).catch(() => undefined);
      }, mode.intervalMs);
      this.timer.unref();
    }
  }

  static async open(path: string, mode: FsyncMode): Promise<WalWriter> {
    const fh = await open(path, 'a');
    const { size } = await fh.stat();
    return new WalWriter(fh, mode, size);
  }

  append(payload: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WalWriter closed'));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ frame: encodeFrame(payload), resolve, reject });
      void this.flush();
    });
  }

  async close(): Promise<void> {
    while (this.flushing || this.pending.length > 0) await new Promise((r) => setImmediate(r));
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.fh.sync().catch(() => undefined);
    await this.fh.close();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    const group = this.pending;
    this.pending = [];
    try {
      const buf = group.length === 1 ? group[0]!.frame : Buffer.concat(group.map((g) => g.frame));
      await this.fh.write(buf);
      this.bytesWritten += buf.length;
      if (this.mode === 'always') {
        await this.fh.sync();
        this.syncCount++;
      }
      for (const g of group) g.resolve();
    } catch (err) {
      for (const g of group) g.reject(err);
    } finally {
      this.flushing = false;
      void this.flush();
    }
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/wal-writer.test.ts packages/core/test/wal-frame.test.ts`
Expected: PASS. The group-commit test must show `syncCount < 20`.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): WalWriter with group commit and configurable fsync modes"
```

### Task 14: Data-dir layout + AtlasDatabase (WAL-only durability)

**Files:**
- Create: `packages/core/src/files.ts`, `packages/core/src/database.ts`
- Modify: `packages/core/src/index.ts` (add `export { AtlasDatabase, openDatabase, type OpenOptions } from './database.js';`)
- Test: `packages/core/test/database.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/database.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AtlasDatabase', () => {
  it('commits atomically and reads see committed state', async () => {
    const db = await openDatabase(dir);
    let ada = 0;
    const { txId } = await db.transact((tx) => {
      ada = tx.createNode(['Person'], { name: 'Ada' });
      const doc = tx.createNode(['Document'], { title: 'Notes' });
      tx.createEdge('WROTE', ada, doc);
    });
    expect(txId).toBe(1);
    expect(db.getNode(ada)?.props.name).toBe('Ada');
    expect(db.outEdges(ada, 'WROTE')).toHaveLength(1);
    expect(db.stats()).toEqual({ nodeCount: 2, edgeCount: 1 });
    await db.close();
  });

  it('rolls back on user error: nothing applied, nothing persisted', async () => {
    const db = await openDatabase(dir);
    await expect(
      db.transact((tx) => {
        tx.createNode(['Person'], { name: 'ghost' });
        throw new Error('user abort');
      }),
    ).rejects.toThrow('user abort');
    expect(db.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db.close();
    const db2 = await openDatabase(dir);
    expect(db2.stats()).toEqual({ nodeCount: 0, edgeCount: 0 });
    await db2.close();
  });

  it('recovers committed state across reopen, ids never reused', async () => {
    const db = await openDatabase(dir);
    let first = 0;
    await db.transact((tx) => {
      first = tx.createNode(['A'], {});
    });
    await db.transact((tx) => tx.deleteNode(first));
    await db.close();

    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(0);
    let second = 0;
    await db2.transact((tx) => {
      second = tx.createNode(['A'], {});
    });
    expect(second).toBeGreaterThan(first);
    await db2.close();
  });

  it('serializes concurrent transactions', async () => {
    const db = await openDatabase(dir);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.transact((tx) => void tx.createNode(['N'], {}))),
    );
    expect(results.map((r) => r.txId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(db.stats().nodeCount).toBe(10);
    await db.close();
  });

  it('truncates a torn WAL tail on reopen and keeps prior commits', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    await db.close();
    const { appendFile } = await import('node:fs/promises');
    const { walPath } = await import('../src/files.js');
    await appendFile(walPath(dir, 1), Buffer.from([9, 9, 9]));
    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(1);
    await db2.transact((tx) => void tx.createNode(['A'], {}));
    expect(db2.stats().nodeCount).toBe(2);
    await db2.close();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/database.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/files.ts`:

```ts
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const WAL_RE = /^wal-(\d{6})\.log$/;
const SNAP_RE = /^snapshot-(\d{6})\.bin$/;

function pad(seq: number): string {
  return String(seq).padStart(6, '0');
}

export function walPath(dir: string, seq: number): string {
  return join(dir, `wal-${pad(seq)}.log`);
}

export function snapshotPath(dir: string, seq: number): string {
  return join(dir, `snapshot-${pad(seq)}.bin`);
}

export interface DataDirState {
  snapshotSeq: number | null;
  walSeqs: number[];
}

export async function scanDataDir(dir: string): Promise<DataDirState> {
  const entries = await readdir(dir);
  const walSeqs: number[] = [];
  let snapshotSeq: number | null = null;
  for (const name of entries) {
    const wal = WAL_RE.exec(name);
    if (wal) walSeqs.push(Number(wal[1]));
    const snap = SNAP_RE.exec(name);
    if (snap) snapshotSeq = Math.max(snapshotSeq ?? -1, Number(snap[1]));
  }
  walSeqs.sort((a, b) => a - b);
  return { snapshotSeq, walSeqs };
}

export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
```

`packages/core/src/database.ts` (WAL-only — snapshots land in Task 16):

```ts
import { mkdir, truncate } from 'node:fs/promises';
import { decodeBatch, encodeBatch } from './codec.js';
import { AtlasError } from './errors.js';
import { scanDataDir, walPath } from './files.js';
import { IdAllocator } from './id-allocator.js';
import { GraphStore } from './store.js';
import { TxBuilder } from './tx.js';
import type { EdgeId, EdgeRecord, NodeId, NodeRecord } from './types.js';
import { WalWriter, readWal, type FsyncMode } from './wal.js';
import { WriteQueue } from './write-queue.js';

export interface OpenOptions {
  fsync?: FsyncMode;
  snapshotWalBytes?: number;
}

export class AtlasDatabase {
  private constructor(
    private readonly dir: string,
    private readonly store: GraphStore,
    private readonly ids: IdAllocator,
    private wal: WalWriter,
    private walSeq: number,
    private lastTxId: number,
    private readonly opts: Required<OpenOptions>,
  ) {}

  private readonly queue = new WriteQueue();

  static async open(dir: string, opts: OpenOptions = {}): Promise<AtlasDatabase> {
    const options: Required<OpenOptions> = {
      fsync: opts.fsync ?? 'always',
      snapshotWalBytes: opts.snapshotWalBytes ?? 64 * 1024 * 1024,
    };
    await mkdir(dir, { recursive: true });
    const state = await scanDataDir(dir);
    const store = new GraphStore();
    let lastTxId = 0;
    let maxNodeId = 0;
    let maxEdgeId = 0;

    const replaySeqs = state.walSeqs.filter((s) => s > (state.snapshotSeq ?? -1));
    for (const [i, seq] of replaySeqs.entries()) {
      const res = await readWal(walPath(dir, seq));
      if (res.corruptTail) {
        if (i < replaySeqs.length - 1)
          throw new AtlasError('WAL_CORRUPT_TAIL', `corrupt record inside non-final segment ${seq}`);
        await truncate(walPath(dir, seq), res.validBytes);
        console.warn(`[atlas] recovery: truncated corrupt WAL tail of segment ${seq} at byte ${res.validBytes}`);
      }
      for (const payload of res.payloads) {
        const batch = decodeBatch(payload);
        store.applyBatch(batch);
        lastTxId = batch.txId;
        for (const op of batch.ops) {
          if (op.op === 'createNode') maxNodeId = Math.max(maxNodeId, op.id);
          if (op.op === 'createEdge') maxEdgeId = Math.max(maxEdgeId, op.id);
        }
      }
    }

    const walSeq = replaySeqs.at(-1) ?? (state.snapshotSeq ?? 0) + 1;
    const wal = await WalWriter.open(walPath(dir, walSeq), options.fsync);
    const ids = new IdAllocator(maxNodeId + 1, maxEdgeId + 1);
    return new AtlasDatabase(dir, store, ids, wal, walSeq, lastTxId, options);
  }

  transact(fn: (tx: TxBuilder) => void): Promise<{ txId: number }> {
    return this.queue.run(async () => {
      const tx = new TxBuilder(this.store, this.ids);
      fn(tx);
      const ops = tx.build();
      if (ops.length === 0) return { txId: this.lastTxId };
      const txId = this.lastTxId + 1;
      await this.wal.append(encodeBatch({ txId, ops }));
      this.store.applyBatch({ txId, ops });
      this.lastTxId = txId;
      return { txId };
    });
  }

  getNode(id: NodeId): NodeRecord | undefined {
    return this.store.getNode(id);
  }

  getEdge(id: EdgeId): EdgeRecord | undefined {
    return this.store.getEdge(id);
  }

  outEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.store.outEdges(id, type);
  }

  inEdges(id: NodeId, type?: string): EdgeRecord[] {
    return this.store.inEdges(id, type);
  }

  nodesByLabel(label: string): IterableIterator<NodeRecord> {
    return this.store.nodesByLabel(label);
  }

  stats(): { nodeCount: number; edgeCount: number } {
    return this.store.stats();
  }

  async close(): Promise<void> {
    await this.queue.run(() => undefined);
    await this.wal.close();
  }
}

export const openDatabase = AtlasDatabase.open.bind(AtlasDatabase);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/database.test.ts`
Expected: PASS (all five).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): AtlasDatabase with WAL-backed atomic transactions and recovery"
```

### Task 15: Snapshot codec

**Files:**
- Create: `packages/core/src/snapshot.ts`
- Test: `packages/core/test/snapshot.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot.js';
import { GraphStore } from '../src/store.js';

describe('snapshot codec', () => {
  it('round-trips store contents plus counters', () => {
    const s = new GraphStore();
    s.applyOp({ op: 'createNode', id: 1, labels: ['A'], props: { name: 'x', when: new Date(5) } });
    s.applyOp({ op: 'createNode', id: 4, labels: ['B'], props: {} });
    s.applyOp({ op: 'createEdge', id: 2, type: 'T', from: 1, to: 4, props: { w: 1 } });

    const buf = encodeSnapshot(s, 9, { nodeNext: 5, edgeNext: 3 });
    const snap = decodeSnapshot(buf);
    expect(snap.lastTxId).toBe(9);
    expect(snap.nextNodeId).toBe(5);
    expect(snap.nextEdgeId).toBe(3);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.nodes.find((n) => n.id === 1)?.props.when).toBeInstanceOf(Date);
  });

  it('rejects buffers without the magic header', () => {
    expect(() => decodeSnapshot(Buffer.from('garbage-not-a-snapshot'))).toThrow(/magic/);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/snapshot.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

`packages/core/src/snapshot.ts`:

```ts
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/snapshot.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): snapshot codec with magic header and id counters"
```

### Task 16: Checkpointing — rotation, recovery precedence, auto-trigger, cleanup

**Files:**
- Modify: `packages/core/src/database.ts`
- Test: `packages/core/test/checkpoint.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/core/test/checkpoint.test.ts`:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ckpt-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkpointing', () => {
  it('writes a snapshot, rotates the WAL, and deletes covered segments', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], { n: 1 }));
    await db.checkpoint();
    const files = await readdir(dir);
    expect(files).toContain('snapshot-000001.bin');
    expect(files).toContain('wal-000002.log');
    expect(files).not.toContain('wal-000001.log');
    await db.close();
  });

  it('recovers from snapshot + newer WAL, preserving id counters', async () => {
    const db = await openDatabase(dir);
    let a = 0;
    await db.transact((tx) => {
      a = tx.createNode(['A'], {});
    });
    await db.checkpoint();
    await db.transact((tx) => void tx.createEdge('T', a, a));
    await db.close();

    const db2 = await openDatabase(dir);
    expect(db2.stats()).toEqual({ nodeCount: 1, edgeCount: 1 });
    let b = 0;
    await db2.transact((tx) => {
      b = tx.createNode(['A'], {});
    });
    expect(b).toBeGreaterThan(a);
    await db2.close();
  });

  it('checkpoints automatically once WAL exceeds the threshold', async () => {
    const db = await openDatabase(dir, { snapshotWalBytes: 256 });
    for (let i = 0; i < 30; i++)
      await db.transact((tx) => void tx.createNode(['A'], { filler: 'x'.repeat(40) }));
    await db.close();
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('snapshot-'))).toBe(true);
    const db2 = await openDatabase(dir);
    expect(db2.stats().nodeCount).toBe(30);
    await db2.close();
  });

  it('concurrent checkpoint calls coalesce', async () => {
    const db = await openDatabase(dir);
    await db.transact((tx) => void tx.createNode(['A'], {}));
    await Promise.all([db.checkpoint(), db.checkpoint(), db.checkpoint()]);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith('snapshot-'))).toHaveLength(1);
    await db.close();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/test/checkpoint.test.ts`
Expected: FAIL — `checkpoint` is not a function.

- [x] **Step 3: Extend `packages/core/src/database.ts`**

Add imports:

```ts
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { snapshotPath } from './files.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';
import { fsyncFile } from './files.js';
```

In `open()`, load the snapshot **before** WAL replay (insert right after `let maxEdgeId = 0;`):

```ts
    if (state.snapshotSeq !== null) {
      const snap = decodeSnapshot(await readFile(snapshotPath(dir, state.snapshotSeq)));
      for (const n of snap.nodes) store.applyOp({ op: 'createNode', id: n.id, labels: n.labels, props: n.props });
      for (const e of snap.edges)
        store.applyOp({ op: 'createEdge', id: e.id, type: e.type, from: e.from, to: e.to, props: e.props });
      lastTxId = snap.lastTxId;
      maxNodeId = snap.nextNodeId - 1;
      maxEdgeId = snap.nextEdgeId - 1;
    }
```

After constructing the instance in `open()`, clean up files superseded by the snapshot (covers a crash between rename and cleanup):

```ts
    const db = new AtlasDatabase(dir, store, ids, wal, walSeq, lastTxId, options);
    if (state.snapshotSeq !== null) await db.cleanupBefore(state.snapshotSeq);
    return db;
```

Add to the class:

```ts
  private checkpointing: Promise<void> | null = null;

  checkpoint(): Promise<void> {
    this.checkpointing ??= this.runCheckpoint().finally(() => {
      this.checkpointing = null;
    });
    return this.checkpointing;
  }

  private async runCheckpoint(): Promise<void> {
    // Phase 1 — inside the write queue: rotate WAL, encode state (this is the brief write pause).
    const { buffer, snapSeq } = await this.queue.run(async () => {
      const snapSeq = this.walSeq;
      await this.wal.close();
      this.walSeq += 1;
      this.wal = await WalWriter.open(walPath(this.dir, this.walSeq), this.opts.fsync);
      const buffer = encodeSnapshot(this.store, this.lastTxId, this.ids.peek());
      return { buffer, snapSeq };
    });
    // Phase 2 — outside the queue: persist atomically, then delete covered files.
    const finalPath = snapshotPath(this.dir, snapSeq);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, buffer);
    await fsyncFile(tmpPath);
    await rename(tmpPath, finalPath);
    await this.cleanupBefore(snapSeq);
  }

  private async cleanupBefore(snapSeq: number): Promise<void> {
    const state = await scanDataDir(this.dir);
    for (const seq of state.walSeqs)
      if (seq <= snapSeq) await rm(walPath(this.dir, seq), { force: true });
    if (state.snapshotSeq !== null)
      for (let seq = state.snapshotSeq - 1; seq >= 0; seq--)
        await rm(snapshotPath(this.dir, seq), { force: true });
  }
```

In `transact()`, after `this.lastTxId = txId;`, add the auto-trigger:

```ts
      if (this.wal.bytesWritten >= this.opts.snapshotWalBytes && !this.checkpointing)
        void this.checkpoint().catch((err) => console.warn('[atlas] auto-checkpoint failed', err));
```

In `close()`, wait for any in-flight checkpoint first:

```ts
  async close(): Promise<void> {
    if (this.checkpointing) await this.checkpointing;
    await this.queue.run(() => undefined);
    await this.wal.close();
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/checkpoint.test.ts packages/core/test/database.test.ts`
Expected: PASS (checkpoint suite and the Task 14 suite both green).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): snapshot checkpointing with WAL rotation and recovery precedence"
```

### Task 17: Property-based storage invariants (fast-check)

**Files:**
- Test: `packages/core/test/property.test.ts`

- [x] **Step 1: Write the test**

`packages/core/test/property.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { GraphStore } from '../src/store.js';
import type { AtlasDatabase } from '../src/database.js';

type Action =
  | { kind: 'addNode' }
  | { kind: 'addEdge'; fromPick: number; toPick: number }
  | { kind: 'setProps'; pick: number }
  | { kind: 'delEdge'; pick: number }
  | { kind: 'delNode'; pick: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ kind: 'addNode' }),
  fc.record({ kind: fc.constant('addEdge' as const), fromPick: fc.nat(99), toPick: fc.nat(99) }),
  fc.record({ kind: fc.constant('setProps' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delEdge' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delNode' as const), pick: fc.nat(99) }),
);

async function applyActions(db: AtlasDatabase, actions: Action[]): Promise<void> {
  const liveNodes: number[] = [];
  const liveEdges: number[] = [];
  for (const a of actions) {
    await db
      .transact((tx) => {
        switch (a.kind) {
          case 'addNode':
            liveNodes.push(tx.createNode(['N'], { v: liveNodes.length }));
            break;
          case 'addEdge': {
            if (liveNodes.length === 0) return;
            const from = liveNodes[a.fromPick % liveNodes.length]!;
            const to = liveNodes[a.toPick % liveNodes.length]!;
            liveEdges.push(tx.createEdge('T', from, to));
            break;
          }
          case 'setProps': {
            if (liveNodes.length === 0) return;
            tx.setNodeProps(liveNodes[a.pick % liveNodes.length]!, { v: a.pick });
            break;
          }
          case 'delEdge': {
            if (liveEdges.length === 0) return;
            const idx = a.pick % liveEdges.length;
            tx.deleteEdge(liveEdges[idx]!);
            liveEdges.splice(idx, 1);
            break;
          }
          case 'delNode': {
            if (liveNodes.length === 0) return;
            const idx = a.pick % liveNodes.length;
            const nodeId = liveNodes[idx]!;
            tx.deleteNode(nodeId, { detach: true });
            liveNodes.splice(idx, 1);
            for (let i = liveEdges.length - 1; i >= 0; i--) {
              const e = db.getEdge(liveEdges[i]!);
              if (!e || e.from === nodeId || e.to === nodeId) liveEdges.splice(i, 1);
            }
            break;
          }
        }
      })
      .catch(() => undefined); // detach-race rejections are fine; invariants are what matter
  }
}

describe('storage property tests', () => {
  it('random op sequences keep invariants and survive reopen identically', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { maxLength: 60 }), async (actions) => {
        const dir = await mkdtemp(join(tmpdir(), 'atlas-prop-'));
        try {
          const db = await openDatabase(dir, { snapshotWalBytes: 2048 });
          await applyActions(db, actions);
          const before = db.stats();
          (db as unknown as { store: GraphStore }).store.checkInvariants();
          await db.close();

          const db2 = await openDatabase(dir);
          (db2 as unknown as { store: GraphStore }).store.checkInvariants();
          if (JSON.stringify(db2.stats()) !== JSON.stringify(before))
            throw new Error(`reopen mismatch: ${JSON.stringify(db2.stats())} vs ${JSON.stringify(before)}`);
          await db2.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 25 },
    );
  }, 120_000);
});
```

Note: the cast to reach `store` is test-only; make it lighter by adding a `/** test-only */ get internalStore(): GraphStore` accessor on `AtlasDatabase` if the cast offends — either is acceptable, pick one and keep it consistent.

- [x] **Step 2: Run the test**

Run: `pnpm vitest run packages/core/test/property.test.ts`
Expected: PASS in under ~2 minutes. If fast-check finds a counterexample, it prints the shrunk action sequence — fix the underlying bug (most likely in detach expansion or checkpoint/recovery interplay), do not weaken the property.

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "test(core): property-based invariants over random op sequences with reopen"
```

### Task 18: Crash suite

**Files:**
- Create: `packages/core/test/fixtures/crash-writer.ts`
- Test: `packages/core/test/crash.test.ts`

- [x] **Step 1: Write the fixture**

`packages/core/test/fixtures/crash-writer.ts`:

```ts
// Child process: writes transactions forever, printing "ACK <txId>" per durable commit.
// The parent SIGKILLs it at a random moment, then verifies recovery.
import { openDatabase } from '../../src/database.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: crash-writer <dataDir>');

const db = await openDatabase(dir, { snapshotWalBytes: 8 * 1024 });
for (;;) {
  const { txId } = await db.transact((tx) => {
    const a = tx.createNode(['Crash'], { payload: 'x'.repeat(64) });
    const b = tx.createNode(['Crash'], {});
    tx.createEdge('LINK', a, b);
  });
  process.stdout.write(`ACK ${txId}\n`);
}
```

- [x] **Step 2: Write the test**

`packages/core/test/crash.test.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import type { GraphStore } from '../src/store.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'crash-writer.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crashOnce(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-crash-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let acked = 0;
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = /^ACK (\d+)$/.exec(line);
        if (m) acked = Math.max(acked, Number(m[1]));
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    await sleep(400 + Math.floor(Math.random() * 600));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const db = await openDatabase(dir);
    (db as unknown as { store: GraphStore }).store.checkInvariants();
    const { nodeCount, edgeCount } = db.stats();
    // Every tx creates exactly 2 nodes + 1 edge; recovered state must be whole transactions...
    expect(nodeCount % 2).toBe(0);
    expect(edgeCount).toBe(nodeCount / 2);
    // ...and must include at least everything that was acknowledged durable.
    expect(edgeCount).toBeGreaterThanOrEqual(acked);
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('crash safety', () => {
  it('survives SIGKILL mid-write: acked commits recovered, no partial batches', async () => {
    for (let i = 0; i < 5; i++) await crashOnce();
  }, 60_000);
});
```

- [x] **Step 3: Run the test**

Run: `pnpm vitest run packages/core/test/crash.test.ts`
Expected: PASS — five kill/recover cycles; auto-checkpoints fire during runs (8 KB threshold), so kills land across WAL-only, mid-checkpoint, and post-checkpoint states.

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): SIGKILL crash-recovery suite over WAL and checkpoint states"
```

### Task 19: `@atlas/datasets` — synthetic graph generator

**Files:**
- Create: `packages/datasets/package.json`, `packages/datasets/tsconfig.json`, `packages/datasets/src/index.ts`, `packages/datasets/src/random.ts`, `packages/datasets/src/generator.ts`
- Modify: `tsconfig.json` (add reference), `packages/core/package.json` (devDep `"@atlas/datasets": "workspace:*"` — used by bench in Task 20)
- Test: `packages/datasets/test/generator.test.ts`

- [x] **Step 1: Write the package files**

`packages/datasets/package.json`:

```json
{
  "name": "@atlas/datasets",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts"
}
```

`packages/datasets/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Root `tsconfig.json` references become:

```json
{
  "files": [],
  "references": [{ "path": "packages/core" }, { "path": "packages/datasets" }]
}
```

- [x] **Step 2: Write the failing tests**

`packages/datasets/test/generator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateGraph } from '../src/generator.js';
import { mulberry32 } from '../src/random.js';

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('generateGraph', () => {
  it('produces exact counts with valid endpoint indices', () => {
    const g = generateGraph({ nodes: 500, edges: 2000, seed: 42 });
    expect(g.nodes).toHaveLength(500);
    expect(g.edges).toHaveLength(2000);
    for (const e of g.edges) {
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(500);
      expect(e.to).toBeGreaterThanOrEqual(0);
      expect(e.to).toBeLessThan(500);
    }
  });

  it('same seed → identical graph; different seed → different graph', () => {
    const a = generateGraph({ nodes: 50, edges: 100, seed: 1 });
    const b = generateGraph({ nodes: 50, edges: 100, seed: 1 });
    const c = generateGraph({ nodes: 50, edges: 100, seed: 2 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a.edges)).not.toBe(JSON.stringify(c.edges));
  });

  it('skews out-degree (hub formation): top decile owns a disproportionate share', () => {
    const g = generateGraph({ nodes: 1000, edges: 10_000, seed: 42 });
    const outDeg = new Array<number>(1000).fill(0);
    for (const e of g.edges) outDeg[e.from]!++;
    const sorted = [...outDeg].sort((x, y) => y - x);
    const topDecile = sorted.slice(0, 100).reduce((s, d) => s + d, 0);
    expect(topDecile / 10_000).toBeGreaterThan(0.2);
  });

  it('cycles labels and edge types', () => {
    const g = generateGraph({
      nodes: 4,
      edges: 4,
      seed: 1,
      labels: ['A', 'B'],
      edgeTypes: ['X', 'Y'],
    });
    expect(g.nodes.map((n) => n.labels[0])).toEqual(['A', 'B', 'A', 'B']);
    expect(new Set(g.edges.map((e) => e.type))).toEqual(new Set(['X', 'Y']));
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/datasets/test/generator.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 4: Write the implementation**

`packages/datasets/src/random.ts`:

```ts
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`packages/datasets/src/generator.ts`:

```ts
import { mulberry32 } from './random.js';

export interface GeneratorOptions {
  nodes: number;
  edges: number;
  seed?: number;
  labels?: string[];
  edgeTypes?: string[];
}

export interface GenNode {
  labels: string[];
  props: { name: string; weight: number };
}

export interface GenEdge {
  from: number;
  to: number;
  type: string;
  props: { weight: number };
}

export interface GeneratedGraph {
  nodes: GenNode[];
  edges: GenEdge[];
}

export function generateGraph(opts: GeneratorOptions): GeneratedGraph {
  const { nodes, edges, seed = 42, labels = ['Entity'], edgeTypes = ['LINKS'] } = opts;
  if (nodes < 1) throw new RangeError('nodes must be >= 1');
  if (edges < 0) throw new RangeError('edges must be >= 0');
  const rand = mulberry32(seed);

  const genNodes: GenNode[] = Array.from({ length: nodes }, (_, i) => ({
    labels: [labels[i % labels.length]!],
    props: { name: `n${i}`, weight: rand() },
  }));

  const genEdges: GenEdge[] = Array.from({ length: edges }, (_, i) => ({
    // Squaring the sample skews sources toward low indices → hub nodes emerge.
    from: Math.floor(rand() ** 2 * nodes),
    to: Math.floor(rand() * nodes),
    type: edgeTypes[i % edgeTypes.length]!,
    props: { weight: rand() },
  }));

  return { nodes: genNodes, edges: genEdges };
}
```

`packages/datasets/src/index.ts`:

```ts
export { generateGraph } from './generator.js';
export type { GeneratedGraph, GenEdge, GenNode, GeneratorOptions } from './generator.js';
export { mulberry32 } from './random.js';
```

Add to `packages/core/package.json` devDependencies: `"@atlas/datasets": "workspace:*"`, then `pnpm install`.

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm install && pnpm vitest run packages/datasets/test/generator.test.ts && pnpm build`
Expected: PASS; whole solution still builds.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(datasets): deterministic synthetic graph generator with hub skew"
```

### Task 20: Benchmark harness + nightly CI lane

**Files:**
- Create: `packages/core/bench/storage.bench.ts`, `.github/workflows/nightly.yml`

- [x] **Step 1: Write the harness**

`packages/core/bench/storage.bench.ts`:

```ts
// Storage benchmark vs spec §2 targets (capacity point: 1M nodes / 5M edges, SCALE=1).
// Usage: SCALE=0.05 [ASSERT_BUDGETS=1] node --expose-gc --import tsx packages/core/bench/storage.bench.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGraph } from '@atlas/datasets';
import { openDatabase } from '../src/database.js';

const SCALE = Number(process.env.SCALE ?? '0.05');
const ASSERT = process.env.ASSERT_BUDGETS === '1';
const N = Math.round(1_000_000 * SCALE);
const E = Math.round(5_000_000 * SCALE);
const BATCH = 10_000;

function heapMb(): number {
  globalThis.gc?.();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

const dir = await mkdtemp(join(tmpdir(), 'atlas-bench-'));
try {
  console.log(`atlas storage bench — SCALE=${SCALE} → ${N} nodes / ${E} edges`);
  const graph = generateGraph({ nodes: N, edges: E, seed: 42 });
  const db = await openDatabase(dir, { snapshotWalBytes: 512 * 1024 * 1024 });

  // 1) Load throughput.
  const nodeIds = new Array<number>(N);
  const t0 = performance.now();
  for (let i = 0; i < N; i += BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, N); j++)
        nodeIds[j] = tx.createNode(graph.nodes[j]!.labels, graph.nodes[j]!.props);
    });
  }
  for (let i = 0; i < E; i += BATCH) {
    await db.transact((tx) => {
      for (let j = i; j < Math.min(i + BATCH, E); j++) {
        const e = graph.edges[j]!;
        tx.createEdge(e.type, nodeIds[e.from]!, nodeIds[e.to]!, e.props);
      }
    });
  }
  const loadMs = performance.now() - t0;
  const writeOpsPerSec = Math.round((N + E) / (loadMs / 1000));

  // 2) 2-hop traversal latency (100 random starts).
  const latencies: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = nodeIds[(i * 9973) % N]!;
    const t = performance.now();
    let touched = 0;
    for (const e1 of db.outEdges(start)) for (const _e2 of db.outEdges(e1.to)) touched++;
    latencies.push(performance.now() - t);
    if (touched < 0) throw new Error('unreachable');
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)]!;

  // 3) Memory + recovery.
  const heap = heapMb();
  await db.checkpoint();
  await db.close();
  const tR = performance.now();
  const db2 = await openDatabase(dir);
  const recoveryMs = Math.round(performance.now() - tR);
  const stats = db2.stats();
  await db2.close();

  const report = { SCALE, ...stats, loadMs: Math.round(loadMs), writeOpsPerSec, p95TwoHopMs: +p95.toFixed(2), heapMb: heap, recoveryMs };
  console.table([report]);
  console.log(JSON.stringify(report));

  if (ASSERT && SCALE === 1) {
    if (heap > 8192) throw new Error(`heap budget exceeded: ${heap} MB > 8192 MB`);
    if (p95 > 50) throw new Error(`2-hop p95 budget exceeded: ${p95} ms > 50 ms`);
    if (recoveryMs > 30_000) throw new Error(`recovery budget exceeded: ${recoveryMs} ms > 30 s`);
    if (writeOpsPerSec < 5000) throw new Error(`write throughput below budget: ${writeOpsPerSec}/s < 5000/s`);
    console.log('all §2 budgets met at capacity point');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

`.github/workflows/nightly.yml`:

```yaml
name: Nightly bench
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
    inputs:
      scale:
        description: 'SCALE factor (1 = capacity point; needs a large runner)'
        default: '0.25'

jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: SCALE=${{ github.event.inputs.scale || '0.25' }} node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```

Note: hosted runners (~7 GB RAM) cannot hold the full capacity point — nightly runs SCALE=0.25 for trend tracking; the **budget-asserting SCALE=1 run is a manual/large-runner job** (`ASSERT_BUDGETS=1 SCALE=1`), required before the M7 release sign-off per spec §12.

- [x] **Step 2: Run the bench at small scale**

Run: `SCALE=0.01 node --expose-gc --import tsx packages/core/bench/storage.bench.ts`
Expected: a report table with ~10k nodes / 50k edges, sane numbers, exit 0.

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): storage benchmark harness vs spec budgets + nightly CI lane"
```

### Task 21: Final verification + README

**Files:**
- Create: `README.md`

- [x] **Step 1: Write the README**

`README.md`:

```markdown
# Atlas

A graph database platform in TypeScript: a from-scratch embedded engine
(WAL + snapshots, transactions, indexes, traversals, algorithms, AQL query
language) with a multi-user server and the Knowledge Graph Explorer web app.

**Status:** M1 — engine storage layer (crash-safe WAL, snapshots, transactions).
Design spec: `docs/design/specs/2026-06-10-atlas-graph-platform-design.md`.

## Develop

```bash
pnpm install
pnpm build && pnpm lint && pnpm test
```

## Benchmark

```bash
SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```
```

- [x] **Step 2: Full verification**

Run: `pnpm build && pnpm lint && pnpm format && pnpm test`
Expected: everything green — build clean, zero lint/format violations, all test files passing (smoke, types, interner, store ×2, write-queue, tx, codec, wal ×2, database, snapshot, checkpoint, property, crash, generator).

- [x] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README; M0+M1 complete"
```

---

## Plan self-review notes

- **Spec coverage (M0+M1 scope):** §3 monorepo/tooling/CI/Docker → Tasks 1–4; §4.1 data model + validation → Task 5; §4.2 in-memory layout + interning → Tasks 6–8; §4.4 transactions/single-writer/rollback → Tasks 9–10, 14; §4.3 WAL framing/group commit/fsync modes → Tasks 12–13; §4.3 snapshots/rotation/recovery/torn-tail → Tasks 14–16; §10 property-based + crash suite → Tasks 17–18; §8 generator → Task 19; §2/§10 benchmark targets + nightly lane → Task 20. Read leases, change feed, indexes, schema introspection are **M2**; algorithms **M3** — intentionally absent here.
- **Known simplifications (documented, not accidents):** `nodesByLabel` is a full scan until M2 indexes; ids burned by rolled-back transactions may be reissued after restart (they were never persisted — spec's "never reused" covers persisted ids); a corrupt snapshot file fails open() loudly rather than falling back to an older snapshot.
- **Type consistency anchors:** `Op` variants use `set`/`remove` fields; `TxBuilder.build(): Op[]`; `WalWriter.open(path, mode)`; `readWal → { payloads, validBytes, corruptTail }`; `encodeSnapshot(store, lastTxId, { nodeNext, edgeNext })`; `openDatabase(dir, { fsync, snapshotWalBytes })`. Later tasks must match these exactly.
```
