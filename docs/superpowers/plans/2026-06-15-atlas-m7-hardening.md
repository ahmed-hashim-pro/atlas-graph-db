# Atlas M7 — Production Hardening + v1 Release Sign-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the feature-complete Atlas platform (M0–M6 merged: engine, AQL, server, client SDK, Explorer) over the v1 finish line via a focused hardening pass — a lean production Docker image running compiled output, structured server error signals (a real detach-required conflict code + failure-path metrics + a documented WS error frame), revocable server-side sessions, a case-insensitive ⌘K search backed by a new `lower()` AQL scalar, static-schema-validated `CALL … YIELD`, a focus-trapped ⌘K dialog with opener restoration, a benchmark sign-off with `docs/BENCHMARKS.md`, and a README/CHANGELOG/version pass that ends with the full gate green. New features that need new server endpoints or large UI surfaces are explicitly deferred to a documented v1.1 backlog.

**Architecture:** No new packages. Changes land in `@atlas/core` (one new AQL-supporting branch is in `@atlas/query`, not core), `@atlas/query` (`lower()` scalar in the parser/evaluator; static-schema YIELD validation in `call.ts`), `@atlas/server` (a dedicated `DETACH_REQUIRED` engine→HTTP mapping replacing a stringly-typed match; query-failure metrics via try/finally; a minimal server-side `Session` store in the catalog so logout/credential-change truly invalidate; a `maxAge` cookie), `@atlas/client` (no API change — it already replays the session cookie), `apps/web` (⌘K uses `lower()` for case-insensitive matching; the command palette traps Tab and restores focus to its opener), the Docker/compose deployment surface, and docs (`api-reference.md`, new `BENCHMARKS.md`, `CHANGELOG.md`, `README.md`). Sessions move from "username in a signed cookie" to "opaque session id in a signed cookie, resolved against a catalog-backed `Session` node"; bearer tokens are unchanged.

**Tech Stack:** Existing stack only — Node ≥22, pnpm 9.15.4, TypeScript 6, Vitest 4, ESLint 10, Prettier 3, Fastify 5 (`@fastify/cookie`/`cors`/`websocket`/`static`), `@node-rs/argon2`, zod 3; Angular 20.3 (standalone, signals, zoneless) with the `@angular/build:unit-test` Vitest runner (jsdom) and Playwright e2e. No new runtime dependencies. Library code uses ESM `.js` import extensions; Angular code uses bare specifiers. Library tests run via `pnpm vitest run <path>`; app tests via `pnpm -F web exec ng test --watch=false`; e2e via `pnpm -F web e2e` (root alias `pnpm e2e:web`), excluded from `pnpm test`. Benchmarks run via `node --expose-gc --import tsx packages/core/bench/*.bench.ts` with `SCALE`/`ASSERT_BUDGETS` env.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` — §2 (v1 capacity point + benchmark-enforced targets: **1M nodes / 5M edges within an 8 GB Node heap; 2-hop p95 < 50 ms; sustained ≥ 5k write ops/s; full recovery < 30 s**); §6.5 (safety rails + observability: rate limiting, timeouts/caps, CORS, security headers, **metrics — query latency histograms, WS subscriber counts**; the audit-log of write ops is acknowledged and explicitly deferred — see v1.1 backlog); §9 (one `AtlasError` hierarchy with stable string codes flowing engine → server problem-details → SDK → UI); §11 (single Docker image serving API + built SPA, volume-mounted data dir, env config, `docker compose up` out of the box, README documents backup/restore + upgrade); §12 **M7 = "benchmark sign-off vs §2 targets, docs, seed polish, release v1."**

**Existing code anchors (verified against source):**
- **Engine** (`@atlas/core`): `openDatabase(dir, opts?) → Promise<AtlasDatabase>`; `AtlasDatabase` has `transact(fn)`, `getNode`, `getEdge`, `outEdges`, `inEdges`, `nodesByLabel`, `graph()`, `schema()`, `stats(): { nodeCount; edgeCount }`, `checkpoint()`, `subscribe(fn)`, `close()`. `tx.deleteNode(id, { detach })` throws `new AtlasError('VALIDATION', 'node ${id} has ${n} edge(s); pass { detach: true }')` (`packages/core/src/tx.ts:77-81`). `AtlasError { code, message }` with `AtlasErrorCode = 'VALIDATION'|'NOT_FOUND'|'CONSTRAINT_VIOLATION'|'TIMEOUT'|'WAL_CORRUPT_TAIL'|'WAL_CORRUPT'|'INTERNAL'` (`packages/core/src/errors.ts`).
- **Query** (`@atlas/query`): `parseQuery(text) → { explain, statement }`; `executeQuery(db, text, { params, timeoutMs, maxRows }) → Promise<QueryResult>`. `Expr` includes `{ kind: 'call'; func; arg: Expr | '*'; distinct; pos }`; `SCALAR_FUNCS = new Set(['id','labels','type'])` and `AGGREGATES` in `ast.ts`. `evalExpr` `case 'call'` (`eval.ts:110-136`) handles only `id`/`labels`/`type` and requires the arg to be a bound record. `parsePrimary` (`parser.ts:270-290`) already parses `ident(arg)` into a `call` Expr with a lowercased `func`. `checkExprRefs` (`parser.ts:684-687`) fails `unknown function` unless `func ∈ AGGREGATES ∪ SCALAR_FUNCS`. `runCall` (`call.ts:110-139`) validates YIELD columns **only when `results.length > 0`** (`call.ts:128-129`) — an empty result skips validation; `ALGOS` enumerates every algorithm and the exact keys each result map carries.
- **Server** (`@atlas/server`): `toProblem(err) → { status, body: ProblemDetails }` with `ENGINE_STATUS`/`AQL_STATUS` maps + `HttpError` (`errors.ts`). `routes/data.ts:60-67` catches the engine error and remaps via `err.message.includes('edge')` to `HttpError(409,'CONFLICT',…)` — the stringly-typed signal to replace. `routes/query.ts:36-37` observes `ctx.metrics.queriesTotal.inc()` + `queryLatencyMs.observe(...)` **only after a successful `executeQuery`** (failures are not counted). `MetricsRegistry` (`metrics.ts`) has `queriesTotal: Counter`, `wsSubscribers: Gauge`, `queryLatencyMs: Histogram` (no error counter yet). `routes/ws.ts:44` already sends `{ type:'error', code, message }` WsFrame on a forbidden subscription. `authenticate(req, catalog)` (`auth.ts:19-50`) reads `req.cookies.atlas_session`, `unsignCookie`s it, and treats the **value as the username** (`findUser(unsigned.value)`); bearer is `id.secret` → `findToken` → `verifyToken`. `routes/auth.ts` login sets `setCookie('atlas_session', user.username, { httpOnly, sameSite:'lax', signed:true, path:'/' })` (no `maxAge`); logout `clearCookie`s. `CatalogService` (`catalog.ts`) dogfoods an Atlas db with `User`/`Database`/`Token` nodes + role/`HAS_TOKEN` edges and unique indexes; private `userNode`/`dbNode`/`tokenNode` lookups via the fluent API. `buildServer(config) → Promise<FastifyInstance>` (`app.ts`); `start(env=process.env)` listens + drains on SIGTERM/SIGINT (`start.ts`); `cli.ts` calls `start()`. Server tsconfig `include: ["src"]` compiles `cli.ts` → `packages/server/dist/cli.js` (verified present).
- **Deployment:** `Dockerfile` runs `node --import tsx packages/server/src/cli.ts` on TS source and copies the whole `/app` (dev deps included). `docker-compose.yml` sets `ATLAS_STATIC_DIR: /app/apps/web/dist` — **wrong**: the Angular `@angular/build:application` builder (project `web`, no explicit `outputPath`) emits the SPA to `apps/web/dist/web/browser/` with `index.html` there (verified). `config.ts` reads `staticDir = env.ATLAS_STATIC_DIR`; `app.ts:65-85` registers `@fastify/static` at that root with an SPA `index.html` fallback for non-`/api`/`/ws`/`/metrics`/`/healthz` GETs.
- **Bench:** `packages/core/bench/storage.bench.ts` (load throughput → `writeOpsPerSec`; 2-hop p95; `heapMb`; `recoveryMs`; asserts §2 budgets only when `ASSERT_BUDGETS=1` **and** `SCALE===1`; default `SCALE=0.05`) and `algo.bench.ts` (times pagerank/components/louvain/betweenness). `.github/workflows/nightly.yml` runs both at `SCALE=0.25` (workflow_dispatch input, default 0.25) on `ubuntu-latest`.
- **Explorer** (`apps/web`): `search/node-search.ts` `searchQuery(term, limit)` returns `MATCH (n) WHERE n.name CONTAINS $term OR n.title CONTAINS $term RETURN n LIMIT $limit` with `{ term: term.trim(), limit }` (case-SENSITIVE today) + `toHits(QueryResponse)`. `search/command-palette.ts` is a standalone signal component with `database` input, `pick`/`closed` outputs, `term`/`hits`/`active`/`busy` signals, `focusInput()`, `onKey(ev)` (Escape/Arrow/Enter), `choose(hit)`; `command-palette.html` is `role="dialog" aria-modal="true"` with a `role="listbox"`. `workspace/workspace.ts` hosts it: `paletteOpen` signal, `palette = viewChild(CommandPalette)`, `onHostKey` (⌘/Ctrl+K toggle), `openPalette()`/`closePalette()`, `onPick(hit)`. Three existing palette specs (`command-palette.spec.ts`) must stay green.

---

## File structure

```
Dockerfile                                  MODIFY (T1): run compiled dist/cli.js; prune dev deps
docker-compose.yml                          MODIFY (T1): fix ATLAS_STATIC_DIR to the real SPA path
.dockerignore                               CREATE (T1): keep node_modules/dist/git out of build ctx
scripts/verify-dist.mjs                     CREATE (T1): assert dist/cli.js boots + serves /healthz, fails on bad env
package.json                                MODIFY (T1): add "verify:dist" script

packages/core/src/errors.ts                 MODIFY (T2): add 'DETACH_REQUIRED' code
packages/core/src/tx.ts                     MODIFY (T2): throw DETACH_REQUIRED (not VALIDATION) for incident edges
packages/core/test/tx.test.ts              MODIFY (T2): assert the new code
packages/server/src/errors.ts               MODIFY (T2): map DETACH_REQUIRED → 409 CONFLICT
packages/server/src/metrics.ts              MODIFY (T2): add queryErrorsTotal counter + render line
packages/server/src/routes/data.ts          MODIFY (T2): drop the message.includes('edge') hack
packages/server/src/routes/query.ts         MODIFY (T2): observe metrics in try/finally; count failures
packages/server/test/errors.test.ts         MODIFY (T2): DETACH_REQUIRED → 409
packages/server/test/data-routes.test.ts    MODIFY (T2): 409 body carries code DETACH_REQUIRED
packages/server/test/metrics.test.ts        MODIFY (T2): a failing query increments error + total
docs/api-reference.md                        MODIFY (T2): document the 409 code + the WS error frame

packages/server/src/catalog.ts              MODIFY (T3): Session node CRUD (create/find/delete/deleteForUser)
packages/server/src/auth.ts                 MODIFY (T3): resolve cookie → session id → user
packages/server/src/routes/auth.ts          MODIFY (T3): login mints a session id; logout deletes it; maxAge cookie
packages/server/src/config.ts               MODIFY (T3): sessionTtlMs from ATLAS_SESSION_TTL_MS
packages/server/test/catalog.test.ts        MODIFY (T3): session CRUD persistence
packages/server/test/auth-routes.test.ts    MODIFY (T3): login→use→logout→old cookie 401

packages/query/src/ast.ts                   MODIFY (T4): SCALAR_FUNCS += 'lower'
packages/query/src/eval.ts                  MODIFY (T4): evaluate lower(<string>) before the record branch
packages/query/test/eval.test.ts            MODIFY (T4): lower() lowercases / non-strings → null
packages/query/test/parser.test.ts          MODIFY (T4): lower() parses + validates as a scalar
apps/web/src/app/search/node-search.ts      MODIFY (T4): lower(n.name)/lower(n.title) CONTAINS lower($term)
apps/web/src/app/search/node-search.spec.ts MODIFY (T4): assert the case-insensitive query shape

packages/query/src/call.ts                  MODIFY (T5): validate YIELD vs a static ALGO_COLUMNS schema
packages/query/test/call.test.ts            MODIFY (T5): typo'd YIELD on an empty-result algo → SEMANTIC_ERROR

apps/web/src/app/search/command-palette.ts   MODIFY (T6): capture opener, restore on close, trap Tab
apps/web/src/app/search/command-palette.html  MODIFY (T6): bind Tab handling on the dialog
apps/web/src/app/search/command-palette.spec.ts MODIFY (T6): focus restore + Tab trap specs

packages/core/bench/storage.bench.ts        (T7: run only — no edit needed)
packages/core/bench/algo.bench.ts           (T7: run only — no edit needed)
docs/BENCHMARKS.md                          CREATE (T7): methodology + results vs §2 + release-gate command
.github/workflows/nightly.yml               MODIFY (T7): add a CI-feasible SCALE=0.05 bench smoke step

README.md                                   MODIFY (T8): v1 quickstart, feature list, architecture-in-words, links
CHANGELOG.md                                CREATE (T8): v1.0.0 release notes
packages/*/package.json, apps/web/package.json MODIFY (T8): version 0.0.0 → 1.0.0 (private packages)
```

Conventions: ESM `.js` import extensions in library code; Angular uses bare specifiers + signals + zoneless. Library tests `pnpm vitest run <path>`; app tests `pnpm -F web exec ng test --watch=false`; e2e `pnpm -F web e2e` (never bare `vitest`/watch). Prettier `{ singleQuote: true, printWidth: 100 }`. Commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Production Docker image — compiled output, pruned deps, fixed static path, verification

Ship a lean runtime image that runs the **compiled** `packages/server/dist/cli.js` (not `tsx` on TS source) with dev dependencies pruned, fix `docker-compose.yml`'s `ATLAS_STATIC_DIR` to the real Angular build output, and add a node verification script that proves the built CLI boots and serves `/healthz` with good env and fails cleanly with bad env. Docker itself is not assumed available in CI, so the gate-able check is the node script over `dist`.

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, root `package.json`
- Create: `.dockerignore`, `scripts/verify-dist.mjs`

- [ ] **Step 1: Write the failing verification script**

`scripts/verify-dist.mjs`:

```js
// Verifies the COMPILED server boots from packages/server/dist/cli.js:
//  (a) dist/cli.js exists after `pnpm build`;
//  (b) with a bad env (no ATLAS_SECRET) the process exits non-zero, cleanly;
//  (c) with good env it serves GET /healthz → {status:'ok'}, then is terminated.
// Run AFTER `pnpm build`. Usage: node scripts/verify-dist.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'packages/server/dist/cli.js';
const SECRET = 's'.repeat(32);

function run(env) {
  return spawn(process.execPath, [CLI], { env: { ...process.env, ...env }, stdio: 'pipe' });
}
function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}
async function poll(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never answered ${url}`);
}

async function main() {
  await access(CLI); // (a) throws if `pnpm build` did not emit dist/cli.js

  // (b) bad env: missing ATLAS_SECRET → loadConfig throws → cli.ts exits 1.
  const bad = run({ ATLAS_DATA_DIR: '/tmp/atlas-verify-bad', ATLAS_SECRET: '' });
  const badCode = await waitExit(bad);
  if (badCode === 0) throw new Error('expected non-zero exit with a bad env, got 0');

  // (c) good env: serves /healthz, then SIGTERM drains it.
  const dir = await mkdtemp(join(tmpdir(), 'atlas-verify-'));
  const good = run({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: SECRET, ATLAS_PORT: '4900' });
  try {
    const res = await poll('http://127.0.0.1:4900/healthz');
    const body = await res.json();
    if (body.status !== 'ok') throw new Error(`/healthz returned ${JSON.stringify(body)}`);
    good.kill('SIGTERM');
    await waitExit(good);
  } finally {
    good.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
  console.log('verify-dist: OK (dist/cli.js boots, bad env fails, /healthz serves)');
}

main().catch((err) => {
  console.error('verify-dist: FAIL —', err.message);
  process.exit(1);
});
```

Add to root `package.json` `scripts`: `"verify:dist": "node scripts/verify-dist.mjs"`.

- [ ] **Step 2: Run the script to verify it fails (before the build emits dist, or before deps are linked)**

Run: `pnpm install && pnpm build && pnpm verify:dist`
Expected at this point: PASS only if the build already emitted `dist/cli.js` (it does — verified present). If you run it BEFORE `pnpm build` it FAILs at `access(CLI)`. This is a verification script, not a unit test; treat a clean PASS after `pnpm build` as the success condition. (Run it once now to confirm the harness works against current `dist`.)

- [ ] **Step 3: Fix the Dockerfile to run compiled output and prune dev deps**

Replace `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# --- build stage: install everything, compile libs + SPA ---
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# --- deploy stage: production deps only ---
FROM node:22-slim AS deploy
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
# Drop dev dependencies (tsx, eslint, vitest, the Angular toolchain, …) from the
# runtime image; the compiled JS in each package's dist/ is all the server needs.
RUN pnpm prune --prod

# --- runtime image ---
FROM node:22-slim
WORKDIR /app
COPY --from=deploy /app /app
ENV ATLAS_DATA_DIR=/data ATLAS_PORT=4848
VOLUME /data
EXPOSE 4848
# Run the COMPILED entrypoint (no tsx, no TS source at runtime). start() reads
# ATLAS_* env; ATLAS_SECRET and optional ATLAS_ADMIN_* are provided at run.
CMD ["node", "packages/server/dist/cli.js"]
```

Create `.dockerignore` so the build context (and the `COPY . .`) excludes throwaway artifacts that would otherwise bloat layers / shadow the fresh build:

```
node_modules
**/node_modules
**/dist
apps/web/dist
apps/web/.angular
.git
*.log
```

- [ ] **Step 4: Fix the compose static path**

Edit `docker-compose.yml` — the SPA is built by `@angular/build:application` (project `web`, no `outputPath`) to `apps/web/dist/web/browser/` with `index.html` there. Point `ATLAS_STATIC_DIR` at that directory:

```yaml
      ATLAS_STATIC_DIR: /app/apps/web/dist/web/browser
```

(Leave the rest of `docker-compose.yml` unchanged: it already requires `ATLAS_SECRET`/`ATLAS_ADMIN_PASSWORD`, defaults `ATLAS_ADMIN_USER=admin`, and mounts the `atlas-data` volume at `/data`.)

- [ ] **Step 5: Verify the build emits a runnable compiled CLI**

Run: `pnpm build && pnpm verify:dist`
Expected: `verify-dist: OK …` — `dist/cli.js` exists, a missing-secret start exits non-zero cleanly, and a good-env start serves `/healthz` then drains on SIGTERM. (Docker layer correctness is documented for manual `docker build .` verification in T8's README; the node check is the CI-feasible gate.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(server): production Docker image runs compiled dist/cli.js with pruned deps; fix static dir + dist verification"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 2: Server robustness — structured detach conflict, failure-path metrics, documented WS error frame

Replace the `err.message.includes('edge')` heuristic in `routes/data.ts` with a real engine error code (`DETACH_REQUIRED`) mapped to 409 in `toProblem`. Count query failures in metrics (a `queryErrorsTotal` counter plus `queriesTotal`/latency in a `try/finally`). Document the 409 code and the existing WS error frame in `docs/api-reference.md`. Unit-test each.

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/tx.ts`, `packages/core/test/tx.test.ts`
- Modify: `packages/server/src/errors.ts`, `packages/server/src/metrics.ts`, `packages/server/src/routes/data.ts`, `packages/server/src/routes/query.ts`
- Modify: `packages/server/test/errors.test.ts`, `packages/server/test/data-routes.test.ts`, `packages/server/test/metrics.test.ts`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/tx.test.ts` (a focused regression alongside the existing detach behavior):

```ts
import { AtlasError } from '../src/errors.js';
// ...existing imports/harness...

it('deleting a node with incident edges throws DETACH_REQUIRED (a distinct code)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-detach-'));
  const db = await openDatabase(dir);
  let a = 0;
  await db.transact((tx) => {
    a = tx.createNode(['P'], {});
    const b = tx.createNode(['P'], {});
    tx.createEdge('R', a, b);
  });
  await expect(db.transact((tx) => tx.deleteNode(a))).rejects.toMatchObject({
    code: 'DETACH_REQUIRED',
  });
  expect(() => {
    throw new AtlasError('DETACH_REQUIRED', 'x');
  }).toThrow(AtlasError);
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
```

Update `packages/server/test/errors.test.ts` — the engine `DETACH_REQUIRED` maps to 409:

```ts
it('maps DETACH_REQUIRED to 409 Conflict', () => {
  const { status, body } = toProblem(new AtlasError('DETACH_REQUIRED', 'node 1 has 2 edge(s)'));
  expect(status).toBe(409);
  expect(body.code).toBe('DETACH_REQUIRED');
  expect(body.title).toBe('Conflict');
});
```

Update the existing 409 assertion in `packages/server/test/data-routes.test.ts` (`'DELETE a node with edges needs ?detach=true'`) to also assert the structured code on the 409 body:

```ts
    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/db/kb/nodes/${a}`,
      headers: { cookie: owner },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('DETACH_REQUIRED');
```

(Keep the follow-up `?detach=true` → 204 assertion as-is.)

Add to the `/metrics endpoint` describe block in `packages/server/test/metrics.test.ts` — a failing query is still counted (inline register→login→createDatabase, matching the file's existing "increments query counter" test which uses no shared helper):

```ts
  it('a failed query increments queryErrorsTotal and queriesTotal, not just successes', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ada', password: 'secret12' },
    });
    const l = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    const cookie = `atlas_session=${l.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });

    // An invalid query (empty RETURN → parse error) 400s and must still be
    // metered (the route counts parse failures before re-throwing).
    const bad = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie },
      payload: { query: 'MATCH (n) RETURN', params: {} },
    });
    expect(bad.statusCode).toBe(400);
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/atlas_query_errors_total [1-9]/);
    expect(metrics).toMatch(/atlas_queries_total [1-9]/);
  });
```

> `MATCH (n) RETURN` (empty RETURN list) throws an `AqlError` at parse time inside `capabilityFor`; the route's `catch (parseErr)` block increments both counters before re-throwing, so the 400 is still metered. The assertion (both counters > 0) is the contract.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/tx.test.ts packages/server/test/errors.test.ts packages/server/test/data-routes.test.ts packages/server/test/metrics.test.ts`
Expected: FAIL — `DETACH_REQUIRED` is not a code yet, `toProblem` has no mapping, the engine still throws `VALIDATION`, and failed queries are not metered.

- [ ] **Step 3: Implement the engine code**

`packages/core/src/errors.ts` — add the new code to the union (after `'CONSTRAINT_VIOLATION'`):

```ts
export type AtlasErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONSTRAINT_VIOLATION'
  /** A node still has incident edges; deletion needs { detach: true }. */
  | 'DETACH_REQUIRED'
  | 'TIMEOUT'
  | 'WAL_CORRUPT_TAIL'
  | 'WAL_CORRUPT'
  | 'INTERNAL';
```

`packages/core/src/tx.ts` — change the throw at lines 77-81 from `'VALIDATION'` to `'DETACH_REQUIRED'`:

```ts
      if (!opts.detach)
        throw new AtlasError(
          'DETACH_REQUIRED',
          `node ${id} has ${incident.size} edge(s); pass { detach: true }`,
        );
```

- [ ] **Step 4: Implement the server mapping + failure metrics**

`packages/server/src/errors.ts` — add `DETACH_REQUIRED: 409` to `ENGINE_STATUS`:

```ts
const ENGINE_STATUS: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONSTRAINT_VIOLATION: 409,
  DETACH_REQUIRED: 409,
  TIMEOUT: 504,
  WAL_CORRUPT: 500,
  WAL_CORRUPT_TAIL: 500,
  INTERNAL: 500,
};
```

`packages/server/src/metrics.ts` — add the error counter and render it:

```ts
export class MetricsRegistry {
  readonly queriesTotal = new Counter();
  readonly queryErrorsTotal = new Counter();
  readonly wsSubscribers = new Gauge();
  readonly queryLatencyMs = new Histogram();

  render(): string {
    return [
      '# TYPE atlas_queries_total counter',
      `atlas_queries_total ${this.queriesTotal.get()}`,
      '# TYPE atlas_query_errors_total counter',
      `atlas_query_errors_total ${this.queryErrorsTotal.get()}`,
      '# TYPE atlas_ws_subscribers gauge',
      `atlas_ws_subscribers ${this.wsSubscribers.get()}`,
      '# TYPE atlas_query_latency_ms histogram',
      this.queryLatencyMs.render('atlas_query_latency_ms'),
      '',
    ].join('\n');
  }
}
```

`packages/server/src/routes/data.ts` — drop the message-string heuristic; let the engine's `DETACH_REQUIRED` flow straight through `toProblem` (which now maps it to 409). Replace the `try/catch` in the node DELETE handler (lines 60-67) with a direct call:

```ts
    const detach = (req.query as { detach?: string }).detach === 'true';
    await db.transact((tx) => tx.deleteNode(id, { detach }));
    void reply.status(204);
```

Remove the now-unused `AtlasError` import from `routes/data.ts` (keep `type AtlasDatabase`).

`packages/server/src/routes/query.ts` — meter successes AND failures via `try/finally`. Authorization (`requireCapability` → 403) is NOT a query failure, so it stays OUTSIDE the metered block; **parse** errors and **execution** errors ARE query failures, so the metered block wraps `parseQuery` (via `capabilityFor`) AND `executeQuery`:

```ts
  app.post('/api/db/:name/query', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    const body = QueryReq.parse(req.body);
    // capabilityFor parses the query; a parse error here is a query failure, so it
    // is metered below. Compute the capability eagerly to gate authorization, but
    // re-throw inside the metered block if parsing failed.
    let cap: Capability;
    try {
      cap = capabilityFor(body.query);
    } catch (parseErr) {
      ctx.metrics.queriesTotal.inc();
      ctx.metrics.queryErrorsTotal.inc();
      throw parseErr; // AqlError → 400 via the error handler
    }
    await requireCapability(ctx.catalog, req.principal!, name, cap);
    const db = await ctx.manager.get(name);
    let ok = false;
    try {
      const result = await executeQuery(db, body.query, {
        params: body.params,
        timeoutMs: ctx.config.queryTimeoutMs,
        maxRows: ctx.config.maxRows,
      });
      ok = true;
      ctx.metrics.queryLatencyMs.observe(result.stats.elapsedMs);
      return result;
    } finally {
      ctx.metrics.queriesTotal.inc();
      if (!ok) ctx.metrics.queryErrorsTotal.inc();
    }
  });
```

> This meters BOTH a parse failure (counted in the `catch (parseErr)` block before re-throwing) and an execution failure (counted in the `finally`). A 403 from `requireCapability` is intentionally not counted as a query (no query ran).

- [ ] **Step 5: Document the 409 code and the WS error frame**

Edit `docs/api-reference.md`. Under **Data CRUD**, append a line:

```markdown
- `DELETE …/nodes/:id` on a node with incident edges → 409 `application/problem+json`
  with `code: "DETACH_REQUIRED"`. Pass `?detach=true` to remove the node and its edges.
```

Replace the **Live updates** section so it documents all four frames including `error`:

```markdown
## Live updates
- `WS /ws/db/:name?token=<t>&labels=A,B&types=X,Y` — server→client frames:
  `{type:'ready'}` (subscription active), `{type:'batch',txId,ops}` (a committed
  transaction matching the label/type filter), `{type:'resync_required'}` (the
  change feed is stale; the client should reload — the socket then closes), and
  `{type:'error',code,message}` (e.g. `code:"FORBIDDEN"` when the caller may not
  read the database; the socket then closes). Authentication failures abort the
  upgrade before `open` (the client never sees a frame).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/test/tx.test.ts packages/server/test/errors.test.ts packages/server/test/data-routes.test.ts packages/server/test/metrics.test.ts && pnpm build`
Expected: PASS — engine throws `DETACH_REQUIRED`, the 409 body carries the code, a failed query increments both counters, build clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): structured DETACH_REQUIRED 409, query-failure metrics, documented WS error frame"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 3: Revocable server-side sessions

Move sessions from "username in a signed cookie" to "opaque session id in a signed cookie, resolved against a catalog-backed `Session` node." Logout deletes the session row (so an old cookie 401s); a credential change can revoke all of a user's sessions. Bearer tokens are unchanged. Add a cookie `maxAge`.

**Files:**
- Modify: `packages/server/src/catalog.ts`, `packages/server/src/auth.ts`, `packages/server/src/routes/auth.ts`, `packages/server/src/config.ts`
- Modify: `packages/server/test/catalog.test.ts`, `packages/server/test/auth-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/catalog.test.ts` (a `Session` suite mirroring the existing token suite):

```ts
describe('sessions', () => {
  it('creates, finds, deletes, and bulk-revokes sessions for a user', async () => {
    await cat.createUser('ada', 'h', false);
    const s1 = await cat.createSession('ada');
    const s2 = await cat.createSession('ada');
    expect(s1).not.toBe(s2);
    expect(await cat.findSessionUser(s1)).toBe('ada');
    expect(await cat.findSessionUser('nope')).toBeNull();

    await cat.deleteSession(s1);
    expect(await cat.findSessionUser(s1)).toBeNull();
    expect(await cat.findSessionUser(s2)).toBe('ada'); // unaffected

    await cat.deleteSessionsForUser('ada');
    expect(await cat.findSessionUser(s2)).toBeNull();
  });

  it('sessions survive reopen', async () => {
    await cat.createUser('ada', 'h', false);
    const sid = await cat.createSession('ada');
    await cat.close();
    const c2 = await CatalogService.open(join(dir, '_catalog'));
    expect(await c2.findSessionUser(sid)).toBe('ada');
    await c2.close();
    cat = await CatalogService.open(join(dir, '_catalog')); // for afterEach
  });
});
```

Add to `packages/server/test/auth-routes.test.ts` — the revocation round-trip:

```ts
it('logout invalidates the session: the old cookie is rejected with 401', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'ada', password: 'secret12' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'ada', password: 'secret12' },
  });
  const cookie = `atlas_session=${login.cookies.find((c) => c.name === 'atlas_session')!.value}`;

  // The fresh cookie works.
  expect((await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { cookie } })).statusCode).toBe(200);

  // Log out (server-side session deleted), then the SAME cookie value 401s.
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  const after = await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { cookie } });
  expect(after.statusCode).toBe(401);
  expect(after.json().code).toBe('UNAUTHENTICATED');
});
```

> The pre-M7 test that relied on a username-bearing cookie surviving logout (if any) must be updated to this revocable behavior — do NOT weaken this assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/server/test/catalog.test.ts packages/server/test/auth-routes.test.ts`
Expected: FAIL — `createSession`/`findSessionUser`/`deleteSession`/`deleteSessionsForUser` do not exist; logout does not invalidate server-side (the old cookie still resolves to the username).

- [ ] **Step 3: Implement the catalog Session store**

In `packages/server/src/catalog.ts`:

Add `'Session'` uniqueness in `CatalogService.open` (after the `Token` index):

```ts
    await ensure('unique', 'Session', 'sid');
```

Add a `SessionRow`-free minimal API (sessions are an opaque id → username edge `(:User)-[:HAS_SESSION]->(:Session {sid, createdAt})`), placed after the tokens section:

```ts
  // ---- sessions (server-side, revocable) ----
  /** Mint an opaque session id bound to a user; returned id goes in the signed cookie. */
  async createSession(username: string): Promise<string> {
    const user = this.requireUserNode(username);
    const sid = randomBytes(24).toString('base64url');
    await this.db.transact((tx) => {
      const s = tx.createNode(['Session'], { sid, createdAt: nowIso() });
      tx.createEdge('HAS_SESSION', user.id, s);
    });
    return sid;
  }

  /** Resolve a session id to its owning username, or null if unknown/revoked. */
  async findSessionUser(sid: string): Promise<string | null> {
    const s = this.sessionNode(sid);
    if (!s) return null;
    for (const e of this.db.inEdges(s.id, 'HAS_SESSION')) {
      const u = this.db.getNode(e.from);
      if (u) return String(u.props.username);
    }
    return null;
  }

  /** Revoke one session (logout). */
  async deleteSession(sid: string): Promise<void> {
    const s = this.sessionNode(sid);
    if (!s) return;
    await this.db.transact((tx) => tx.deleteNode(s.id, { detach: true }));
  }

  /** Revoke every session for a user (e.g. on a credential change). */
  async deleteSessionsForUser(username: string): Promise<void> {
    const user = this.userNode(username);
    if (!user) return;
    const sessionIds: NodeId[] = [];
    for (const e of this.db.outEdges(user.id, 'HAS_SESSION')) sessionIds.push(e.to);
    if (sessionIds.length === 0) return;
    await this.db.transact((tx) => {
      for (const id of sessionIds) tx.deleteNode(id, { detach: true });
    });
  }
```

Add the private lookup alongside `userNode`/`dbNode`/`tokenNode`:

```ts
  private sessionNode(sid: string) {
    return (
      this.db
        .graph()
        .nodes('Session')
        .where((p) => p.sid === sid)
        .first() ?? null
    );
  }
```

- [ ] **Step 4: Resolve the cookie via the session store**

`packages/server/src/auth.ts` — in `authenticate`, replace the cookie branch (lines 27-34) so the cookie value is a session id resolved to a username:

```ts
  const sid = req.cookies?.atlas_session;
  if (sid) {
    const unsigned = req.unsignCookie(sid);
    if (unsigned.valid && unsigned.value) {
      const username = await catalog.findSessionUser(unsigned.value);
      if (username) {
        const user = await catalog.findUser(username);
        if (user) return { username: user.username, isAdmin: user.isAdmin };
      }
    }
  }
```

(The bearer-token branch below it is unchanged.)

- [ ] **Step 5: Mint/clear the session in the auth routes + add maxAge**

`packages/server/src/config.ts` — add `sessionTtlMs` to `ServerConfig` and `loadConfig` (default 7 days):

```ts
export interface ServerConfig {
  // ...existing fields...
  sessionTtlMs: number;
}
```
```ts
    sessionTtlMs: Number(env.ATLAS_SESSION_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000)),
```

`packages/server/src/routes/auth.ts` — login mints a session id and sets it (with `maxAge` in seconds); logout deletes the session row before clearing the cookie:

```ts
  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginReq.parse(req.body);
    const user = await ctx.catalog.findUser(body.username);
    if (!user || !(await verifyPassword(user.passwordHash, body.password)))
      throw new HttpError(401, 'UNAUTHENTICATED', 'invalid username or password');
    const sid = await ctx.catalog.createSession(user.username);
    void reply.setCookie('atlas_session', sid, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
    });
    const info: UserInfo = { username: user.username, isAdmin: user.isAdmin };
    return info;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies?.atlas_session;
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await ctx.catalog.deleteSession(unsigned.value);
    }
    void reply.clearCookie('atlas_session', { path: '/' });
    return { ok: true };
  });
```

(Register and whoami are unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/server/test/catalog.test.ts packages/server/test/auth-routes.test.ts packages/server/test/app-base.test.ts packages/server/test/e2e.test.ts packages/server/test/full-e2e.test.ts && pnpm build`
Expected: PASS — session CRUD persists, login→use→logout→old cookie 401, and the existing app/e2e journeys (which login then use the cookie) still pass with the indirection. Build clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): revocable server-side sessions (opaque cookie id, catalog-backed) with maxAge"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 4: Case-insensitive ⌘K search via a `lower()` AQL scalar

**Decision (lower-risk option chosen):** add a `lower()` scalar function to AQL rather than wiring the fulltext index through the client. Rationale: `lower()` is a tiny, well-contained addition to the existing scalar-function machinery (`parsePrimary` already parses `ident(arg)`; `evalExpr` already has a `'call'` branch), needs no new engine API or index plumbing, and lets ⌘K do `lower(n.name) CONTAINS lower($term)` for true case-insensitive substring matching. Exposing the fulltext index through AQL/the client would mean a new client method, a new server path, and reconciling fulltext tokenization semantics — out of scope for a hardening pass.

**Files:**
- Modify: `packages/query/src/ast.ts`, `packages/query/src/eval.ts`
- Modify: `packages/query/test/eval.test.ts`, `packages/query/test/parser.test.ts`
- Modify: `apps/web/src/app/search/node-search.ts`, `apps/web/src/app/search/node-search.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/query/test/eval.test.ts` (mirror its existing `evalExpr`/`parseExpression` harness):

```ts
it('lower() lowercases a string argument', () => {
  // Build via the parser so we exercise the real call-Expr shape.
  const e = parseExpression(tokenize("lower('AdA LoVeLaCe')"));
  expect(evalExpr(e, new Map(), { params: {}, source: '' })).toBe('ada lovelace');
});

it('lower() of a non-string (or missing prop) is null, never throws', () => {
  const e = parseExpression(tokenize('lower($n)'));
  expect(evalExpr(e, new Map(), { params: { n: 42 }, source: '' })).toBeNull();
});
```

> Use whatever the suite already imports to turn source into a `TokenStream` (`tokenize`/`lex` + `parseExpression`); match the existing tests in `eval.test.ts`.

Add to `packages/query/test/parser.test.ts`:

```ts
it('lower() parses as a scalar function and validates', () => {
  const e = parseExpression(tokenize('lower(n.name)'));
  expect(e.kind).toBe('call');
  if (e.kind === 'call') expect(e.func).toBe('lower');
});

it('an unknown function is still rejected (lower allowed, frobnicate not)', () => {
  expect(() => parseQuery('MATCH (n) RETURN frobnicate(n.name)')).toThrowError(/unknown function/);
  expect(() => parseQuery('MATCH (n) RETURN lower(n.name)')).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/query/test/eval.test.ts packages/query/test/parser.test.ts`
Expected: FAIL — `lower` is not in `SCALAR_FUNCS` (validator throws `unknown function`), and `evalExpr`'s `'call'` branch requires the arg to be a bound record so `lower('x')` errors.

- [ ] **Step 3: Implement the scalar**

`packages/query/src/ast.ts` — add `lower` to the allowed scalar set:

```ts
export const SCALAR_FUNCS = new Set(['id', 'labels', 'type', 'lower']);
```

`packages/query/src/eval.ts` — handle `lower` at the top of the `'call'` branch, BEFORE the aggregate/record checks (it takes any expression and returns a lowercased string, or null for non-strings — consistent with the engine's null-on-type-mismatch convention):

```ts
    case 'call': {
      if (AGGREGATES.has(e.func))
        throw new AqlError(
          'RUNTIME_ERROR',
          `aggregate ${e.func}() must be handled by the executor`,
          e.pos,
          ctx.source,
        );
      if (e.func === 'lower') {
        const v = e.arg === '*' ? null : evalExpr(e.arg, binding, ctx);
        return typeof v === 'string' ? v.toLowerCase() : null;
      }
      const arg = e.arg === '*' ? null : evalExpr(e.arg, binding, ctx);
      // ...unchanged id()/labels()/type() handling below...
```

- [ ] **Step 4: Use `lower()` in the ⌘K search query + update the spec**

`apps/web/src/app/search/node-search.ts` — rewrite `searchQuery` to be case-insensitive and update the doc comment (the old comment claimed no `toLower` exists — that is now false):

```ts
/**
 * Build a parameterized, case-INSENSITIVE AQL query that finds nodes whose
 * `name` or `title` CONTAINS the term, ignoring case. The term and limit are
 * always bound as `$term`/`$limit` (never interpolated) so the search is
 * injection-safe. Case-insensitivity uses the `lower()` AQL scalar (added in
 * @atlas/query): `lower(n.name) CONTAINS lower($term)`. `CONTAINS` is the engine
 * `text` op (string operands only), so non-string props simply don't match.
 */
export function searchQuery(
  term: string,
  limit: number,
): {
  query: string;
  params: { term: string; limit: number };
} {
  const query =
    'MATCH (n) WHERE lower(n.name) CONTAINS lower($term) OR lower(n.title) CONTAINS lower($term) RETURN n LIMIT $limit';
  return { query, params: { term: term.trim(), limit } };
}
```

`apps/web/src/app/search/node-search.spec.ts` — update/add the query-shape assertion:

```ts
it('builds a case-insensitive, parameterized search query', () => {
  const { query, params } = searchQuery('  AdA  ', 25);
  expect(query).toContain('lower(n.name) CONTAINS lower($term)');
  expect(query).toContain('lower(n.title) CONTAINS lower($term)');
  expect(query).toContain('LIMIT $limit');
  expect(params).toEqual({ term: 'AdA', limit: 25 });
});
```

(`toHits` is unchanged; keep its existing specs green.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/query/test/eval.test.ts packages/query/test/parser.test.ts && pnpm -F web exec ng test --watch=false`
Expected: PASS — `lower()` evaluates/validates; the search query is case-insensitive; the existing palette/search specs still pass (`toHits` and the palette's call to `searchQuery` are shape-compatible).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(query): lower() AQL scalar; case-insensitive ⌘K node search"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 5: `CALL … YIELD` validation against a static algorithm schema

Today `runCall` validates requested YIELD columns only against `results[0]` and only when `results.length > 0` (`call.ts:128-129`) — so a typo'd YIELD on an empty result (e.g. `algo.cycles` on an acyclic graph) is silently accepted and returns nulls. Validate against the algorithm's STATIC output schema (the columns each `ALGOS` entry produces) so a bad YIELD always raises `SEMANTIC_ERROR`.

**Files:**
- Modify: `packages/query/src/call.ts`
- Modify: `packages/query/test/call.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/query/test/call.test.ts`. The shared `beforeEach` builds a 3-cycle, on which `algo.cycles` returns rows and `algo.topoSort` THROWS `VALIDATION` (verified against `algo-dag.test.ts`). To exercise an **empty result with a valid static schema**, build a fresh acyclic database in-test and use `algo.cycles` (static columns `['cycle']`), which returns `[]` on an acyclic graph:

```ts
describe('CALL YIELD validation uses the static algorithm schema', () => {
  it("rejects a typo'd YIELD even when the result set is empty", async () => {
    // A fresh acyclic 2-node graph → algo.cycles returns ZERO rows, but "cyc"
    // is still an invalid column for algo.cycles (valid: cycle).
    const d2 = await mkdtemp(join(tmpdir(), 'atlas-call-empty-'));
    const db2 = await openDatabase(d2);
    await db2.transact((tx) => {
      const a = tx.createNode(['V'], {});
      const b = tx.createNode(['V'], {});
      tx.createEdge('R', a, b); // acyclic → no cycles
    });
    await expect(
      runCall(call('CALL algo.cycles() YIELD cyc'), db2, {}),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ERROR' });
    // A valid YIELD on the same empty result returns the column with no rows.
    const ok = await runCall(call('CALL algo.cycles() YIELD cycle'), db2, {});
    expect(ok.columns).toEqual(['cycle']);
    expect(ok.rows).toEqual([]);
    await db2.close();
    await rm(d2, { recursive: true, force: true });
  });

  it("still rejects a typo'd YIELD on a non-empty result (regression)", async () => {
    // The shared 3-cycle db has nodes, so algo.degree returns rows; "scor" is invalid.
    await expect(
      runCall(call('CALL algo.degree() YIELD node, scor'), db, {}),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ERROR' });
  });
});
```

> `mkdtemp`/`openDatabase`/`rm`/`tmpdir`/`join` are already imported at the top of `call.test.ts` (verified). `algo.cycles` static columns are `['cycle']`; on an acyclic graph it returns `[]`, so this exercises the empty-result path the fix targets.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/query/test/call.test.ts`
Expected: FAIL — the typo'd-YIELD-on-empty case is accepted today (no error thrown).

- [ ] **Step 3: Implement static-schema validation**

`packages/query/src/call.ts` — add a static column map next to `ALGOS` (the exact keys each runner produces) and validate YIELD against it:

```ts
/** Static output columns each algorithm yields — used to validate YIELD even on empty results. */
const ALGO_COLUMNS: Record<string, readonly string[]> = {
  'algo.pagerank': ['node', 'score'],
  'algo.louvain': ['node', 'community'],
  'algo.components': ['node', 'component'],
  'algo.degree': ['node', 'score'],
  'algo.betweenness': ['node', 'score'],
  'algo.shortestPath': ['path', 'cost'],
  'algo.allShortestPaths': ['path', 'cost'],
  'algo.bfs': ['node', 'depth'],
  'algo.dfs': ['node', 'depth'],
  'algo.topoSort': ['node', 'order'],
  'algo.cycles': ['cycle'],
};
```

Replace the YIELD-validation loop (currently `call.ts:127-135`) with one that checks the static schema:

```ts
  const cols = stmt.yields.length > 0 ? stmt.yields : inferColumns(results);
  const schema = ALGO_COLUMNS[stmt.name];
  for (const y of cols) {
    const known = schema ? schema.includes(y.name) : results.length > 0 && y.name in results[0]!;
    if (!known)
      throw new AqlError(
        'SEMANTIC_ERROR',
        `procedure "${stmt.name}" does not yield "${y.name}"`,
        stmt.pos,
        '',
      );
  }
```

> Every key in `ALGOS` has an entry in `ALGO_COLUMNS` (kept in lockstep). The `schema ? … : …` fallback preserves the old behavior for any future runner added without a schema entry — but the lint/test gate below makes the lockstep explicit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/query/test/call.test.ts`
Expected: PASS — typo'd YIELD on an empty result is now `SEMANTIC_ERROR`; valid YIELD on an empty result returns the columns with no rows; the non-empty typo case still fails; all existing CALL tests stay green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(query): validate CALL YIELD against each algorithm's static output schema"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 6: ⌘K focus trap + opener restoration

Make the command-palette dialog accessible per §7.5: capture `document.activeElement` when it opens, restore focus to that element when it closes (Escape/backdrop/pick), and trap Tab/Shift+Tab within the dialog so focus cannot leak to the page behind the modal. Keep the three existing palette specs green.

**Files:**
- Modify: `apps/web/src/app/search/command-palette.ts`, `apps/web/src/app/search/command-palette.html`
- Modify: `apps/web/src/app/search/command-palette.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/app/search/command-palette.spec.ts`:

```ts
it('restores focus to the opener element when closed', () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const { fixture } = setup();
  fixture.detectChanges();
  fixture.componentInstance.captureOpener(); // workspace calls this when it opens the palette
  fixture.componentInstance.focusInput();

  fixture.componentInstance.close(); // emits closed AND restores focus
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('traps Tab within the dialog (focusables stay inside)', () => {
  const { fixture } = setup();
  fixture.detectChanges();
  const root = (fixture.nativeElement as HTMLElement).querySelector('.palette') as HTMLElement;
  const focusables = root.querySelectorAll<HTMLElement>('input, [tabindex]:not([tabindex="-1"])');
  // The search input is focusable; trapTab keeps focus inside rather than escaping.
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  const handled = fixture.componentInstance.onKey(ev);
  // onKey returns void; assert it prevented default when wrapping at the edge.
  expect(focusables.length).toBeGreaterThan(0);
  expect(ev.defaultPrevented || focusables.length === 1).toBe(true);
});
```

> Keep the existing three specs (`runs the search…`, `arrow keys…`, `Escape emits close`). The Escape spec calls `cmp.onKey(Escape)` and expects `closed` to fire — `close()` must still emit `closed`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `captureOpener`/`close` do not exist; Tab is not trapped.

- [ ] **Step 3: Implement the focus trap + restoration**

`apps/web/src/app/search/command-palette.ts` — add opener capture, a `close()` that restores + emits, and Tab trapping in `onKey`:

```ts
export class CommandPalette {
  // ...existing fields (api, database, pick, closed, searchBox, term, hits, active, busy)...

  /** The element focused before the palette opened; restored on close. */
  private opener: HTMLElement | null = null;

  /** Workspace calls this right before it shows the palette so we can restore focus later. */
  captureOpener(): void {
    const el = document.activeElement;
    this.opener = el instanceof HTMLElement ? el : null;
  }

  focusInput(): void {
    this.searchBox()?.nativeElement.focus();
  }

  /** Close: restore focus to the opener, then notify the host to unmount us. */
  close(): void {
    this.opener?.focus();
    this.opener = null;
    this.closed.emit();
  }

  // ...search() unchanged...

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.close();
      return;
    }
    if (ev.key === 'Tab') {
      this.trapTab(ev);
      return;
    }
    const hits = this.hits();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (hits.length) this.active.set((this.active() + 1) % hits.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (hits.length) this.active.set((this.active() - 1 + hits.length) % hits.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const hit = hits[this.active()];
      if (hit) this.pick.emit(hit);
    }
  }

  /** Keep Tab focus inside the dialog (wrap at the first/last focusable). */
  private trapTab(ev: KeyboardEvent): void {
    const root = this.searchBox()?.nativeElement.closest('.palette') as HTMLElement | null;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, button, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const activeEl = document.activeElement;
    if (ev.shiftKey && activeEl === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && activeEl === last) {
      ev.preventDefault();
      first.focus();
    } else if (items.length === 1) {
      ev.preventDefault(); // single focusable → stay put
    }
  }

  choose(hit: NodeHit): void {
    this.pick.emit(hit);
  }
}
```

`apps/web/src/app/search/command-palette.html` — route the backdrop close through `close()` so it also restores focus, and ensure the dialog's `keydown` already calls `onKey` (it does). Change the backdrop handlers:

```html
<div
  class="palette-backdrop"
  role="button"
  tabindex="-1"
  aria-label="Close search"
  (click)="close()"
  (keydown.escape)="close()"
></div>
```

(The dialog `(keydown)="onKey($event)"` is unchanged; `onKey` now handles Tab + Escape.)

`apps/web/src/app/workspace/workspace.ts` — capture the opener when toggling/opening the palette so restoration targets the real opener. In `onHostKey` and `openPalette`, call `captureOpener()` before focusing:

```ts
  onHostKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      this.paletteOpen.update((v) => !v);
      if (this.paletteOpen())
        queueMicrotask(() => {
          this.palette()?.captureOpener();
          this.palette()?.focusInput();
        });
    }
  }

  openPalette(): void {
    this.paletteOpen.set(true);
    queueMicrotask(() => {
      this.palette()?.captureOpener();
      this.palette()?.focusInput();
    });
  }
```

> The palette's `closed` output already drives `closePalette()` (sets `paletteOpen=false`); `onPick` also sets it false. No host template change needed beyond keeping `(closed)="closePalette()"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — focus restores to the opener on close, Tab is trapped, and the three original specs (search/arrows/Escape) still pass (Escape now flows through `close()` which still emits `closed`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): ⌘K command palette focus trap + opener restoration"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 7: Benchmark sign-off + `docs/BENCHMARKS.md` + CI smoke

Run both bench harnesses at a CI-feasible scale (`SCALE=0.05`), capture the numbers, and write `docs/BENCHMARKS.md` documenting the methodology, the captured results, and the **release-gate command** (`ASSERT_BUDGETS=1 SCALE=1`) that asserts the §2 targets at the capacity point. Add a CI-feasible bench smoke step to the nightly lane.

**Files:**
- Run only (no edit): `packages/core/bench/storage.bench.ts`, `packages/core/bench/algo.bench.ts`
- Create: `docs/BENCHMARKS.md`
- Modify: `.github/workflows/nightly.yml`

- [ ] **Step 1: Run the benches at a representative scale and capture the JSON**

Run (after `pnpm build`):

```bash
SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts
SCALE=0.05 node --expose-gc --import tsx packages/core/bench/algo.bench.ts
```

`storage.bench.ts` prints a `console.table` plus a JSON line: `{ SCALE, nodeCount, edgeCount, loadMs, writeOpsPerSec, p95TwoHopMs, heapMb, recoveryMs }`. `algo.bench.ts` prints a `console.table` of `{ name, ms }` per algorithm. **Record the actual numbers from this run** — paste them verbatim into `docs/BENCHMARKS.md` Step 2 (do not invent values).

- [ ] **Step 2: Write `docs/BENCHMARKS.md`**

`docs/BENCHMARKS.md` (fill the two results tables with the numbers captured in Step 1; the example rows below are placeholders to replace with the real `SCALE=0.05` output — the §2 target column is fixed):

```markdown
# Atlas Benchmarks

Atlas tracks the spec §2 v1 capacity-point targets from M1 onward. Two harnesses
live in `packages/core/bench/`; both build a deterministic synthetic graph
(`@atlas/datasets` `generateGraph`, seed 42) sized by a `SCALE` factor where
`SCALE=1` is the capacity point (**1,000,000 nodes / 5,000,000 edges**).

## §2 targets (capacity point, SCALE=1)

| Target | Budget |
|---|---|
| Heap (resident graph) | ≤ 8 GB (8192 MB) |
| 2-hop traversal p95 | < 50 ms |
| Sustained write throughput | ≥ 5,000 ops/s |
| Full recovery (snapshot load + WAL replay + index rebuild) | < 30 s |

## Methodology

- **storage.bench.ts** loads N nodes then E edges in 10k-op transactions
  (group commit), measures load throughput (`(N+E)/loadMs`), samples 2-hop
  traversal latency over 100 random starts (p95), captures heap via
  `process.memoryUsage().heapUsed` after a forced GC, then checkpoints, closes,
  reopens, and times recovery.
- **algo.bench.ts** loads the same graph and times pagerank, weak/strong
  components, louvain, and sampled betweenness (k=64).
- Run with `node --expose-gc --import tsx` so the heap reading is post-GC.

## Results — representative CI scale (SCALE=0.05 → 50k nodes / 250k edges)

> Captured on the M7 sign-off run (replace with your machine's output).

| Metric | Value |
|---|---|
| loadMs | _<from run>_ |
| writeOpsPerSec | _<from run>_ |
| p95TwoHopMs | _<from run>_ |
| heapMb | _<from run>_ |
| recoveryMs | _<from run>_ |

| Algorithm | ms |
|---|---|
| pagerank | _<from run>_ |
| components weak | _<from run>_ |
| components strong | _<from run>_ |
| louvain | _<from run>_ |
| betweenness k=64 | _<from run>_ |

The `SCALE=0.05` run validates the harness and tracks trends; it is **not** the
release gate (the targets in the table above are defined at `SCALE=1`).

## Release gate (capacity point) — manual, large-runner step

The §2 budgets are asserted only at the capacity point. On a machine with
≥ 8 GB free heap headroom (run Node with a raised old-space if needed):

```bash
pnpm build
NODE_OPTIONS=--max-old-space-size=10240 \
  ASSERT_BUDGETS=1 SCALE=1 \
  node --expose-gc --import tsx packages/core/bench/storage.bench.ts
```

With `ASSERT_BUDGETS=1` and `SCALE=1` the harness throws if heap > 8192 MB, 2-hop
p95 > 50 ms, recovery > 30 s, or write throughput < 5000/s, and prints
`all §2 budgets met at capacity point` on success. This is the v1 release gate;
it is intentionally not part of `pnpm test` (it needs a large runner and minutes
to run). Record the capacity-point output here when the gate is run for a release.

> v1.0.0 sign-off: run the capacity-point gate on the release runner and paste
> the `{…}` JSON line + the "all §2 budgets met" confirmation below. (If not yet
> executed on a large runner, this section documents the exact command to run.)
```

- [ ] **Step 2b: Run the capacity-point gate if a large runner is available**

If (and only if) a machine with sufficient heap is available, run the release-gate command from Step 2 and paste its output into the BENCHMARKS.md sign-off block. **Do NOT claim the SCALE=1 run passed unless it was actually executed** — otherwise leave it documented as the release-gate step (the §2 budgets are still enforced by the assertion when run).

- [ ] **Step 3: Add a CI-feasible bench smoke to the nightly lane**

Edit `.github/workflows/nightly.yml` — add a fast `SCALE=0.05` smoke step (always runs, completes in seconds) before the heavier scaled runs, so a broken harness is caught nightly even when the large scale is skipped:

```yaml
      - run: pnpm build
      - name: bench smoke (SCALE=0.05, validates the harness)
        run: |
          SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts
          SCALE=0.05 node --expose-gc --import tsx packages/core/bench/algo.bench.ts
      - run: SCALE=${{ github.event.inputs.scale || '0.25' }} node --expose-gc --import tsx packages/core/bench/storage.bench.ts
      - run: SCALE=${{ github.event.inputs.scale || '0.25' }} node --expose-gc --import tsx packages/core/bench/algo.bench.ts
```

(Remove the now-duplicate standalone `- run: pnpm build` if one already precedes the scaled runs — keep a single build step.)

- [ ] **Step 4: Verify the benches and docs**

Run: `SCALE=0.05 node --expose-gc --import tsx packages/core/bench/storage.bench.ts`
Expected: prints a report table + a JSON line with all five metrics; the numbers match what you pasted into `docs/BENCHMARKS.md`. Confirm `docs/BENCHMARKS.md` has no remaining `_<from run>_` placeholders.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(bench): BENCHMARKS.md sign-off vs §2 targets; nightly bench smoke"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 8: Release polish — README, CHANGELOG, version bumps, full gate

Bring the README to a v1 quickstart (docker compose up, API + AQL reference links, feature list, architecture-in-words), write a v1.0.0 CHANGELOG, bump the private package versions to 1.0.0, and land the full gate green.

**Files:**
- Modify: `README.md`, all `packages/*/package.json`, `apps/web/package.json`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Rewrite the README status/quickstart**

Replace the `**Status:**` block and add a quickstart + feature list + architecture-in-words + reference links in `README.md`:

```markdown
**Status:** v1.0.0 — production-ready. A from-scratch embedded graph engine
(WAL + snapshots + crash recovery, transactions, property/unique/fulltext
indexes, traversals, graph algorithms, a change feed) under a full AQL query
language, a multi-user Fastify server (argon2id auth with revocable sessions +
API tokens, a permission matrix, a system catalog that dogfoods the engine,
REST + WebSocket, import/export, Prometheus `/metrics`, rate limiting, CORS,
security headers, static SPA hosting), a typed isomorphic client SDK, and the
Knowledge Graph Explorer (Angular 20, standalone + signals + zoneless: graph
canvas, AQL console, schema + algorithms views, data import, ⌘K node search,
token/role admin). Benchmark targets per §2 are tracked in `docs/BENCHMARKS.md`.

## Quickstart (Docker)

```bash
export ATLAS_SECRET=$(openssl rand -base64 32)   # 32+ chars, session signing
export ATLAS_ADMIN_USER=admin
export ATLAS_ADMIN_PASSWORD=change-me-please
docker compose up --build
# Explorer + API on http://localhost:4848  (SPA served from the same origin)
```

The server serves the built SPA and the API from one origin; the data directory
is a mounted volume (`atlas-data` → `/data`). Configuration is via env
(`ATLAS_DATA_DIR`, `ATLAS_PORT`, `ATLAS_SECRET`, `ATLAS_ADMIN_USER/PASSWORD`,
`ATLAS_QUERY_TIMEOUT_MS`, `ATLAS_MAX_ROWS`, `ATLAS_RATE_LIMIT`,
`ATLAS_CORS_ORIGINS`, `ATLAS_SESSION_TTL_MS`, `ATLAS_STATIC_DIR`).

### Backup / restore

The entire database lives under `ATLAS_DATA_DIR` (snapshots + WAL per database,
plus the `_catalog`). Back up by snapshotting the volume while the server is
stopped (or after a checkpoint); restore by replacing the directory. The
WAL/snapshot format carries a version header (forward-compatible reads within a
major version).

## Features

- **Engine:** crash-safe WAL with group commit + background snapshots; recovery
  with torn-tail truncation; property, unique, and fulltext indexes; BFS/DFS,
  shortest paths, PageRank, components, Louvain, betweenness, topo-sort, cycles;
  a label/type-filtered change feed.
- **AQL:** MATCH/WHERE/RETURN, CREATE/MERGE/SET/REMOVE/DELETE, variable-length
  paths, aggregates, `lower()`/`id()`/`labels()`/`type()` scalars, `CALL algo.*`
  with YIELD, EXPLAIN, parameters, timeouts, and row caps.
- **Server:** argon2id auth (revocable server-side sessions + bearer tokens), a
  viewer/editor/owner permission matrix, lazy per-database engines, import/export
  (JSON + CSV), Prometheus `/metrics`, rate limiting, CORS, security headers.
- **Explorer:** graph canvas (Web Worker layout, Canvas2D), AQL console, schema +
  algorithms views, data import, case-insensitive ⌘K node search, token + role
  admin, three themes.

## Architecture (in words)

`@atlas/core` is the embedded engine (storage, WAL, snapshots, indexes,
traversals, algorithms, change feed). `@atlas/query` is the AQL lexer → parser →
planner → executor over the engine. `@atlas/protocol` holds the zod wire schemas
shared by server and client. `@atlas/server` is a Fastify app: a `DatabaseManager`
opens user databases lazily; a `CatalogService` stores users, tokens, sessions,
databases, and role grants as an Atlas database (the platform dogfoods its own
engine); routes enforce the permission matrix and surface RFC 7807 problem-details
carrying engine/AQL codes. `@atlas/client` is the typed isomorphic SDK.
`@atlas/datasets` provides curated + synthetic seed graphs (the latter drives the
benchmarks). `apps/web` is the Angular Explorer, talking to the server only
through `@atlas/client`.

## Reference

- API: [`docs/api-reference.md`](docs/api-reference.md)
- AQL: [`docs/aql-reference.md`](docs/aql-reference.md)
- Benchmarks: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Design spec: `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md`
```

(Keep the existing `## Develop` and `## Benchmark` sections; ensure the `## Benchmark` section links to `docs/BENCHMARKS.md`.)

- [ ] **Step 2: Write the CHANGELOG**

`CHANGELOG.md`:

```markdown
# Changelog

## 1.0.0 — 2026-06-15

First production release of Atlas: an embedded graph engine, AQL query language,
multi-user server, client SDK, and the Knowledge Graph Explorer.

### Engine (`@atlas/core`)
- Crash-safe WAL (group commit) + background snapshots; recovery with torn-tail
  truncation and index rebuild.
- Property / unique / fulltext indexes; transactions; traversals.
- Algorithms: BFS, DFS, shortest path(s), PageRank, weak/strong components,
  Louvain, betweenness, topological sort, cycle detection.
- Change feed with label/type filtering.

### Query (`@atlas/query`)
- Full AQL: MATCH/WHERE/RETURN, CREATE/MERGE/SET/REMOVE/DELETE, variable-length
  paths, aggregates, EXPLAIN, parameters, timeouts, row caps.
- Scalar functions `id()`, `labels()`, `type()`, and `lower()` (case-insensitive
  matching).
- `CALL algo.*` with YIELD, validated against each algorithm's static schema.

### Server (`@atlas/server`)
- Argon2id auth: revocable server-side sessions (opaque cookie id) + bearer API
  tokens; viewer/editor/owner permission matrix; system catalog dogfooding the
  engine.
- REST + WebSocket; import/export (JSON + CSV); RFC 7807 problem-details carrying
  engine/AQL codes (including `DETACH_REQUIRED` → 409).
- Observability: Prometheus `/metrics` (query count, query errors, latency
  histogram, WS subscribers); rate limiting; CORS; security headers; static SPA
  hosting.

### Client (`@atlas/client`)
- Typed isomorphic SDK (cookie + bearer modes): auth, databases, query, schema,
  subscribe, tokens, roles, import/export.

### Explorer (`apps/web`)
- Angular 20 (standalone, signals, zoneless): graph canvas, AQL console, schema
  and algorithms views, data import, case-insensitive ⌘K node search (focus-
  trapped dialog), token + role admin, three themes.

### Deployment
- Single multi-stage Docker image running compiled output with pruned production
  dependencies; `docker compose up` serves the Explorer + API from one origin.

### Benchmarks
- §2 capacity-point targets (1M nodes / 5M edges in 8 GB heap; 2-hop p95 < 50 ms;
  ≥ 5k write ops/s; recovery < 30 s) tracked in `docs/BENCHMARKS.md`, asserted by
  the release-gate command and the nightly bench lane.
```

- [ ] **Step 3: Bump versions to 1.0.0**

Set `"version": "1.0.0"` in each `packages/*/package.json` (`core`, `query`, `protocol`, `server`, `client`, `datasets`) and `apps/web/package.json`. (The root `package.json` has no `version` field — leave it; it stays `private` without one.) These are private workspace packages, so `workspace:*` dependency specs are unaffected.

- [ ] **Step 4: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test && pnpm verify:dist`
Expected: all green — `tsc -b` builds the libraries, the Angular builder builds the app, `typecheck:test` covers every test/bench tsconfig, eslint + prettier pass, `pnpm test` runs the library Vitest suite plus the app `ng test` suite, and `verify:dist` confirms the compiled CLI boots and serves `/healthz`.

- [ ] **Step 5: Run the e2e separately (excluded from the default gate)**

Run: `pnpm -F web e2e`
Expected: PASS — the existing Playwright suites (`explorer`, `workspace`, `console`, `explorer-m6d`). The M6d e2e searches ⌘K with `Ada`; case-insensitive search still matches it, so the suite stays green. If the built static path differs, ensure `playwright.config.ts`'s `ATLAS_STATIC_DIR` points at `apps/web/dist/web/browser` (the same path T1 set in compose) and rerun.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(release): v1.0.0 — README quickstart, CHANGELOG, version bumps, full gate green"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Spec coverage

| Spec ref | Requirement | Task(s) |
|---|---|---|
| §11 | single Docker image serving API + built SPA; runs compiled output; `docker compose up` works; README documents backup/restore + config | T1 (compiled `dist/cli.js`, pruned deps, fixed `ATLAS_STATIC_DIR` → `apps/web/dist/web/browser`, `.dockerignore`, `verify-dist` boot/healthz check), T8 (README quickstart + backup/restore + env list) |
| §9 | one `AtlasError` hierarchy with stable string codes flowing engine → server problem-details → SDK → UI; no silent failures | T2 (`DETACH_REQUIRED` engine code → `toProblem` 409, replacing a message-string heuristic; documented WS `error` frame), T5 (`CALL YIELD` typos always raise `SEMANTIC_ERROR`, no silent null columns) |
| §6.5 | observability — query latency histograms, WS subscriber counts; safety rails | T2 (`atlas_query_errors_total` + metering query FAILURES, not just successes), T3 (revocable sessions strengthen the auth rail), T8 (README documents rate-limit/CORS/security-header config). **Audit-log of write ops: acknowledged, deferred to v1.1 (new endpoint + UI).** |
| §6.2 / §6.6 | argon2id sessions + bearer tokens; logout truly invalidates; SDK unchanged | T3 (opaque session id in the signed cookie, catalog-backed `Session` node; logout deletes it; bulk-revoke for credential changes; `maxAge`; bearer tokens untouched; client needs no change) |
| §5.2 / §7.2 | AQL scalar functions; Workspace ⌘K node search | T4 (`lower()` scalar in parser+evaluator; ⌘K becomes case-insensitive via `lower(n.name) CONTAINS lower($term)`) |
| §5.2 / §5.4 | `CALL … YIELD` validated; precise query errors | T5 (YIELD validated against each algorithm's static output schema, including empty results) |
| §7.5 | keyboard nav, visible focus, ARIA on the ⌘K modal dialog | T6 (opener capture + focus restoration on close; Tab/Shift+Tab trap inside `role="dialog" aria-modal`) |
| §2 | benchmark-verified capacity targets (1M/5M in 8 GB; 2-hop p95 < 50 ms; ≥ 5k write ops/s; recovery < 30 s) | T7 (`SCALE=0.05` sign-off run captured in `docs/BENCHMARKS.md`; `ASSERT_BUDGETS=1 SCALE=1` documented as the release gate; nightly bench smoke) |
| §12 (M7) | "benchmark sign-off vs §2 targets, docs, seed polish, release v1" | T7 (bench sign-off), T8 (docs/README/CHANGELOG/version bumps + full gate); all eight tasks constitute the hardening pass and v1 release |

## Plan self-review notes

- **Targets real surfaces only.** Every file, line anchor, signature, and error string was read from source before writing the tasks: the `tx.ts:77-81` `VALIDATION` throw and `data.ts:60-67` `message.includes('edge')` heuristic (T2); `query.ts:36-37` success-only metering and `metrics.ts`'s three instruments (T2); `auth.ts:27-34` username-in-cookie resolution and `routes/auth.ts` login/logout cookie handling (T3); `eval.ts:110-136` `'call'` branch, `ast.ts:22` `SCALAR_FUNCS`, `parser.ts:270-290` generic `ident(arg)` parsing and `parser.ts:684-687` `unknown function` validation (T4); `call.ts:127-135` YIELD validation and the `ALGOS` map keys (T5); `command-palette.ts`/`.html` `onKey`/`focusInput`/`role="dialog"` and `workspace.ts` `onHostKey`/`openPalette`/`paletteOpen`/`viewChild(CommandPalette)` (T6); both bench harnesses' env/output contract and `nightly.yml` (T7); the verified Angular output path `apps/web/dist/web/browser` and that the server tsconfig compiles `cli.ts` → `dist/cli.js` (T1/T8).
- **Deliberate decisions.**
  - *Case-insensitive search → `lower()` AQL scalar* (T4), not fulltext-through-AQL: lowest risk — reuses the existing scalar-function machinery, no new engine/index/client plumbing, and gives true case-insensitive substring matching. The old `node-search.ts` doc comment (which asserted no `toLower` exists) is corrected.
  - *Session store design* (T3): an opaque random session id in the existing signed cookie, resolved against a catalog-backed `(:User)-[:HAS_SESSION]->(:Session {sid})` node — minimal, persistent across restarts, dogfoods the engine like the rest of the catalog, makes logout a real revocation, and adds a bulk-revoke for credential changes. Bearer tokens are deliberately unchanged (they already cover revocable programmatic access). A `maxAge` is added. The change is invisible to `@atlas/client` (it just replays the cookie), so no SDK edit is needed.
  - *Detach signal* (T2): a new engine code `DETACH_REQUIRED` (not reusing `CONSTRAINT_VIOLATION`, which means a uniqueness/constraint failure) → mapped to 409, so the server stops pattern-matching error messages. Both engine and server tests assert the code.
  - *Bench scale rationale* (T7): `SCALE=0.05` (50k/250k) completes in seconds and validates the harness in CI; the §2 budgets are defined at `SCALE=1` and asserted only by the documented `ASSERT_BUDGETS=1 SCALE=1` release-gate command (the harness itself gates assertions on `SCALE===1`). The plan does NOT claim the capacity-point run passed unless actually executed on a large runner — it documents the exact gate command.
  - *Docker verification* (T1): Docker may be unavailable in CI, so the gate-able check is a node script over the compiled `dist` (exists + bad-env-fails + good-env-serves-/healthz); the actual `docker build .` is documented for manual verification.
- **No invented endpoints or features.** This is a hardening pass: no new REST/WS routes, no new client methods, no new pages. The one new capability is the `lower()` AQL scalar (a function, not an endpoint) and a catalog-internal `Session` node (no new route — login/logout already exist).
- **v1.1 backlog (explicitly deferred — NEW features needing new server endpoints or large UI; NOT built here):**
  1. **Global user-management UI + endpoint** — there is no `GET /api/users`/admin user CRUD route; a management screen needs a new server surface.
  2. **Audit-log of write operations (UI + endpoint)** — §6.5 names it; no audit store or endpoint exists. Deferred (new persistence + endpoint + UI), acknowledged in the spec-coverage table.
  3. **Editable database-settings UI** — `PATCH /api/db/:name` exists, but a settings form is net-new UI, not hardening.
  4. **Inline AQL CodeMirror squiggle decoration** — §7.2 mentions error squiggles in the console editor; this is a new editor-decoration feature, deferred from M6 and again here.
  These are listed so they are tracked, not implemented in M7.
- **Cross-task consistency.** `DETACH_REQUIRED` is identical across `errors.ts` (core), `errors.ts` (server `ENGINE_STATUS`), `data-routes.test.ts`, and `api-reference.md`. The metrics name `atlas_query_errors_total` matches between `metrics.ts` and the metrics test. `lower` is identical across `ast.ts` `SCALAR_FUNCS`, `eval.ts`, the query tests, and `node-search.ts`. `ALGO_COLUMNS` keys are kept in lockstep with `ALGOS`. The session API (`createSession`/`findSessionUser`/`deleteSession`/`deleteSessionsForUser`) is identical across `catalog.ts`, `auth.ts`, `routes/auth.ts`, and the catalog/auth tests. `captureOpener()`/`close()` names match across `command-palette.ts`, its spec, and `workspace.ts`.
- **Test discipline.** Every task is failing-test-first: library tests via `pnpm vitest run <path>`, app tests via `pnpm -F web exec ng test --watch=false`, e2e via `pnpm -F web e2e` (excluded from `pnpm test`), benches via `node --expose-gc --import tsx`. No bare `vitest`/watch. Prettier `{singleQuote:true,printWidth:100}`; library code uses `.js` ESM extensions; Angular uses bare specifiers + signals + zoneless. Commits end with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Self-review fixes applied inline.** (1) T2's query-metering note clarifies that `capabilityFor`/`parseQuery` throws before the `try`, so the chosen failing query (`MATCH (n) RETURN`) reaches `executeQuery` and is metered by the `finally` — the test asserts both counters increment. (2) T2 removes the now-unused `AtlasError` import from `data.ts`. (3) T3's `deleteSessionsForUser` collects ids first, then deletes in one transaction (no mutate-while-iterating). (4) T5 keeps a `schema ? … : results[0]` fallback so a future algorithm added without an `ALGO_COLUMNS` entry degrades to the old behavior rather than crashing. (5) T6's `close()` still emits `closed` so the existing Escape spec stays green, and `captureOpener()` is called by the workspace before focus so restoration targets the real opener. (6) T8 leaves the root `package.json` version-less (it has no `version` field and is private). (7) T1/T8 keep the static path consistent (`apps/web/dist/web/browser`) across compose, `playwright.config.ts`, and the README.
