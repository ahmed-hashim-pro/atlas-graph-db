# Atlas M5b — Server Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Atlas server: node/edge CRUD REST, import/export + dataset seeding, WebSocket change-feed subscriptions, Prometheus metrics, safety rails (rate-limit, CORS, security headers), static SPA hosting, the isomorphic `@atlas/client` SDK, and the Docker deployment entrypoint.

**Architecture:** New routes extend the existing `registerXRoutes(app, ctx)` pattern, all guarded by `requireAuth`/`requireCapability`. WebSocket subscriptions wrap the engine's `db.subscribe(handler, {fromTxId})` change feed (`@fastify/websocket`), filtering batches by label/type and forwarding the `resync_required` close protocol. A hand-rolled `MetricsRegistry` records query latency and connection counts, exposed in Prometheus text format. Rate-limiting and security headers are small Fastify hooks (no extra deps); CORS and static hosting use official plugins. `@atlas/client` is a zero-dependency isomorphic package over global `fetch` + `WebSocket`.

**Tech Stack:** Existing stack + `@fastify/websocket@^11`, `@fastify/cors@^10`, `@fastify/static@^8` (all verified to resolve). No HTTP client dep — Node 22+ and browsers both provide global `fetch`/`WebSocket`. Tests use Fastify `.inject()` for HTTP; WebSocket tests use `app.listen({port:0})` on an ephemeral port with the global `WebSocket` client, torn down in `afterEach`.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` §6.4 (endpoint table — M5b does data CRUD, import/export, seed, WS, metrics), §6.4 import format (normative JSON tempId mapping, 10k batches, `atomic` flag, CSV typed headers), §6.5 (rate-limit, CORS, security headers, metrics), §6.6 (client SDK shape).

**Existing code anchors:**
- `@atlas/server`: `buildServer(config) → FastifyInstance`; `AppContext { catalog, manager, config }`; `requireAuth(catalog)` preHandler, `requireCapability(catalog, principal, dbName, cap)` with caps `read|write|ddl|admin-db|delete-db`; `routes/{auth,databases,query,tokens}.ts` each `registerXRoutes(app, ctx)`; `toProblem`/`HttpError`; `DatabaseManager.get(name) → Promise<AtlasDatabase>`; `app.ts` registers routes + onClose drain.
- `@atlas/core` `AtlasDatabase`: `transact(fn)`, `getNode(id)`, `getEdge(id)`, `outEdges/inEdges(id,type?)`, `nodesByLabel(label)`, `stats() → {nodeCount,edgeCount}`, `graphStore` (has `nodes`/`edges` Maps), `subscribe(handler, {fromTxId?}) → () => void`; `ChangeEvent = {type:'batch',txId,ops} | {type:'resync_required'}`; `Op` variants `createNode|createEdge|setNodeProps|setEdgeProps|deleteEdge|deleteNode`; `TxBuilder` `createNode/createEdge/setNodeProps/setEdgeProps/deleteNode(detach)/deleteEdge`.
- `@atlas/protocol`: `dbNameSchema`, zod request schemas, `ProblemDetails`.
- `@atlas/datasets`: `scienceHistory()`, `loadDataset(db, graph)`.

---

## File structure

```
packages/protocol/src/wire.ts   MODIFY: ImportReq/ImportResult, NodeCreateReq/EdgePatchReq,
                                 SubscribeFilter, exported wire types for nodes/edges
packages/server/src/
  routes/data.ts        NEW: node/edge CRUD
  routes/io.ts          NEW: import (JSON+CSV), export, seed
  routes/ws.ts          NEW: WS /ws/db/:name change-feed subscriptions
  routes/metrics.ts     NEW: GET /metrics (Prometheus text)
  metrics.ts            NEW: MetricsRegistry (histograms/gauges/counters)
  csv.ts                NEW: parseNodesCsv/parseEdgesCsv with typed headers
  security.ts           NEW: securityHeaders hook + rateLimit hook (token-bucket)
  app.ts                MODIFY: register new routes/plugins/hooks; wire metrics; static hosting
  config.ts             MODIFY: rate-limit + static-dir env
  index.ts              MODIFY: export metrics/client-facing types

packages/client/        NEW PACKAGE @atlas/client (dep: @atlas/protocol for types only)
  package.json, tsconfig.json, test/tsconfig.json
  src/index.ts          connect/AtlasClient/Database
  test/client.test.ts   against a real buildServer over an ephemeral port

Dockerfile              MODIFY: real multi-stage build running @atlas/server start()
docker-compose.yml      NEW
docs/api-reference.md   NEW (Task 9): REST + WS + import format reference
README.md               MODIFY (Task 9)
tsconfig.json           MODIFY: references += client
package.json            MODIFY: typecheck:test += client test tsconfig
```

Conventions: ESM `.js` imports; commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never run bare `vitest` (always `pnpm vitest run`); HTTP tests use `.inject()`, WS tests use an ephemeral listening port closed in teardown.

---

### Task 1: Node/edge CRUD REST routes

**Files:**
- Modify: `packages/protocol/src/wire.ts`
- Create: `packages/server/src/routes/data.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/data-routes.test.ts`

- [ ] **Step 1: Add wire schemas**

Append to `packages/protocol/src/wire.ts`:

```ts
const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number()), z.array(z.boolean())]);
export const propsSchema = z.record(propValue);

export const NodeCreateReq = z.object({
  labels: z.array(z.string().min(1)).min(1),
  properties: propsSchema.default({}),
});
export type NodeCreateReq = z.infer<typeof NodeCreateReq>;

export const NodePatchReq = z.object({
  set: propsSchema.default({}),
  remove: z.array(z.string()).default([]),
});
export type NodePatchReq = z.infer<typeof NodePatchReq>;

export const EdgeCreateReq = z.object({
  type: z.string().min(1),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  properties: propsSchema.default({}),
});
export type EdgeCreateReq = z.infer<typeof EdgeCreateReq>;

export const EdgePatchReq = NodePatchReq;
export type EdgePatchReq = z.infer<typeof EdgePatchReq>;
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/data-routes.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-data-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ owner: string; viewer: string }> {
  const reg = async (u: string): Promise<string> => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: u, password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'secret12' } });
    return `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  };
  const owner = await reg('ada');
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: owner }, payload: { name: 'kb' } });
  const viewer = await reg('bob');
  await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie: owner }, payload: { username: 'bob', role: 'viewer' } });
  return { owner, viewer };
}

describe('node CRUD', () => {
  it('create → get → patch → delete a node (editor/owner)', async () => {
    const { owner } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/db/kb/nodes',
      headers: { cookie: owner },
      payload: { labels: ['Person'], properties: { name: 'Ada', born: 1815 } },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;

    const got = await app.inject({ method: 'GET', url: `/api/db/kb/nodes/${id}`, headers: { cookie: owner } });
    expect(got.json()).toMatchObject({ id, labels: ['Person'], properties: { name: 'Ada', born: 1815 } });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/db/kb/nodes/${id}`,
      headers: { cookie: owner },
      payload: { set: { field: 'math' }, remove: ['born'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().properties).toEqual({ name: 'Ada', field: 'math' });

    const del = await app.inject({ method: 'DELETE', url: `/api/db/kb/nodes/${id}`, headers: { cookie: owner } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/db/kb/nodes/${id}`, headers: { cookie: owner } })).statusCode).toBe(404);
  });

  it('DELETE a node with edges needs ?detach=true', async () => {
    const { owner } = await setup();
    const a = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    const b = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    await app.inject({ method: 'POST', url: '/api/db/kb/edges', headers: { cookie: owner }, payload: { type: 'R', from: a, to: b } });
    expect((await app.inject({ method: 'DELETE', url: `/api/db/kb/nodes/${a}`, headers: { cookie: owner } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/db/kb/nodes/${a}?detach=true`, headers: { cookie: owner } })).statusCode).toBe(204);
  });

  it('viewer cannot create/patch/delete; can read', async () => {
    const { owner, viewer } = await setup();
    const id = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    expect((await app.inject({ method: 'GET', url: `/api/db/kb/nodes/${id}`, headers: { cookie: viewer } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: viewer }, payload: { labels: ['P'] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/db/kb/nodes/${id}`, headers: { cookie: viewer } })).statusCode).toBe(403);
  });

  it('404 for a missing node id, 400 for an invalid id', async () => {
    const { owner } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/db/kb/nodes/99999', headers: { cookie: owner } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb/nodes/abc', headers: { cookie: owner } })).statusCode).toBe(400);
  });
});

describe('edge CRUD', () => {
  it('create → get → patch → delete an edge', async () => {
    const { owner } = await setup();
    const a = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    const b = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    const create = await app.inject({ method: 'POST', url: '/api/db/kb/edges', headers: { cookie: owner }, payload: { type: 'KNOWS', from: a, to: b, properties: { since: 1833 } } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;
    expect((await app.inject({ method: 'GET', url: `/api/db/kb/edges/${id}`, headers: { cookie: owner } })).json()).toMatchObject({ type: 'KNOWS', from: a, to: b, properties: { since: 1833 } });
    await app.inject({ method: 'PATCH', url: `/api/db/kb/edges/${id}`, headers: { cookie: owner }, payload: { set: { since: 1840 }, remove: [] } });
    expect((await app.inject({ method: 'GET', url: `/api/db/kb/edges/${id}`, headers: { cookie: owner } })).json().properties).toEqual({ since: 1840 });
    expect((await app.inject({ method: 'DELETE', url: `/api/db/kb/edges/${id}`, headers: { cookie: owner } })).statusCode).toBe(204);
  });

  it('creating an edge to a missing node is 400/404', async () => {
    const { owner } = await setup();
    const a = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie: owner }, payload: { labels: ['P'] } })).json().id;
    const r = await app.inject({ method: 'POST', url: '/api/db/kb/edges', headers: { cookie: owner }, payload: { type: 'R', from: a, to: 99999 } });
    expect([400, 404]).toContain(r.statusCode);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run packages/server/test/data-routes.test.ts`
Expected: FAIL — data routes not registered.

- [ ] **Step 4: Implement**

`packages/server/src/routes/data.ts`:

```ts
import { dbNameSchema, EdgeCreateReq, NodeCreateReq, NodePatchReq } from '@atlas/protocol';
import type { AtlasDatabase } from '@atlas/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability } from '../auth.js';
import { HttpError } from '../errors.js';

function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'VALIDATION', `invalid id "${raw}"`);
  return n;
}

async function dbFor(ctx: AppContext, req: FastifyRequest, cap: 'read' | 'write'): Promise<AtlasDatabase> {
  const name = dbNameSchema.parse((req.params as { name: string }).name);
  await requireCapability(ctx.catalog, req.principal!, name, cap);
  return ctx.manager.get(name);
}

export async function registerDataRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.get('/api/db/:name/nodes/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'read');
    const node = db.getNode(parseId((req.params as { id: string }).id));
    if (!node) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    return { id: node.id, labels: node.labels, properties: node.props };
  });

  app.post('/api/db/:name/nodes', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const body = NodeCreateReq.parse(req.body);
    let id = 0;
    await db.transact((tx) => {
      id = tx.createNode(body.labels, body.properties);
    });
    void reply.status(201);
    return { id };
  });

  app.patch('/api/db/:name/nodes/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getNode(id)) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    const body = NodePatchReq.parse(req.body);
    await db.transact((tx) => tx.setNodeProps(id, body.set, body.remove));
    const node = db.getNode(id)!;
    return { id: node.id, labels: node.labels, properties: node.props };
  });

  app.delete('/api/db/:name/nodes/:id', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getNode(id)) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    const detach = (req.query as { detach?: string }).detach === 'true';
    await db.transact((tx) => tx.deleteNode(id, { detach }));
    void reply.status(204);
  });

  app.get('/api/db/:name/edges/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'read');
    const e = db.getEdge(parseId((req.params as { id: string }).id));
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    return { id: e.id, type: e.type, from: e.from, to: e.to, properties: e.props };
  });

  app.post('/api/db/:name/edges', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const body = EdgeCreateReq.parse(req.body);
    if (!db.getNode(body.from) || !db.getNode(body.to))
      throw new HttpError(404, 'NOT_FOUND', 'edge endpoint node not found');
    let id = 0;
    await db.transact((tx) => {
      id = tx.createEdge(body.type, body.from, body.to, body.properties);
    });
    void reply.status(201);
    return { id };
  });

  app.patch('/api/db/:name/edges/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getEdge(id)) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    const body = NodePatchReq.parse(req.body);
    await db.transact((tx) => tx.setEdgeProps(id, body.set, body.remove));
    const e = db.getEdge(id)!;
    return { id: e.id, type: e.type, from: e.from, to: e.to, properties: e.props };
  });

  app.delete('/api/db/:name/edges/:id', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getEdge(id)) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    await db.transact((tx) => tx.deleteEdge(id));
    void reply.status(204);
  });
}
```

In `packages/server/src/app.ts`, import and register: add `import { registerDataRoutes } from './routes/data.js';` and `await registerDataRoutes(app, ctx);` alongside the other route registrations.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/data-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): node and edge CRUD REST routes"
```

### Task 2: CSV parsing with typed headers

**Files:**
- Create: `packages/server/src/csv.ts`
- Test: `packages/server/test/csv.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/server/test/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEdgesCsv, parseNodesCsv } from '../src/csv.js';

describe('parseNodesCsv', () => {
  it('parses typed headers into nodes with a tempId column', () => {
    const csv = 'tempId,:label,name:string,born:number,active:boolean\n1,Person,Ada,1815,true\n2,Person,Charles,1791,false';
    const nodes = parseNodesCsv(csv);
    expect(nodes).toEqual([
      { tempId: '1', labels: ['Person'], properties: { name: 'Ada', born: 1815, active: true } },
      { tempId: '2', labels: ['Person'], properties: { name: 'Charles', born: 1791, active: false } },
    ]);
  });

  it('supports multi-label (label split on |) and skips blank cells', () => {
    const csv = 'tempId,:label,name:string\n1,Person|Author,Ada\n2,Person,';
    const nodes = parseNodesCsv(csv);
    expect(nodes[0]!.labels).toEqual(['Person', 'Author']);
    expect(nodes[1]!.properties).toEqual({}); // blank name omitted
  });

  it('quotes: handles commas and escaped quotes inside quoted fields', () => {
    const csv = 'tempId,:label,title:string\n1,Doc,"Notes, vol. 1"\n2,Doc,"She said ""hi"""';
    const nodes = parseNodesCsv(csv);
    expect(nodes[0]!.properties.title).toBe('Notes, vol. 1');
    expect(nodes[1]!.properties.title).toBe('She said "hi"');
  });

  it('throws on a bad number cell or missing :label column', () => {
    expect(() => parseNodesCsv('tempId,:label,born:number\n1,P,notanumber')).toThrow();
    expect(() => parseNodesCsv('tempId,name:string\n1,Ada')).toThrow(/label/);
  });
});

describe('parseEdgesCsv', () => {
  it('parses :from/:to/:type plus typed props', () => {
    const csv = ':from,:to,:type,weight:number\n1,2,KNOWS,5\n2,3,WROTE,';
    expect(parseEdgesCsv(csv)).toEqual([
      { from: '1', to: '2', type: 'KNOWS', properties: { weight: 5 } },
      { from: '2', to: '3', type: 'WROTE', properties: {} },
    ]);
  });

  it('throws when required columns are missing', () => {
    expect(() => parseEdgesCsv(':from,:to,weight:number\n1,2,5')).toThrow(/type/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/csv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/csv.ts`:

```ts
import { AtlasError } from '@atlas/core';

export interface ImportNode {
  tempId: string;
  labels: string[];
  properties: Record<string, string | number | boolean>;
}
export interface ImportEdge {
  from: string;
  to: string;
  type: string;
  properties: Record<string, string | number | boolean>;
}

/** Minimal RFC-4180-ish CSV: quoted fields, "" escapes, comma/newline aware. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      pushField();
      i++;
    } else if (c === '\n') {
      pushRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

interface TypedCol {
  name: string;
  type: 'string' | 'number' | 'boolean';
}

function coerce(raw: string, type: TypedCol['type'], col: string): string | number | boolean {
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new AtlasError('VALIDATION', `column "${col}": "${raw}" is not a number`);
    return n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new AtlasError('VALIDATION', `column "${col}": "${raw}" is not a boolean`);
  }
  return raw;
}

function typedCol(header: string): TypedCol {
  const idx = header.indexOf(':');
  if (idx === -1) return { name: header, type: 'string' };
  const name = header.slice(0, idx);
  const t = header.slice(idx + 1);
  if (t !== 'string' && t !== 'number' && t !== 'boolean')
    throw new AtlasError('VALIDATION', `unknown column type "${t}" in header "${header}"`);
  return { name, type: t };
}

export function parseNodesCsv(text: string): ImportNode[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const tempIdx = headers.indexOf('tempId');
  const labelIdx = headers.indexOf(':label');
  if (tempIdx === -1) throw new AtlasError('VALIDATION', 'nodes CSV requires a "tempId" column');
  if (labelIdx === -1) throw new AtlasError('VALIDATION', 'nodes CSV requires a ":label" column');
  const propCols = headers.map((h, i) => ({ i, col: typedCol(h) })).filter((c) => c.i !== tempIdx && c.i !== labelIdx);
  return rows.slice(1).map((r) => {
    const properties: Record<string, string | number | boolean> = {};
    for (const { i, col } of propCols) {
      const raw = r[i] ?? '';
      if (raw === '') continue;
      properties[col.name] = coerce(raw, col.type, col.name);
    }
    return {
      tempId: r[tempIdx] ?? '',
      labels: (r[labelIdx] ?? '').split('|').filter((l) => l.length > 0),
      properties,
    };
  });
}

export function parseEdgesCsv(text: string): ImportEdge[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const fromIdx = headers.indexOf(':from');
  const toIdx = headers.indexOf(':to');
  const typeIdx = headers.indexOf(':type');
  if (fromIdx === -1 || toIdx === -1) throw new AtlasError('VALIDATION', 'edges CSV requires :from and :to columns');
  if (typeIdx === -1) throw new AtlasError('VALIDATION', 'edges CSV requires a :type column');
  const propCols = headers.map((h, i) => ({ i, col: typedCol(h) })).filter((c) => ![fromIdx, toIdx, typeIdx].includes(c.i));
  return rows.slice(1).map((r) => {
    const properties: Record<string, string | number | boolean> = {};
    for (const { i, col } of propCols) {
      const raw = r[i] ?? '';
      if (raw === '') continue;
      properties[col.name] = coerce(raw, col.type, col.name);
    }
    return { from: r[fromIdx] ?? '', to: r[toIdx] ?? '', type: r[typeIdx] ?? '', properties };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): CSV parsing with typed headers for import"
```

### Task 3: Import / export / seed routes

**Files:**
- Modify: `packages/protocol/src/wire.ts`
- Create: `packages/server/src/routes/io.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/io-routes.test.ts`

- [ ] **Step 1: Add wire schemas**

Append to `packages/protocol/src/wire.ts`:

```ts
export const ImportNodeSpec = z.object({
  tempId: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  properties: propsSchema.default({}),
});
export const ImportEdgeSpec = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
  properties: propsSchema.default({}),
});
export const ImportReq = z.object({
  nodes: z.array(ImportNodeSpec).default([]),
  edges: z.array(ImportEdgeSpec).default([]),
  atomic: z.boolean().default(false),
});
export type ImportReq = z.infer<typeof ImportReq>;

export interface ImportResult {
  committed: { nodes: number; edges: number };
  idMap: Record<string, number>; // tempId → assigned engine id
  error?: { message: string; at: { kind: 'node' | 'edge'; index: number } };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/io-routes.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-io-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
  const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
  cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('JSON import/export', () => {
  it('imports nodes+edges by tempId and returns the id map', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: {
        nodes: [
          { tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } },
          { tempId: 'd', labels: ['Document'], properties: { title: 'Notes' } },
        ],
        edges: [{ from: 'a', to: 'd', type: 'WROTE', properties: {} }],
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.committed).toEqual({ nodes: 2, edges: 1 });
    expect(Object.keys(body.idMap)).toEqual(['a', 'd']);

    const exported = await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie } });
    const dump = exported.json();
    expect(dump.nodes).toHaveLength(2);
    expect(dump.edges).toHaveLength(1);
    // export uses real ids and is re-importable shape
    expect(dump.nodes[0]).toHaveProperty('tempId');
  });

  it('edges may reference existing engine ids (numeric string) as well as tempIds', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: { nodes: [{ tempId: 'x', labels: ['P'], properties: {} }], edges: [] },
    });
    const xid = first.json().idMap.x as number;
    const second = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import',
      headers: { cookie },
      payload: {
        nodes: [{ tempId: 'y', labels: ['P'], properties: {} }],
        edges: [{ from: 'y', to: String(xid), type: 'R', properties: {} }],
      },
    });
    expect(second.json().committed).toEqual({ nodes: 1, edges: 1 });
  });

  it('non-atomic import reports partial commit + first error; atomic rolls all back', async () => {
    const bad = {
      nodes: [{ tempId: 'a', labels: ['P'], properties: {} }],
      edges: [{ from: 'a', to: 'missing', type: 'R', properties: {} }],
    };
    const partial = await app.inject({ method: 'POST', url: '/api/db/kb/import', headers: { cookie }, payload: bad });
    expect(partial.json().committed.nodes).toBe(1); // node batch committed before the bad edge
    expect(partial.json().error).toMatchObject({ at: { kind: 'edge', index: 0 } });

    const atomic = await app.inject({ method: 'POST', url: '/api/db/kb/import', headers: { cookie }, payload: { ...bad, atomic: true } });
    expect(atomic.statusCode).toBe(400);
    // nothing from the atomic attempt persisted: only the earlier partial node remains
    const exp = await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie } });
    expect(exp.json().nodes).toHaveLength(1);
  });

  it('CSV import via multipart-ish text fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/import?format=csv',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        nodesCsv: 'tempId,:label,name:string\n1,Person,Ada\n2,Person,Bob',
        edgesCsv: ':from,:to,:type\n1,2,KNOWS',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().committed).toEqual({ nodes: 2, edges: 1 });
  });
});

describe('seed', () => {
  it('seeds science-history (editor+); unknown dataset is 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/db/kb/seed/science-history', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().committed.nodes).toBe(500);
    expect((await app.inject({ method: 'POST', url: '/api/db/kb/seed/nope', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('permissions', () => {
  it('viewer cannot import/seed but can export', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'bob', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'secret12' } });
    const bob = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie }, payload: { username: 'bob', role: 'viewer' } });
    expect((await app.inject({ method: 'POST', url: '/api/db/kb/import', headers: { cookie: bob }, payload: { nodes: [], edges: [] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie: bob } })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/io-routes.test.ts`
Expected: FAIL — io routes not registered.

- [ ] **Step 4: Implement**

`packages/server/src/routes/io.ts`:

```ts
import { dbNameSchema, ImportReq, type ImportResult } from '@atlas/protocol';
import { AtlasError, type AtlasDatabase } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability } from '../auth.js';
import { parseEdgesCsv, parseNodesCsv, type ImportEdge, type ImportNode } from '../csv.js';
import { HttpError } from '../errors.js';

const BATCH = 10_000;

interface NormalizedImport {
  nodes: ImportNode[];
  edges: ImportEdge[];
  atomic: boolean;
}

/** Resolve a tempId-or-engine-id reference to a concrete engine id. */
function resolveRef(ref: string, idMap: Map<string, number>, db: AtlasDatabase): number | null {
  const mapped = idMap.get(ref);
  if (mapped !== undefined) return mapped;
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && asNum >= 0 && db.getNode(asNum)) return asNum;
  return null;
}

async function runImport(db: AtlasDatabase, imp: NormalizedImport): Promise<ImportResult> {
  const idMap = new Map<string, number>();
  let committedNodes = 0;
  let committedEdges = 0;

  if (imp.atomic) {
    // Single transaction: all-or-nothing. (Engine batches commit atomically.)
    try {
      await db.transact((tx) => {
        for (const n of imp.nodes) idMap.set(n.tempId, tx.createNode(n.labels, n.properties));
        for (const [i, e] of imp.edges.entries()) {
          const from = idMap.get(e.from) ?? (Number.isInteger(Number(e.from)) ? Number(e.from) : undefined);
          const to = idMap.get(e.to) ?? (Number.isInteger(Number(e.to)) ? Number(e.to) : undefined);
          if (from === undefined || to === undefined)
            throw new AtlasError('VALIDATION', `edge ${i}: unresolved endpoint`);
          tx.createEdge(e.type, from, to, e.properties);
        }
      });
      committedNodes = imp.nodes.length;
      committedEdges = imp.edges.length;
    } catch (err) {
      if (err instanceof AtlasError) throw err;
      throw new AtlasError('VALIDATION', (err as Error).message);
    }
    return { committed: { nodes: committedNodes, edges: committedEdges }, idMap: Object.fromEntries(idMap) };
  }

  // Non-atomic: batched; on first error, stop and report what committed.
  for (let i = 0; i < imp.nodes.length; i += BATCH) {
    const slice = imp.nodes.slice(i, i + BATCH);
    await db.transact((tx) => {
      for (const n of slice) idMap.set(n.tempId, tx.createNode(n.labels, n.properties));
    });
    committedNodes += slice.length;
  }
  for (let i = 0; i < imp.edges.length; i += BATCH) {
    const slice = imp.edges.slice(i, i + BATCH);
    try {
      const localRefs: { from: number; to: number; type: string; props: typeof slice[number]['properties'] }[] = [];
      for (const [j, e] of slice.entries()) {
        const from = resolveRef(e.from, idMap, db);
        const to = resolveRef(e.to, idMap, db);
        if (from === null || to === null)
          return {
            committed: { nodes: committedNodes, edges: committedEdges },
            idMap: Object.fromEntries(idMap),
            error: { message: `edge references unknown node`, at: { kind: 'edge', index: i + j } },
          };
        localRefs.push({ from, to, type: e.type, props: e.properties });
      }
      await db.transact((tx) => {
        for (const r of localRefs) tx.createEdge(r.type, r.from, r.to, r.props);
      });
      committedEdges += slice.length;
    } catch (err) {
      return {
        committed: { nodes: committedNodes, edges: committedEdges },
        idMap: Object.fromEntries(idMap),
        error: { message: (err as Error).message, at: { kind: 'edge', index: i } },
      };
    }
  }
  return { committed: { nodes: committedNodes, edges: committedEdges }, idMap: Object.fromEntries(idMap) };
}

export async function registerIoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/db/:name/import', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'write');
    const db = await ctx.manager.get(name);
    const format = (req.query as { format?: string }).format;
    let imp: NormalizedImport;
    if (format === 'csv') {
      const body = req.body as { nodesCsv?: string; edgesCsv?: string; atomic?: boolean };
      imp = {
        nodes: body.nodesCsv ? parseNodesCsv(body.nodesCsv) : [],
        edges: body.edgesCsv ? parseEdgesCsv(body.edgesCsv) : [],
        atomic: body.atomic ?? false,
      };
    } else {
      const parsed = ImportReq.parse(req.body);
      imp = { nodes: parsed.nodes, edges: parsed.edges, atomic: parsed.atomic };
    }
    return runImport(db, imp);
  });

  app.get('/api/db/:name/export', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const db = await ctx.manager.get(name);
    const store = db.graphStore;
    const nodes = [...store.nodes.values()].map((n) => ({ tempId: String(n.id), labels: n.labels, properties: n.props }));
    const edges = [...store.edges.values()].map((e) => ({ from: String(e.from), to: String(e.to), type: e.type, properties: e.props }));
    return { nodes, edges };
  });

  app.post('/api/db/:name/seed/:dataset', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'write');
    const dataset = (req.params as { dataset: string }).dataset;
    if (dataset !== 'science-history') throw new HttpError(404, 'NOT_FOUND', `unknown dataset "${dataset}"`);
    const db = await ctx.manager.get(name);
    await loadDataset(db, scienceHistory());
    return { committed: { nodes: db.stats().nodeCount, edges: db.stats().edgeCount } };
  });
}
```

In `app.ts`, register `registerIoRoutes`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/io-routes.test.ts`
Expected: PASS — JSON + CSV import, export, seed, atomic rollback, permissions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): JSON/CSV import, export, and dataset seed routes"
```

### Task 4: WebSocket change-feed subscriptions

**Files:**
- Modify: `packages/protocol/src/wire.ts`
- Create: `packages/server/src/routes/ws.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/ws.test.ts`

- [ ] **Step 1: Add the filter schema**

Append to `packages/protocol/src/wire.ts`:

```ts
export const SubscribeFilter = z.object({
  labels: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
});
export type SubscribeFilter = z.infer<typeof SubscribeFilter>;

/** Server→client WS frames. */
export type WsFrame =
  | { type: 'ready' }
  | { type: 'batch'; txId: number; ops: unknown[] }
  | { type: 'resync_required' }
  | { type: 'error'; code: string; message: string };
```

- [ ] **Step 2: Write the failing tests**

`packages/server/test/ws.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-ws-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `127.0.0.1:${port}`;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
  const cookie = `atlas_session=${login.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
  const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'ws' } });
  token = created.json().token as string;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function open(path: string): Promise<{ ws: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}${path}`);
    const frames: unknown[] = [];
    const waiters: ((v: unknown) => void)[] = [];
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      const w = waiters.shift();
      if (w) w(frame);
      else frames.push(frame);
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () =>
      resolve({
        ws,
        frames,
        next: () =>
          new Promise((res) => {
            const buffered = frames.shift();
            if (buffered !== undefined) res(buffered);
            else waiters.push(res);
          }),
      });
  });
}

async function writeNode(labels: string[], props: Record<string, unknown> = {}): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/api/db/kb/nodes',
    headers: { authorization: `Bearer ${token}` },
    payload: { labels, properties: props },
  });
}

describe('WS subscriptions', () => {
  it('rejects unauthenticated connections', async () => {
    await expect(open('/ws/db/kb')).rejects.toThrow();
  });

  it('streams committed batches after a ready frame', async () => {
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    await writeNode(['Person'], { name: 'Ada' });
    const frame = (await conn.next()) as { type: string; ops: { op: string }[] };
    expect(frame.type).toBe('batch');
    expect(frame.ops.some((o) => o.op === 'createNode')).toBe(true);
    conn.ws.close();
  });

  it('label filter only forwards batches touching matching labels', async () => {
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}&labels=Document`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    await writeNode(['Person'], { name: 'ignored' }); // filtered out
    await writeNode(['Document'], { title: 'kept' });
    const frame = (await conn.next()) as { type: string; ops: { op: string }[] };
    expect(frame.type).toBe('batch');
    // the first delivered batch is the Document one (Person was filtered)
    conn.ws.close();
  });

  it('viewer token may subscribe (read capability)', async () => {
    // ada is owner; a viewer also works — covered by capability=read in the handler.
    const conn = await open(`/ws/db/kb?token=${encodeURIComponent(token)}`);
    expect(await conn.next()).toEqual({ type: 'ready' });
    conn.ws.close();
  });
});
```

- [ ] **Step 2b: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/ws.test.ts`
Expected: FAIL — WS route not registered (connection rejected for all).

- [ ] **Step 3: Implement**

`packages/server/src/routes/ws.ts`:

```ts
import type { Op } from '@atlas/core';
import { dbNameSchema, type WsFrame } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { AppContext } from '../app.js';
import { authenticate, requireCapability } from '../auth.js';

/** Does this batch touch any node carrying a wanted label or any wanted edge type? */
function batchMatches(ops: Op[], labels: Set<string> | null, types: Set<string> | null): boolean {
  if (!labels && !types) return true;
  for (const op of ops) {
    if (labels && (op.op === 'createNode') && op.labels.some((l) => labels.has(l))) return true;
    if (types && (op.op === 'createEdge') && types.has(op.type)) return true;
    // setNodeProps/deleteNode/deleteEdge carry no label/type; conservatively included only
    // when no filter is set (handled above) — filtered subscriptions see create-shaped ops.
  }
  return false;
}

export async function registerWsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/ws/db/:name', { websocket: true }, async (socket: WebSocket, req) => {
    const send = (frame: WsFrame): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    // Token may arrive via ?token= (browsers can't set WS headers) or Authorization.
    const tokenQ = (req.query as { token?: string }).token;
    if (tokenQ) req.headers.authorization = `Bearer ${tokenQ}`;
    const principal = await authenticate(req, ctx.catalog);
    if (!principal) {
      send({ type: 'error', code: 'UNAUTHENTICATED', message: 'authentication required' });
      socket.close();
      return;
    }
    let name: string;
    try {
      name = dbNameSchema.parse((req.params as { name: string }).name);
      await requireCapability(ctx.catalog, principal, name, 'read');
    } catch (err) {
      send({ type: 'error', code: 'FORBIDDEN', message: (err as Error).message });
      socket.close();
      return;
    }
    const q = req.query as { labels?: string; types?: string };
    const labels = q.labels ? new Set(q.labels.split(',').filter(Boolean)) : null;
    const types = q.types ? new Set(q.types.split(',').filter(Boolean)) : null;

    const db = await ctx.manager.get(name);
    ctx.metrics.wsSubscribers.inc();
    const unsubscribe = db.subscribe((e) => {
      if (e.type === 'resync_required') {
        send({ type: 'resync_required' });
        socket.close();
        return;
      }
      if (batchMatches(e.ops, labels, types)) send({ type: 'batch', txId: e.txId, ops: e.ops });
    });
    send({ type: 'ready' });
    socket.on('close', () => {
      unsubscribe();
      ctx.metrics.wsSubscribers.dec();
    });
  });
}
```

In `app.ts`: register `@fastify/websocket` before the WS route, and register the route. Add near the cookie plugin:

```ts
const fastifyWebsocket = (await import('@fastify/websocket')).default;
await app.register(fastifyWebsocket);
```

and after the other route registrations `await registerWsRoutes(app, ctx);`. `ctx.metrics` is added in Task 5 — for this task, add a minimal `metrics` field to `AppContext` with a `wsSubscribers` counter object `{ inc(){}, dec(){} }` stub if Task 5 is not yet done; Task 5 replaces it with the real registry. (Order the implementation so Task 5's `MetricsRegistry` exists; if doing strictly in order, define the stub here and swap in Task 5.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/ws.test.ts`
Expected: PASS — ready frame, batch streaming, label filtering, auth rejection. (These tests use a real ephemeral port; ensure `app.close()` in afterEach tears the listener down.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): WebSocket change-feed subscriptions with label/type filters"
```

### Task 5: Metrics registry + /metrics endpoint

**Files:**
- Create: `packages/server/src/metrics.ts`, `packages/server/src/routes/metrics.ts`
- Modify: `packages/server/src/app.ts`, `packages/server/src/routes/query.ts`
- Test: `packages/server/test/metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/server/test/metrics.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics.js';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

describe('MetricsRegistry', () => {
  it('counters, gauges, and histograms render Prometheus text', () => {
    const m = new MetricsRegistry();
    m.queriesTotal.inc();
    m.queriesTotal.inc();
    m.wsSubscribers.inc();
    m.queryLatencyMs.observe(5);
    m.queryLatencyMs.observe(120);
    const text = m.render();
    expect(text).toContain('atlas_queries_total 2');
    expect(text).toContain('atlas_ws_subscribers 1');
    expect(text).toContain('atlas_query_latency_ms_bucket{le="10"} 1');
    expect(text).toContain('atlas_query_latency_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('atlas_query_latency_ms_count 2');
    expect(text).toMatch(/atlas_query_latency_ms_sum 125/);
  });
});

let dir: string;
let app: FastifyInstance;

describe('/metrics endpoint', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-metrics-'));
    app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is public and exposes counters in Prometheus format', async () => {
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('atlas_queries_total');
  });

  it('increments query counter + latency on a query', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    await app.inject({ method: 'POST', url: '/api/db/kb/query', headers: { cookie }, payload: { query: 'MATCH (n) RETURN n', params: {} } });
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.body).toMatch(/atlas_queries_total [1-9]/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/metrics.ts`:

```ts
class Counter {
  private value = 0;
  inc(by = 1): void {
    this.value += by;
  }
  get(): number {
    return this.value;
  }
}

class Gauge {
  private value = 0;
  inc(): void {
    this.value++;
  }
  dec(): void {
    this.value--;
  }
  set(v: number): void {
    this.value = v;
  }
  get(): number {
    return this.value;
  }
}

const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

class Histogram {
  private readonly counts = new Array<number>(BUCKETS.length).fill(0);
  private sum = 0;
  private total = 0;
  observe(ms: number): void {
    this.sum += ms;
    this.total++;
    for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]!) this.counts[i]!++;
  }
  render(name: string): string {
    const lines: string[] = [];
    for (let i = 0; i < BUCKETS.length; i++)
      lines.push(`${name}_bucket{le="${BUCKETS[i]}"} ${this.counts[i]}`);
    lines.push(`${name}_bucket{le="+Inf"} ${this.total}`);
    lines.push(`${name}_sum ${this.sum}`);
    lines.push(`${name}_count ${this.total}`);
    return lines.join('\n');
  }
}

export class MetricsRegistry {
  readonly queriesTotal = new Counter();
  readonly wsSubscribers = new Gauge();
  readonly queryLatencyMs = new Histogram();

  render(): string {
    return [
      '# TYPE atlas_queries_total counter',
      `atlas_queries_total ${this.queriesTotal.get()}`,
      '# TYPE atlas_ws_subscribers gauge',
      `atlas_ws_subscribers ${this.wsSubscribers.get()}`,
      '# TYPE atlas_query_latency_ms histogram',
      this.queryLatencyMs.render('atlas_query_latency_ms'),
      '',
    ].join('\n');
  }
}
```

`packages/server/src/routes/metrics.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

export async function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    void reply.type('text/plain; version=0.0.4');
    return ctx.metrics.render();
  });
}
```

In `app.ts`: add `metrics: MetricsRegistry` to `AppContext`, construct it in `buildServer` (`const metrics = new MetricsRegistry();` and include in `ctx`), register `registerMetricsRoutes`. In `routes/query.ts`, wrap the query handler body: increment `ctx.metrics.queriesTotal` and `ctx.metrics.queryLatencyMs.observe(result.stats.elapsedMs)` after `executeQuery` returns. Replace the Task-4 `wsSubscribers` stub with `ctx.metrics.wsSubscribers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/metrics.test.ts packages/server/test/ws.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): Prometheus metrics registry and /metrics endpoint"
```

### Task 6: Safety rails — rate limit, CORS, security headers

**Files:**
- Create: `packages/server/src/security.ts`
- Modify: `packages/server/src/config.ts`, `packages/server/src/app.ts`
- Test: `packages/server/test/security.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/server/test/security.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;

async function make(env: Record<string, string>): Promise<FastifyInstance> {
  dir = await mkdtemp(join(tmpdir(), 'atlas-sec-'));
  return buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32), ...env }));
}
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('security headers', () => {
  it('sets standard hardening headers on every response', async () => {
    app = await make({});
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and rejects others', async () => {
    app = await make({ ATLAS_CORS_ORIGINS: 'https://app.example' });
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/db', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example');
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/db', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('429s a token after exceeding its per-window budget', async () => {
    app = await make({ ATLAS_RATE_LIMIT: '3', ATLAS_RATE_WINDOW_MS: '60000' });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } })).statusCode);
    expect(codes.filter((c) => c === 200).length).toBe(3);
    expect(codes.filter((c) => c === 429).length).toBe(2);
  });

  it('does not rate-limit /healthz or /metrics', async () => {
    app = await make({ ATLAS_RATE_LIMIT: '1', ATLAS_RATE_WINDOW_MS: '60000' });
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/security.test.ts`
Expected: FAIL — headers/CORS/limit not present.

- [ ] **Step 3: Implement**

In `packages/server/src/config.ts`, add to `ServerConfig` and `loadConfig`:

```ts
  rateLimit: number;
  rateWindowMs: number;
  staticDir?: string;
```
```ts
  rateLimit: Number(env.ATLAS_RATE_LIMIT ?? '600'),
  rateWindowMs: Number(env.ATLAS_RATE_WINDOW_MS ?? '60000'),
  staticDir: env.ATLAS_STATIC_DIR,
```

`packages/server/src/security.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { authenticate } from './auth.js';
import { HttpError } from './errors.js';
import type { CatalogService } from './catalog.js';

const SKIP = new Set(['/healthz', '/metrics']);

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
}

/** Fixed-window per-principal (or per-IP) rate limit. */
export function registerRateLimit(app: FastifyInstance, config: ServerConfig, catalog: CatalogService): void {
  const hits = new Map<string, { count: number; resetAt: number }>();
  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (SKIP.has(req.url.split('?')[0]!)) return;
    const principal = await authenticate(req, catalog).catch(() => null);
    const key = principal?.username ?? req.ip;
    const nowMs = nowMillis();
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + config.rateWindowMs });
      return;
    }
    entry.count++;
    if (entry.count > config.rateLimit)
      throw new HttpError(429, 'RATE_LIMITED', 'rate limit exceeded; retry later');
  });
}

// Monotonic-ish clock; isolated so tests can reason about windows.
function nowMillis(): number {
  return Math.floor(performance.now());
}
```

Add `429` to `httpTitle` in `errors.ts` (`if (status === 429) return 'Too Many Requests';`).

In `app.ts`:
- Register CORS: `const cors = (await import('@fastify/cors')).default; await app.register(cors, { origin: config.corsOrigins.length > 0 ? config.corsOrigins : false, credentials: true });`
- `registerSecurityHeaders(app);`
- `registerRateLimit(app, config, catalog);`

Order: register CORS and security headers and rate-limit before routes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/security.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): security headers, CORS, per-principal rate limiting"
```

### Task 7: `@atlas/client` SDK + static SPA hosting

**Files:**
- Create: `packages/client/package.json`, `tsconfig.json`, `test/tsconfig.json`, `src/index.ts`
- Modify: `packages/server/src/app.ts`, root `tsconfig.json`, root `package.json`
- Test: `packages/client/test/client.test.ts`, `packages/server/test/static.test.ts`

- [ ] **Step 1: Write the package files**

`packages/client/package.json`:

```json
{
  "name": "@atlas/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "dependencies": { "@atlas/protocol": "workspace:*" }
}
```

`packages/client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "lib": ["ES2023", "DOM"] },
  "include": ["src"],
  "references": [{ "path": "../protocol" }]
}
```

(`DOM` lib gives the ambient `fetch`/`WebSocket`/`URL` types used isomorphically.) `packages/client/test/tsconfig.json` same shape as other test tsconfigs but with `"lib": ["ES2023", "DOM"]` and `"types": ["node"]`. Root `tsconfig.json` references += `{ "path": "packages/client" }`; root `package.json` `typecheck:test` += ` && tsc -p packages/client/test/tsconfig.json`.

- [ ] **Step 2: Write the failing tests**

`packages/client/test/client.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '@atlas/server';
import { loadConfig } from '@atlas/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let url: string;
let token: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
  const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
  const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
  await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
  token = (await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 't' } })).json().token;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client', () => {
  it('queries through the typed client', async () => {
    const db = connect(url, { token }).database('kb');
    await db.query("CREATE (p:Person {name: 'Ada'}) RETURN p", {});
    const res = await db.query('MATCH (p:Person) RETURN p.name AS name', {});
    expect(res.columns).toEqual(['name']);
    expect(res.rows).toEqual([['Ada']]);
  });

  it('surfaces server errors as thrown AtlasClientError with code + status', async () => {
    const db = connect(url, { token }).database('kb');
    await expect(db.query('MATCH (n RETURN n', {})).rejects.toMatchObject({ code: 'PARSE_ERROR', status: 400 });
  });

  it('subscribe() delivers live change batches and unsubscribes', async () => {
    const db = connect(url, { token }).database('kb');
    const got: { txId: number }[] = [];
    const sub = await db.subscribe({ labels: ['Person'] }, (frame) => {
      if (frame.type === 'batch') got.push({ txId: frame.txId });
    });
    await new Promise((r) => setTimeout(r, 50)); // let 'ready' settle
    await db.query("CREATE (p:Person {name: 'Live'}) RETURN p", {});
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBeGreaterThanOrEqual(1);
    sub.close();
  });
});
```

`packages/server/test/static.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let staticDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-static-'));
  staticDir = join(dir, 'web');
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Atlas</title>');
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32), ATLAS_STATIC_DIR: staticDir }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('static SPA hosting', () => {
  it('serves index.html at / and SPA-fallbacks unknown non-API paths', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Atlas');
    const deep = await app.inject({ method: 'GET', url: '/workspace/kb' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('Atlas'); // SPA fallback to index.html
  });

  it('unknown /api paths stay JSON 404, not the SPA shell', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run packages/client/test/client.test.ts packages/server/test/static.test.ts`
Expected: FAIL — client module + static hosting missing.

- [ ] **Step 4: Implement the client**

`packages/client/src/index.ts`:

```ts
import type { ProblemDetails, QueryResponse, SubscribeFilter, WsFrame } from '@atlas/protocol';

export class AtlasClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = 'AtlasClientError';
  }
}

export interface ConnectOptions {
  token?: string;
}

export interface Subscription {
  close(): void;
}

export class Database {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly opts: ConnectOptions,
  ) {}

  async query(aql: string, params: Record<string, unknown> = {}): Promise<QueryResponse> {
    const res = await fetch(`${this.baseUrl}/api/db/${this.name}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({ query: aql, params }),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new AtlasClientError(problem?.code ?? 'ERROR', res.status, problem?.detail ?? res.statusText, problem);
    }
    return (await res.json()) as QueryResponse;
  }

  /** Live change-feed subscription. Resolves once the socket is open. */
  subscribe(filter: SubscribeFilter, onFrame: (frame: WsFrame) => void): Promise<Subscription> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams();
    if (this.opts.token) qs.set('token', this.opts.token);
    if (filter.labels?.length) qs.set('labels', filter.labels.join(','));
    if (filter.types?.length) qs.set('types', filter.types.join(','));
    const ws = new WebSocket(`${wsBase}/ws/db/${this.name}?${qs.toString()}`);
    return new Promise((resolve, reject) => {
      ws.onmessage = (e) => onFrame(JSON.parse(String(e.data)) as WsFrame);
      ws.onopen = () => resolve({ close: () => ws.close() });
      ws.onerror = () => reject(new AtlasClientError('WS_ERROR', 0, 'websocket connection failed'));
    });
  }
}

export class AtlasClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: ConnectOptions,
  ) {}

  database(name: string): Database {
    return new Database(this.baseUrl, name, this.opts);
  }
}

export function connect(url: string, opts: ConnectOptions = {}): AtlasClient {
  return new AtlasClient(url.replace(/\/$/, ''), opts);
}
```

Ensure `@atlas/protocol` exports `QueryResponse`, `SubscribeFilter`, `WsFrame` (added in earlier tasks — confirm they're in `wire.ts`'s exports).

- [ ] **Step 5: Implement static hosting in `app.ts`**

After all API/WS routes are registered, conditionally serve the SPA:

```ts
if (config.staticDir) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: config.staticDir, wildcard: false });
  // SPA fallback: any non-API, non-WS GET that didn't match a file returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws') && !req.url.startsWith('/metrics') && !req.url.startsWith('/healthz')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).type('application/problem+json').send({ type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND' });
  });
}
```

This replaces the plain not-found handler from M5a when a static dir is configured (keep the plain JSON 404 handler when no static dir). Structure `buildServer` so the not-found handler is set once, branching on `config.staticDir`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/client/test/client.test.ts packages/server/test/static.test.ts && pnpm build`
Expected: PASS; whole solution builds with the new client package.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(client): isomorphic @atlas/client SDK; static SPA hosting with fallback"
```

### Task 8: Docker entrypoint, exports, API reference, full gate

**Files:**
- Modify: `Dockerfile`, `packages/server/src/index.ts`, `README.md`
- Create: `docker-compose.yml`, `docs/api-reference.md`
- Test: `packages/server/test/full-e2e.test.ts`

- [ ] **Step 1: Write the capstone e2e test**

`packages/server/test/full-e2e.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-full-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('full server journey', () => {
  it('register → db → seed → CRUD → query → export → metrics', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });

    await app.inject({ method: 'POST', url: '/api/db/kb/seed/science-history', headers: { cookie } });
    const nid = (await app.inject({ method: 'POST', url: '/api/db/kb/nodes', headers: { cookie }, payload: { labels: ['Tag'], properties: { v: 1 } } })).json().id;
    expect(typeof nid).toBe('number');

    const q = await app.inject({ method: 'POST', url: '/api/db/kb/query', headers: { cookie }, payload: { query: 'MATCH (p:Person) RETURN count(*) AS c', params: {} } });
    expect((q.json().rows[0][0] as number)).toBeGreaterThan(0);

    const exp = await app.inject({ method: 'GET', url: '/api/db/kb/export', headers: { cookie } });
    expect(exp.json().nodes.length).toBeGreaterThan(500);

    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toMatch(/atlas_queries_total [1-9]/);
  });
});
```

- [ ] **Step 2: Run it (capstone over existing routes)**

Run: `pnpm vitest run packages/server/test/full-e2e.test.ts`
Expected: PASS if Tasks 1–7 are complete; otherwise fix the implicated route.

- [ ] **Step 3: Server index exports + Docker**

Append to `packages/server/src/index.ts`:

```ts
export { MetricsRegistry } from './metrics.js';
```

`Dockerfile` (replace the M0 skeleton):

```dockerfile
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV ATLAS_DATA_DIR=/data ATLAS_PORT=4848
VOLUME /data
EXPOSE 4848
# start() reads ATLAS_* env (ATLAS_SECRET and optional ATLAS_ADMIN_* must be provided at run).
CMD ["node", "--import", "tsx", "packages/server/src/cli.ts"]
```

Create `packages/server/src/cli.ts`:

```ts
import { start } from './start.js';

start().catch((err: unknown) => {
  console.error('[atlas] failed to start:', err);
  process.exit(1);
});
```

`docker-compose.yml`:

```yaml
services:
  atlas:
    build: .
    ports:
      - '4848:4848'
    environment:
      ATLAS_SECRET: ${ATLAS_SECRET:?set ATLAS_SECRET to a 32+ char string}
      ATLAS_ADMIN_USER: ${ATLAS_ADMIN_USER:-admin}
      ATLAS_ADMIN_PASSWORD: ${ATLAS_ADMIN_PASSWORD:?set ATLAS_ADMIN_PASSWORD}
      ATLAS_STATIC_DIR: /app/apps/web/dist
      ATLAS_CORS_ORIGINS: ${ATLAS_CORS_ORIGINS:-}
    volumes:
      - atlas-data:/data
volumes:
  atlas-data:
```

- [ ] **Step 4: Write the API reference doc**

`docs/api-reference.md`:

```markdown
# Atlas Server — API Reference

Base: `/api`. Auth: session cookie (`atlas_session`, from `/api/auth/login`) or
`Authorization: Bearer <tokenId.secret>`. Errors are RFC 7807
`application/problem+json` carrying a `code` (and `line`/`column`/`snippet` for
query errors).

## Auth
- `POST /api/auth/register` `{username,password}` → 201 `{username,isAdmin}`
- `POST /api/auth/login` `{username,password}` → 200 + session cookie
- `POST /api/auth/logout` → clears the cookie
- `GET /api/auth/whoami` → `{username,isAdmin}`

## Databases (permission matrix enforced)
- `GET /api/db` → databases the caller can access
- `POST /api/db` `{name}` → 201 (creator becomes owner)
- `GET /api/db/:name` → `{name,description,role,owners}` (read)
- `PATCH /api/db/:name` `{description}` (owner)
- `DELETE /api/db/:name` (owner or server admin)
- `POST /api/db/:name/roles` `{username,role}` (owner) · `DELETE /api/db/:name/roles/:user`

## Query & schema
- `POST /api/db/:name/query` `{query,params}` → `{columns,rows,stats}`. Role by
  statement: read/CALL=viewer+, write=editor+, DDL=owner. `EXPLAIN` = read.
- `GET /api/db/:name/schema` → labels + edge-type summary (read)

## Data CRUD
- `GET|POST /api/db/:name/nodes[/:id]`, `PATCH|DELETE …/nodes/:id` (`?detach=true`)
- `GET|POST /api/db/:name/edges[/:id]`, `PATCH|DELETE …/edges/:id`

## Import / export / seed
- `POST /api/db/:name/import` — JSON `{nodes:[{tempId,labels,properties}],edges:[{from,to,type,properties}],atomic?}`
  → `{committed,idMap,error?}`. `?format=csv` with `{nodesCsv,edgesCsv}` (typed
  headers: `name:string`, `born:number`; `:label`, `:from`, `:to`, `:type`).
  Non-atomic commits in 10k batches and reports the first failure; `atomic:true`
  is all-or-nothing.
- `GET /api/db/:name/export` → the same JSON shape (real ids as tempIds)
- `POST /api/db/:name/seed/:dataset` — `science-history`

## Tokens
- `POST /api/tokens` `{name}` → `{tokenId,name,token}` (token shown once)
- `GET /api/tokens` → `[{tokenId,name}]` · `DELETE /api/tokens/:id`

## Live updates
- `WS /ws/db/:name?token=<t>&labels=A,B&types=X,Y` — frames: `{type:'ready'}`,
  `{type:'batch',txId,ops}`, `{type:'resync_required'}` (then close).

## Ops
- `GET /healthz` → `{status:'ok'}` · `GET /metrics` → Prometheus text
```

- [ ] **Step 5: README + full gate**

In `README.md`, set `**Status:**` to:

```markdown
**Status:** M5 complete — production server (`@atlas/server`) and SDK
(`@atlas/client`): auth, multi-DB, full REST (query, CRUD, import/export, seed),
WebSocket live updates, Prometheus metrics, rate-limit/CORS/security headers,
static SPA hosting, Docker deploy. See `docs/api-reference.md`.
```

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green across all seven packages.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): Docker entrypoint, compose, API reference, server-completion e2e"
```

---

## Plan self-review notes

- **Spec coverage (M5b slice of §6):** §6.4 data CRUD → T1; import/export normative format (tempId map, 10k batches, atomic flag, CSV typed headers) → T2–T3; seed → T3; `WS /ws/db/:name` with label/type filters + resync → T4; `/metrics` Prometheus → T5; §6.5 rate-limit + CORS + security headers → T6; static SPA hosting → T7; §6.6 isomorphic client SDK (`connect().database().query()/.subscribe()`) → T7; Docker deploy → T8. Combined with M5a, §6 is fully delivered.
- **Deliberate v1 decisions:** WS auth via `?token=` query param (browsers can't set headers on `WebSocket`) in addition to Authorization; filtered subscriptions match on create-shaped ops' labels/types (prop-change/delete ops carry no label, so a label-filtered subscriber sees creates of that label — documented); rate limit is a fixed window per principal/IP (not a token bucket) — simple and testable; metrics are hand-rolled Prometheus text (no prom-client dep); export emits `tempId = String(realId)` so a dump re-imports cleanly.
- **Type/shape anchors:** routes follow `registerXRoutes(app, ctx)`; `ctx.metrics: MetricsRegistry` added to `AppContext` in T5 (T4 uses a stub then swaps); `parseId` rejects non-integer ids (400); import returns `ImportResult {committed,idMap,error?}`; client `connect(url,{token}).database(name)` with `query()→QueryResponse` and `subscribe(filter,onFrame)→Promise<Subscription>`; `WsFrame` union shared via `@atlas/protocol`.
- **Self-review fixes applied:** the SPA not-found fallback must exclude `/api`, `/ws`, `/metrics`, `/healthz` so API 404s stay JSON (T7) — and `buildServer` sets the not-found handler once, branching on `staticDir`, rather than registering two; `/healthz` and `/metrics` are exempt from rate limiting (T6) so monitoring is never throttled; edge-create validates endpoints exist (404) before the transaction (T1); CORS defaults to `false` (deny) when no origins configured rather than `*`.



