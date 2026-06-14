# Atlas M6d — Knowledge Graph Explorer: Import UI, ⌘K Node Search, Admin, and Deferred Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Knowledge Graph Explorer feature-complete. Fold in the four approved M6a/M6b deferred-polish items (route login/register through `AuthService` so the user signal sets immediately; an app-start session-rehydration hook that calls `whoami` before first render; the theme-switcher label/aria redundancy; the live-update handler already consumes the real `WsFrame` and is verified, not changed). Extend `@atlas/client` with the admin/import surface it still lacks (`createToken`/`listTokens`/`revokeToken`, `grantRole`/`revokeRole`, `import`/`importCsv`), unit-tested against a real ephemeral `buildServer` listener. Ship an **Import** page (paste/upload JSON `{nodes,edges}` and CSV `nodesCsv`/`edgesCsv`, atomic toggle, committed/idMap/first-error result), a **⌘K command palette** that searches nodes in the current database via AQL and brings the chosen node onto the canvas + selects + centers it through the real `GraphStore`, and **Admin** views for the current user's API tokens (create-once/list/revoke) and per-database role grants (grant/revoke viewer/editor/owner by username, owners surfaced from `GET /api/db/:name`). Wire the new routes into the shell/workspace nav (guarded), add one Playwright e2e covering ⌘K search and the import flow (excluded from the default gate), flip the README to "M6 complete / Explorer feature-complete", and land the full gate green. Global user management, audit-log UI, and inline AQL error squiggles are explicitly deferred to **M7** (no server endpoints exist for the first two).

**Architecture:** `@atlas/client` stays the single API surface (spec §7.1). It gains, in **cookie mode** (and bearer for parity): `createToken(name)` → `POST /api/tokens` (201 → `{ tokenId, name, token }`, full token shown once), `listTokens()` → `GET /api/tokens` (→ `{ tokenId, name }[]`), `revokeToken(tokenId)` → `DELETE /api/tokens/:id` (204), `grantRole(db, username, role)` → `POST /api/db/:name/roles` (204), `revokeRole(db, username)` → `DELETE /api/db/:name/roles/:user` (204), `import(db, body)` → `POST /api/db/:name/import` (JSON `ImportReq`), and `importCsv(db, body)` → `POST /api/db/:name/import?format=csv` (`{ nodesCsv?, edgesCsv?, atomic? }`); both return `ImportResult`. `getDatabase(name)` already exists (→ `DbInfo { name, role, owners }`). The Angular app: `AtlasApi` re-exposes the new methods; `AuthService` already holds the user signal and gains nothing new (login/register components are rewired to call it); a new `provideAppInitializer` calls `AuthService.refresh()` at bootstrap so a hard refresh rehydrates the user before first render. New feature areas: `import/` (a pure `import-request` builder + an `Import` page reachable from the picker and the workspace), `search/` (a pure `node-search` query/result mapper + a `CommandPalette` overlay mounted in the workspace, ⌘/Ctrl+K toggled, focus-trapped, that selects+centers via the workspace's `GraphStore` + `GraphCanvas.fit()`), and `admin/` (a guarded `Admin` shell-child with a `TokensPanel` and a `RolesPanel` backed by signal stores). All app tests run via the `@angular/build:unit-test` Vitest runner; library tests via `pnpm vitest run`; Playwright via `pnpm -F web e2e` (separate from the default gate).

**Tech Stack:** Existing stack (Node ≥22, pnpm 9.15.4, TypeScript, Vitest 4, ESLint, Prettier) + Angular 20.3 (standalone, signals, zoneless, Router), the `@angular/build:unit-test` Vitest runner (jsdom), Playwright for e2e. No new runtime dependencies: the command palette and admin views use native HTML controls + signals (no Angular CDK). The client extension uses global `fetch` (cookie mode replays the per-connection cookie jar already in `@atlas/client`). Import/search/admin are pure-logic-first: request builders, CSV/JSON validation, and AQL search-query construction are unit-tested in isolation; components get smoke specs.

**Spec:** `docs/superpowers/specs/2026-06-10-atlas-graph-platform-design.md` — §7.2 (screens: **Admin** = users, tokens, roles, audit log, database settings — M6d ships *tokens* + *roles* + *db owners*, defers users/audit; **Database picker** + **Workspace** import files; **Workspace** top bar includes **⌘K node search**), §6.4 (Import format: JSON `{ nodes:[{tempId,labels,properties}], edges:[{from,to,type,properties}] }`, CSV `nodes.csv`/`edges.csv` with typed headers, `atomic=true` all-or-nothing, response returns committed + `tempId→id` map + first error with row numbers), §6.2 permission matrix (only owners grant/revoke roles; editor/owner import; viewer read-only), §7.5 (keyboard nav for all non-canvas UI, visible focus, ARIA labeling — the ⌘K overlay is focus-trapped with `role="dialog"`/`aria-modal` and an ARIA-labelled listbox).

**Existing code anchors (verified):**
- `@atlas/client` (`packages/client/src/index.ts`): `connect(url, { token?, mode? }) → AtlasClient`; cookie mode replays a per-connection `CookieJar` and sets `credentials: 'include'`. `AtlasClient` has `register`/`login`/`logout`/`whoami`/`listDatabases`/`createDatabase`/`getDatabase`/`seed`/`database`. `Database` has `query`/`schema`/`subscribe`. `AtlasClientError { code, status, message, problem? }`; `readError(res)` maps a non-OK `Response` to it; `whoami` maps 401→null. Types: `DbSummary { name, description, role }`, `SeedResult`, `Subscription`. **No token/role/import methods yet — M6d adds them.**
- `@atlas/protocol` (`packages/protocol/src/wire.ts`): `UserInfo { username, isAdmin }`; `DbInfo { name, description?, role: RoleName|null, owners: string[] }`; `RoleName = 'owner'|'editor'|'viewer'` (`Role` zod enum); `GrantRoleReq { username, role }`; `CreateTokenReq { name }`; `ImportReq { nodes: ImportNodeSpec[], edges: ImportEdgeSpec[], atomic }` with `ImportNodeSpec { tempId, labels, properties }` and `ImportEdgeSpec { from, to, type, properties }`; `ImportResult { committed:{nodes,edges}, idMap: Record<string,number>, error?: { message, at:{ kind:'node'|'edge', index } } }`; `usernameSchema`, `dbNameSchema`, `propsSchema`.
- `@atlas/server` routes (verified, all under `/api`, `requireAuth` preHandler):
  - Tokens (`routes/tokens.ts`): `POST /api/tokens` body `{ name }` → 201 `{ tokenId, name, token }` (full token = `tokenId.secret`, shown once); `GET /api/tokens` → `{ tokenId, name }[]` (caller's own); `DELETE /api/tokens/:id` → 204 (404 if not owned/missing; ownership enforced — IDOR-safe).
  - Roles (`routes/databases.ts`): `POST /api/db/:name/roles` body `{ username, role }`, requires `admin-db` (owner) → 204 (404 if user unknown); `DELETE /api/db/:name/roles/:user`, requires `admin-db` → 204. `GET /api/db/:name` requires `read` → `DbInfo { name, role, owners }`. `PATCH`/`DELETE /api/db/:name` exist (db settings/delete) but are out of M6d scope.
  - Import/export/seed (`routes/io.ts`): `POST /api/db/:name/import` requires `write`; default body = `ImportReq` (JSON); `?format=csv` body `{ nodesCsv?, edgesCsv?, atomic? }` → both return `ImportResult`. `GET /api/db/:name/export` → `{ nodes, edges }`. `POST /api/db/:name/seed/:dataset` (`science-history` only).
  - **No `GET /api/users` (global user list) and no audit-log endpoint exist** — confirmed by enumerating `routes/*.ts` (`auth`, `data`, `databases`, `io`, `metrics`, `query`, `tokens`, `ws`). Global user management + audit UI are therefore deferred to M7 (see self-review).
- Merged Explorer surfaces (`apps/web`): `core/atlas-api.ts` (re-exposes client methods — M6d adds the new ones), `core/auth.service.ts` (`login`/`register`/`logout`/`refresh`; `user` + `isAuthenticated` signals), `core/auth.guard.ts` (`authGuard` runs `refresh()` if not authenticated), `app.config.ts` (zoneless + router + a `WORKSPACE_GRAPH_STORE` default), `app.routes.ts` (`/login`, `/register`, `/databases` shell+picker child, `/db/:name`, `/db/:name/schema`, `/db/:name/algorithms`). `auth/login.ts` + `auth/register.ts` call `AtlasApi` **directly** (the M6a deferral). `shell/shell.html` top bar (brand + theme-switcher + user menu); `shell/theme-switcher.html` has both an `.sr-only <label for>` and `aria-label="Theme"` (the redundancy to fix). Workspace: `workspace/workspace.ts` provides a per-db `GraphStore` + `GraphStoreWorkspaceAdapter`; `workspace.html` top bar has the dock tabs; `workspace/graph.store.ts` `GraphStore` has `select(selection)`, `addGraph(data)`, `connectionsOf(id)`, `selectedNode`, `visibleNodes()`; `workspace/graph-canvas.ts` `GraphCanvas` has `fit()` (re-frames the camera to visible nodes) and `resyncLayout()`; `workspace/expand.ts` `parseGraphRows(QueryResponse) → GraphData`, `neighborQuery(id)`; `workspace/graph-model.ts` `GraphNode { id, labels, props, x?, y? }`, `GraphData`.
- Deferred-polish notes (`~/.claude/.../memory/m6d-polish-followups.md`): (1) login/register bypass `AuthService`; (2) no session rehydration on hard refresh; (3) theme-switcher label/aria redundancy; (4) **resolved** — the live-update handler already consumes the real `@atlas/protocol` `WsFrame` (verified in `workspace.ts` `onFrame`), so M6d only adds a regression note, no change.

## File structure

```
packages/client/
  src/index.ts                       MODIFY: add token/role/import methods + types
  test/client-admin-io.test.ts       CREATE: token/role/import against a real listener

apps/web/
  src/app/app.config.ts              MODIFY: add provideAppInitializer → AuthService.refresh()
  src/app/app.config.spec.ts         CREATE: initializer calls refresh() at bootstrap
  src/app/app.routes.ts              MODIFY: add /databases/import, /databases/admin (guarded)
  src/app/auth/login.ts              MODIFY: route through AuthService.login()
  src/app/auth/register.ts           MODIFY: route through AuthService.register()+login()
  src/app/auth/login.spec.ts         MODIFY: assert AuthService.user() is set after submit
  src/app/auth/register.spec.ts      CREATE: assert AuthService.user() set after register
  src/app/shell/theme-switcher.html  MODIFY: drop the redundant aria-label
  src/app/shell/shell.html           MODIFY: add Databases/Import/Admin nav links
  src/app/core/atlas-api.ts          MODIFY: re-expose token/role/import methods
  src/app/core/atlas-api.spec.ts     MODIFY: assert the new methods exist

  src/app/import/import-request.ts        CREATE: pure JSON/CSV request builder + validation
  src/app/import/import-request.spec.ts   CREATE
  src/app/import/import.store.ts          CREATE: signal store (run import, hold result/error)
  src/app/import/import.store.spec.ts     CREATE
  src/app/import/import.ts / .html        CREATE: Import page (paste/upload, atomic, result)
  src/app/import/import.spec.ts           CREATE: component smoke

  src/app/search/node-search.ts           CREATE: pure AQL search-query builder + row→hit mapper
  src/app/search/node-search.spec.ts      CREATE
  src/app/search/command-palette.ts/.html CREATE: ⌘K overlay (search → select+center on canvas)
  src/app/search/command-palette.spec.ts  CREATE: keyboard + select smoke

  src/app/admin/admin.ts / admin.html     CREATE: guarded Admin shell-child (tabs)
  src/app/admin/admin.spec.ts             CREATE: component smoke
  src/app/admin/tokens.store.ts           CREATE: token signal store
  src/app/admin/tokens.store.spec.ts      CREATE
  src/app/admin/tokens-panel.ts/.html     CREATE: create-once / list / revoke tokens
  src/app/admin/tokens-panel.spec.ts      CREATE
  src/app/admin/roles.store.ts            CREATE: per-db role signal store
  src/app/admin/roles.store.spec.ts       CREATE
  src/app/admin/roles-panel.ts/.html      CREATE: grant/revoke roles for owned dbs
  src/app/admin/roles-panel.spec.ts       CREATE

  src/app/workspace/workspace.ts          MODIFY: mount CommandPalette, ⌘K host key handler
  src/app/workspace/workspace.html        MODIFY: <app-command-palette> + ⌘K button
  src/app/workspace/workspace.spec.ts     MODIFY: ⌘K opens palette; select centers a node
  src/app/picker/picker.html              MODIFY: per-db "Import" link (owner/editor)

  src/styles.css                          MODIFY: overlay/dialog, admin, import layout tokens
  e2e/explorer-m6d.spec.ts                CREATE: Playwright — ⌘K search + import flow

README.md                                 MODIFY (Task 7): status → M6 complete
```

Conventions: ESM `.js` import extensions in `@atlas/client` library code (Task 1). Angular code uses bare specifiers (no `.js`). App tests: `pnpm -F web exec ng test --watch=false`. Library tests: `pnpm vitest run <path>` (NEVER bare `vitest`/watch). Playwright: `pnpm -F web e2e` (root alias `pnpm e2e:web`), excluded from `pnpm test`. Prettier config is `{ singleQuote: true, printWidth: 100 }`. Commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Extend `@atlas/client` with token, role, and import methods

The Admin and Import UIs need a client surface that does not exist yet. Add the six methods to `AtlasClient`, in both modes, returning the verified server shapes, tested against a real ephemeral `buildServer` listener (mirroring `test/client-session.test.ts`). Backward compatible: all existing client tests keep passing.

**Files:**
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/client-admin-io.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/client/test/client-admin-io.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, loadConfig } from '@atlas/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

let dir: string;
let app: FastifyInstance;
let url: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-admin-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client tokens', () => {
  it('creates a token (shown once), lists it, and revokes it', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');

    expect(await client.listTokens()).toEqual([]);
    const created = await client.createToken('ci');
    expect(created.name).toBe('ci');
    expect(created.tokenId.length).toBeGreaterThan(0);
    // The full secret is `tokenId.secret`, returned only on creation.
    expect(created.token.startsWith(`${created.tokenId}.`)).toBe(true);

    expect(await client.listTokens()).toEqual([{ tokenId: created.tokenId, name: 'ci' }]);
    await client.revokeToken(created.tokenId);
    expect(await client.listTokens()).toEqual([]);
  });

  it('revoking an unknown token surfaces a 404', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await expect(client.revokeToken('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('the freshly minted token authenticates a bearer client', async () => {
    const cookie = connect(url, { mode: 'cookie' });
    await cookie.register('ada', 'secret12');
    await cookie.login('ada', 'secret12');
    const { token } = await cookie.createToken('cli');
    const bearer = connect(url, { token });
    expect(await bearer.whoami()).toEqual({ username: 'ada', isAdmin: false });
  });
});

describe('@atlas/client roles', () => {
  it('an owner grants then revokes a role on a database they own', async () => {
    const owner = connect(url, { mode: 'cookie' });
    await owner.register('ada', 'secret12');
    await owner.login('ada', 'secret12');
    await owner.createDatabase('kb');

    const member = connect(url, { mode: 'cookie' });
    await member.register('bob', 'secret12');

    await owner.grantRole('kb', 'bob', 'editor');
    let info = await owner.getDatabase('kb');
    expect(info.owners).toContain('ada');

    // Bob can now log in and see kb with the editor role.
    await member.login('bob', 'secret12');
    expect(await member.listDatabases()).toContainEqual({
      name: 'kb',
      description: '',
      role: 'editor',
    });

    await owner.revokeRole('kb', 'bob');
    await member.login('bob', 'secret12');
    expect(await member.listDatabases()).toEqual([]);
    info = await owner.getDatabase('kb');
    expect(info.owners).toContain('ada');
  });

  it('granting a role to an unknown user surfaces a 404', async () => {
    const owner = connect(url, { mode: 'cookie' });
    await owner.register('ada', 'secret12');
    await owner.login('ada', 'secret12');
    await owner.createDatabase('kb');
    await expect(owner.grantRole('kb', 'ghost', 'viewer')).rejects.toMatchObject({ status: 404 });
  });
});

describe('@atlas/client import', () => {
  it('imports JSON nodes+edges and returns committed counts + an idMap', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');

    const res = await client.import('kb', {
      nodes: [
        { tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } },
        { tempId: 'b', labels: ['Person'], properties: { name: 'Bob' } },
      ],
      edges: [{ from: 'a', to: 'b', type: 'KNOWS', properties: {} }],
      atomic: true,
    });
    expect(res.committed).toEqual({ nodes: 2, edges: 1 });
    expect(Object.keys(res.idMap)).toEqual(['a', 'b']);
    expect(res.error).toBeUndefined();
  });

  it('imports CSV via ?format=csv', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');

    const res = await client.importCsv('kb', {
      nodesCsv: 'tempId,:label,name:string\n1,Person,Ada\n2,Person,Bob\n',
      edgesCsv: ':from,:to,:type\n1,2,KNOWS\n',
      atomic: false,
    });
    expect(res.committed.nodes).toBe(2);
    expect(res.committed.edges).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm install && pnpm vitest run packages/client/test/client-admin-io.test.ts`
Expected: FAIL — `createToken`/`listTokens`/`revokeToken`/`grantRole`/`revokeRole`/`import`/`importCsv` do not exist on `AtlasClient`.

- [ ] **Step 3: Add the methods + types to `packages/client/src/index.ts`**

Add these type imports to the existing protocol type import block at the top:

```ts
import type {
  DbInfo,
  ImportReq,
  ImportResult,
  ProblemDetails,
  QueryResponse,
  RoleName,
  SubscribeFilter,
  UserInfo,
  WsFrame,
} from '@atlas/protocol';
```

Add these exported interfaces near the existing `DbSummary`/`SeedResult` declarations:

```ts
/** A user's API token as returned by `GET /api/tokens` (the secret is never listed). */
export interface TokenSummary {
  tokenId: string;
  name: string;
}

/** The one-time result of `POST /api/tokens`: the full `token` is shown exactly once. */
export interface CreatedToken {
  tokenId: string;
  name: string;
  /** Full secret (`tokenId.secret`) — surface to the user once, never stored. */
  token: string;
}

/** CSV import body for `POST /api/db/:name/import?format=csv`. */
export interface ImportCsvBody {
  nodesCsv?: string;
  edgesCsv?: string;
  atomic?: boolean;
}
```

Add these methods to the `AtlasClient` class (after the existing `seed(...)` method, before the closing brace). They use the same `request(this.opts, this.jar, …)` + `buildHeaders` + `readError` helpers as the existing methods so cookie mode replays the jar and bearer mode sends the header:

```ts
  // ---- tokens ----
  async createToken(name: string): Promise<CreatedToken> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as CreatedToken;
  }

  async listTokens(): Promise<TokenSummary[]> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/tokens`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as TokenSummary[];
  }

  async revokeToken(tokenId: string): Promise<void> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/tokens/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE', headers: buildHeaders(this.opts, false, this.jar) },
    );
    if (!res.ok) throw await readError(res);
  }

  // ---- roles (db owner only, enforced server-side) ----
  async grantRole(name: string, username: string, role: RoleName): Promise<void> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${name}/roles`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ username, role }),
    });
    if (!res.ok) throw await readError(res);
  }

  async revokeRole(name: string, username: string): Promise<void> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/db/${name}/roles/${encodeURIComponent(username)}`,
      { method: 'DELETE', headers: buildHeaders(this.opts, false, this.jar) },
    );
    if (!res.ok) throw await readError(res);
  }

  // ---- import ----
  async import(name: string, body: ImportReq): Promise<ImportResult> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${name}/import`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as ImportResult;
  }

  async importCsv(name: string, body: ImportCsvBody): Promise<ImportResult> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/db/${name}/import?format=csv`,
      {
        method: 'POST',
        headers: buildHeaders(this.opts, true, this.jar),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as ImportResult;
  }
```

`RoleName`, `ImportReq`, and `ImportResult` are already exported by `@atlas/protocol` (verified in `wire.ts`); no protocol changes are needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/client/test/client-admin-io.test.ts packages/client/test/client-session.test.ts packages/client/test/client.test.ts && pnpm build`
Expected: PASS — the new admin/io suite, the existing cookie-mode suite, and the existing bearer suite, plus a clean build.

- [ ] **Step 5: Run the full library gate**

Run: `pnpm typecheck:test && pnpm lint && pnpm format`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): token, role, and import methods for the admin/import UI"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 2: Deferred M6a polish — AuthService routing, app-start session rehydration, theme a11y

Fold in the four recorded follow-ups. Route login/register through `AuthService` so the `user` signal is set immediately on success; add a `provideAppInitializer` that calls `AuthService.refresh()` at bootstrap so a hard refresh of a deep authenticated route populates the user before first render; drop the theme-switcher's redundant `aria-label`. The live-update handler already consumes the real `WsFrame` (verified) — no change, only a regression assertion stays green.

**Files:**
- Modify: `apps/web/src/app/auth/login.ts`, `apps/web/src/app/auth/register.ts`, `apps/web/src/app/app.config.ts`, `apps/web/src/app/shell/theme-switcher.html`
- Modify: `apps/web/src/app/auth/login.spec.ts`
- Create: `apps/web/src/app/auth/register.spec.ts`, `apps/web/src/app/app.config.spec.ts`

- [ ] **Step 1: Write/adjust the failing tests**

Replace `apps/web/src/app/auth/login.spec.ts` so it injects a real `AuthService` (backed by a stub `AtlasApi`) and asserts the user signal is set after submit:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuthService } from '../core/auth.service';
import { Login } from './login';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Login component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('logs in through AuthService (sets the user signal) and navigates to the picker', async () => {
    const login = vi.fn().mockResolvedValue(ada);
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Login);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('secret12');
    await cmp.submit();

    expect(login).toHaveBeenCalledWith('ada', 'secret12');
    expect(auth.user()).toEqual(ada); // signal set immediately, not only via the guard
    expect(navSpy).toHaveBeenCalledWith('/databases');
  });

  it('shows an error message when login fails', async () => {
    const login = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Login);
    const cmp = fixture.componentInstance;
    cmp.username.set('x');
    cmp.password.set('y');
    await cmp.submit();
    await fixture.whenStable();
    expect(cmp.error()).toContain('Invalid');
  });
});
```

`apps/web/src/app/auth/register.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuthService } from '../core/auth.service';
import { Register } from './register';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Register component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('registers then logs in through AuthService and sets the user signal', async () => {
    const register = vi.fn().mockResolvedValue(ada);
    const login = vi.fn().mockResolvedValue(ada);
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { register, login, whoami: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Register);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('secret12');
    await cmp.submit();

    expect(register).toHaveBeenCalledWith('ada', 'secret12');
    expect(login).toHaveBeenCalledWith('ada', 'secret12');
    expect(auth.user()).toEqual(ada);
    expect(navSpy).toHaveBeenCalledWith('/databases');
  });

  it('rejects a short password before calling the API', async () => {
    const register = vi.fn();
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { register, whoami: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Register);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('short');
    await cmp.submit();
    expect(register).not.toHaveBeenCalled();
    expect(cmp.error()).toContain('at least 8');
  });
});
```

`apps/web/src/app/app.config.spec.ts` — the bootstrap initializer rehydrates the session:

```ts
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './core/atlas-api';
import { AuthService } from './core/auth.service';
import { provideSessionRehydration } from './app.config';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('session rehydration initializer', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('calls AuthService.refresh() during app initialization and populates the user', async () => {
    const whoami = vi.fn().mockResolvedValue(ada);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { whoami } },
        provideSessionRehydration(),
      ],
    });
    // Forces the APP_INITIALIZER promises to resolve.
    await TestBed.inject(ApplicationInitStatus).donePromise;
    expect(whoami).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(AuthService).user()).toEqual(ada);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `Login`/`Register` still call `AtlasApi` directly so `auth.user()` is null; `provideSessionRehydration` is not exported.

- [ ] **Step 3: Implement the polish**

`apps/web/src/app/auth/login.ts` — inject `AuthService`, not `AtlasApi`:

```ts
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(
        status === 401 ? 'Invalid username or password.' : 'Login failed. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
```

`apps/web/src/app/auth/register.ts` — inject `AuthService`; `register` then `login` both run through it (so the user signal is set):

```ts
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.html',
})
export class Register {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    if (this.password().length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    this.busy.set(true);
    try {
      await this.auth.register(this.username(), this.password());
      await this.auth.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(
        status === 409 ? 'That username is taken.' : 'Registration failed. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
```

`apps/web/src/app/app.config.ts` — export a `provideSessionRehydration()` and add it to the providers. `provideAppInitializer` runs in the injection context, so `inject()` works; it returns the promise so Angular waits for `refresh()` before first render:

```ts
import {
  ApplicationConfig,
  EnvironmentProviders,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import {
  InMemoryWorkspaceGraphStore,
  WORKSPACE_GRAPH_STORE,
} from './workspace/workspace-graph-store.contract';

/**
 * Rehydrate the session before first render: on a hard refresh of a deep
 * authenticated route, `AuthService.refresh()` calls `whoami` so `user()` is set
 * before the shell paints (rather than only when `authGuard` later runs). A failed
 * `whoami` (401 → null) is swallowed so an anonymous load still boots to /login.
 */
export function provideSessionRehydration(): EnvironmentProviders {
  return provideAppInitializer(() => inject(AuthService).refresh().catch(() => null));
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideSessionRehydration(),
    // App-wide default so the console runs in any context; the workspace scope
    // overrides this with the canvas-backed GraphStoreWorkspaceAdapter.
    { provide: WORKSPACE_GRAPH_STORE, useClass: InMemoryWorkspaceGraphStore },
  ],
};
```

`apps/web/src/app/shell/theme-switcher.html` — drop the redundant `aria-label` (the visible-to-screen-reader `<label for>` is the accessible name):

```html
<label class="sr-only" for="theme-select">Theme</label>
<select id="theme-select" [ngModel]="theme.current()" (ngModelChange)="change($event)">
  @for (t of theme.themes; track t.id) {
    <option [value]="t.id">{{ t.label }}</option>
  }
</select>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — login/register set `auth.user()`, the initializer calls `refresh()`, all prior specs still green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(web): route auth through AuthService, rehydrate session on boot, theme a11y"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 3: `AtlasApi` — re-expose the token/role/import methods

`AtlasApi` is the app's only door to the server; extend it with thin delegates to the Task 1 client methods so the import and admin features never touch `@atlas/client` directly.

**Files:**
- Modify: `apps/web/src/app/core/atlas-api.ts`, `apps/web/src/app/core/atlas-api.spec.ts`

- [ ] **Step 1: Extend the failing spec**

Add to `apps/web/src/app/core/atlas-api.spec.ts` (keep the existing two tests):

```ts
  it('exposes the admin + import methods', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    expect(typeof api.createToken).toBe('function');
    expect(typeof api.listTokens).toBe('function');
    expect(typeof api.revokeToken).toBe('function');
    expect(typeof api.grantRole).toBe('function');
    expect(typeof api.revokeRole).toBe('function');
    expect(typeof api.getDatabase).toBe('function');
    expect(typeof api.import).toBe('function');
    expect(typeof api.importCsv).toBe('function');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — the new methods do not exist on `AtlasApi`.

- [ ] **Step 3: Implement — extend `apps/web/src/app/core/atlas-api.ts`**

Widen the `@atlas/client` import and add the delegates (keep the existing methods):

```ts
import { Injectable } from '@angular/core';
import {
  connect,
  type AtlasClient,
  type CreatedToken,
  type Database,
  type DbSummary,
  type ImportCsvBody,
  type SeedResult,
  type TokenSummary,
} from '@atlas/client';
import type { DbInfo, ImportReq, ImportResult, RoleName, UserInfo } from '@atlas/protocol';
import { environment } from '../../environments/environment';
```

Add inside the class (after `seed(...)`):

```ts
  getDatabase(name: string): Promise<DbInfo> {
    return this.client.getDatabase(name);
  }
  createToken(name: string): Promise<CreatedToken> {
    return this.client.createToken(name);
  }
  listTokens(): Promise<TokenSummary[]> {
    return this.client.listTokens();
  }
  revokeToken(tokenId: string): Promise<void> {
    return this.client.revokeToken(tokenId);
  }
  grantRole(name: string, username: string, role: RoleName): Promise<void> {
    return this.client.grantRole(name, username, role);
  }
  revokeRole(name: string, username: string): Promise<void> {
    return this.client.revokeRole(name, username);
  }
  import(name: string, body: ImportReq): Promise<ImportResult> {
    return this.client.import(name, body);
  }
  importCsv(name: string, body: ImportCsvBody): Promise<ImportResult> {
    return this.client.importCsv(name, body);
  }
```

(`private readonly client: AtlasClient = connect(...)` and the existing delegates are unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): re-expose token/role/import client methods on AtlasApi"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 4: Import — pure request builder, signal store, and page

A page (reachable from the picker and the workspace) to import data into a database. The request building + validation is a pure function (unit-tested exhaustively); the store runs the import and holds the `ImportResult`; the page wires paste/upload + an atomic toggle and renders committed counts, `idMap` size, and the first error (with its node/edge row index, per §6.4).

**Files:**
- Create: `apps/web/src/app/import/import-request.ts`, `apps/web/src/app/import/import.store.ts`, `apps/web/src/app/import/import.ts`, `apps/web/src/app/import/import.html`
- Test: `apps/web/src/app/import/import-request.spec.ts`, `apps/web/src/app/import/import.store.spec.ts`, `apps/web/src/app/import/import.spec.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/import/import-request.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseJsonImport, type JsonParse } from './import-request';

describe('parseJsonImport', () => {
  it('accepts a well-formed { nodes, edges } payload and carries the atomic flag', () => {
    const out = parseJsonImport(
      JSON.stringify({
        nodes: [{ tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } }],
        edges: [{ from: 'a', to: 'a', type: 'SELF', properties: {} }],
      }),
      true,
    );
    expect(out.ok).toBe(true);
    const req = (out as Extract<JsonParse, { ok: true }>).value;
    expect(req.atomic).toBe(true);
    expect(req.nodes).toHaveLength(1);
    expect(req.edges).toHaveLength(1);
  });

  it('defaults missing nodes/edges to empty arrays and properties to {}', () => {
    const out = parseJsonImport(JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }] }), false);
    expect(out.ok).toBe(true);
    const req = (out as Extract<JsonParse, { ok: true }>).value;
    expect(req.edges).toEqual([]);
    expect(req.nodes[0].properties).toEqual({});
  });

  it('reports a friendly error for invalid JSON', () => {
    const out = parseJsonImport('{not json', false);
    expect(out.ok).toBe(false);
    expect((out as Extract<JsonParse, { ok: false }>).error).toContain('JSON');
  });

  it('rejects a node missing a tempId', () => {
    const out = parseJsonImport(JSON.stringify({ nodes: [{ labels: ['X'] }] }), false);
    expect(out.ok).toBe(false);
    expect((out as Extract<JsonParse, { ok: false }>).error).toMatch(/tempId/i);
  });

  it('rejects an edge missing from/to/type', () => {
    const out = parseJsonImport(JSON.stringify({ edges: [{ from: 'a' }] }), false);
    expect(out.ok).toBe(false);
  });

  it('rejects a top-level array (must be an object)', () => {
    const out = parseJsonImport('[]', false);
    expect(out.ok).toBe(false);
  });
});
```

`apps/web/src/app/import/import.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { ImportStore } from './import.store';
import type { ImportResult } from '@atlas/protocol';

const result: ImportResult = { committed: { nodes: 2, edges: 1 }, idMap: { a: 0, b: 1 } };

function withApi(api: Partial<AtlasApi>): ImportStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(ImportStore);
}

describe('ImportStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('runJson() parses, calls import, and holds the result', async () => {
    const importFn = vi.fn().mockResolvedValue(result);
    const store = withApi({ import: importFn });
    await store.runJson(
      'kb',
      JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }, { tempId: 'b', labels: ['X'] }] }),
      false,
    );
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(store.result()).toEqual(result);
    expect(store.error()).toBe('');
  });

  it('runJson() surfaces a parse error and does not call the API', async () => {
    const importFn = vi.fn();
    const store = withApi({ import: importFn });
    await store.runJson('kb', '{bad', false);
    expect(importFn).not.toHaveBeenCalled();
    expect(store.error()).toContain('JSON');
    expect(store.result()).toBeNull();
  });

  it('runCsv() forwards the CSV body + atomic flag', async () => {
    const importCsv = vi.fn().mockResolvedValue(result);
    const store = withApi({ importCsv });
    await store.runCsv('kb', 'tempId,:label\n1,X\n', '', true);
    expect(importCsv).toHaveBeenCalledWith('kb', {
      nodesCsv: 'tempId,:label\n1,X\n',
      edgesCsv: undefined,
      atomic: true,
    });
    expect(store.result()).toEqual(result);
  });

  it('runJson() maps a 403 to a friendly permission error', async () => {
    const importFn = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const store = withApi({ import: importFn });
    await store.runJson('kb', JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }] }), false);
    expect(store.error()).toContain('permission');
  });
});
```

`apps/web/src/app/import/import.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Import } from './import';
import type { ImportResult } from '@atlas/protocol';

const result: ImportResult = { committed: { nodes: 2, edges: 1 }, idMap: { a: 0, b: 1 } };

describe('Import page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('imports pasted JSON and renders the committed counts + idMap size', async () => {
    const importFn = vi.fn().mockResolvedValue(result);
    await TestBed.configureTestingModule({
      imports: [Import],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { import: importFn } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => 'kb' } } } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Import);
    const cmp = fixture.componentInstance;
    cmp.jsonText.set(
      JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }, { tempId: 'b', labels: ['X'] }] }),
    );
    await cmp.submit();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(importFn).toHaveBeenCalled();
    expect(text).toContain('2'); // committed nodes
    expect(text).toContain('idMap');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./import-request`, `./import.store`, `./import` not found.

- [ ] **Step 3: Implement the builder, store, and page**

`apps/web/src/app/import/import-request.ts`:

```ts
import type { ImportReq } from '@atlas/protocol';

/** A discriminated parse result so callers branch on `ok` without throwing. */
export type JsonParse = { ok: true; value: ImportReq } | { ok: false; error: string };

interface RawNode {
  tempId?: unknown;
  labels?: unknown;
  properties?: unknown;
}
interface RawEdge {
  from?: unknown;
  to?: unknown;
  type?: unknown;
  properties?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function asProps(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Validate a pasted/loaded JSON string into an `ImportReq` (spec §6.4: object with
 * `nodes:[{tempId,labels,properties}]` and `edges:[{from,to,type,properties}]`).
 * Missing arrays default to empty; missing `properties` default to `{}`; the
 * `atomic` flag is supplied by the caller (the UI toggle), not read from the JSON.
 */
export function parseJsonImport(text: string, atomic: boolean): JsonParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Invalid JSON — could not parse the payload.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: 'Import payload must be an object with "nodes" and "edges".' };

  const body = raw as { nodes?: unknown; edges?: unknown };
  const rawNodes = body.nodes ?? [];
  const rawEdges = body.edges ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges))
    return { ok: false, error: '"nodes" and "edges" must be arrays.' };

  const nodes: ImportReq['nodes'] = [];
  for (const [i, n] of (rawNodes as RawNode[]).entries()) {
    if (typeof n?.tempId !== 'string' || n.tempId.length === 0)
      return { ok: false, error: `Node ${i} is missing a string "tempId".` };
    if (!isStringArray(n.labels) || n.labels.length === 0)
      return { ok: false, error: `Node ${i} ("${n.tempId}") needs a non-empty "labels" array.` };
    nodes.push({ tempId: n.tempId, labels: n.labels, properties: asProps(n.properties) });
  }

  const edges: ImportReq['edges'] = [];
  for (const [i, e] of (rawEdges as RawEdge[]).entries()) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string' || typeof e?.type !== 'string')
      return { ok: false, error: `Edge ${i} needs string "from", "to", and "type".` };
    edges.push({ from: e.from, to: e.to, type: e.type, properties: asProps(e.properties) });
  }

  return { ok: true, value: { nodes, edges, atomic } };
}
```

`apps/web/src/app/import/import.store.ts`:

```ts
import { inject, Injectable, signal } from '@angular/core';
import type { ImportResult } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';
import { parseJsonImport } from './import-request';

@Injectable()
export class ImportStore {
  private readonly api = inject(AtlasApi);
  private readonly _result = signal<ImportResult | null>(null);
  private readonly _error = signal('');
  private readonly _busy = signal(false);

  readonly result = this._result.asReadonly();
  readonly error = this._error.asReadonly();
  readonly busy = this._busy.asReadonly();

  async runJson(name: string, text: string, atomic: boolean): Promise<void> {
    const parsed = parseJsonImport(text, atomic);
    if (!parsed.ok) {
      this._error.set(parsed.error);
      this._result.set(null);
      return;
    }
    await this.run(() => this.api.import(name, parsed.value));
  }

  async runCsv(name: string, nodesCsv: string, edgesCsv: string, atomic: boolean): Promise<void> {
    await this.run(() =>
      this.api.importCsv(name, {
        nodesCsv: nodesCsv.trim() ? nodesCsv : undefined,
        edgesCsv: edgesCsv.trim() ? edgesCsv : undefined,
        atomic,
      }),
    );
  }

  private async run(call: () => Promise<ImportResult>): Promise<void> {
    this._error.set('');
    this._busy.set(true);
    try {
      this._result.set(await call());
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 403
          ? 'You do not have permission to import into this database.'
          : status === 400
            ? 'The import was rejected — check the payload format.'
            : 'Import failed. Please try again.',
      );
      this._result.set(null);
    } finally {
      this._busy.set(false);
    }
  }
}
```

`apps/web/src/app/import/import.ts`:

```ts
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ImportStore } from './import.store';

type Mode = 'json' | 'csv';

@Component({
  selector: 'app-import',
  imports: [FormsModule, RouterLink],
  templateUrl: './import.html',
  providers: [ImportStore],
})
export class Import {
  readonly store = inject(ImportStore);
  /** Target db comes from `?db=` (picker/workspace link); blank disables submit. */
  readonly name = inject(ActivatedRoute).snapshot.queryParamMap.get('db') ?? '';

  readonly mode = signal<Mode>('json');
  readonly atomic = signal(false);
  readonly jsonText = signal('');
  readonly nodesCsv = signal('');
  readonly edgesCsv = signal('');

  readonly idMapSize = computed(() => Object.keys(this.store.result()?.idMap ?? {}).length);

  async readFile(target: 'json' | 'nodes' | 'edges', input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (target === 'json') this.jsonText.set(text);
    else if (target === 'nodes') this.nodesCsv.set(text);
    else this.edgesCsv.set(text);
  }

  async submit(): Promise<void> {
    if (!this.name) return;
    if (this.mode() === 'json') await this.store.runJson(this.name, this.jsonText(), this.atomic());
    else await this.store.runCsv(this.name, this.nodesCsv(), this.edgesCsv(), this.atomic());
  }
}
```

`apps/web/src/app/import/import.html`:

```html
<section class="import">
  <header class="import-head">
    <h1>Import into {{ name || '(no database)' }}</h1>
    @if (name) {
      <a routerLink="/db/{{ name }}">Open workspace</a>
    } @else {
      <a routerLink="/databases">Choose a database</a>
    }
  </header>

  <div class="import-modes" role="tablist" aria-label="Import format">
    <button
      type="button"
      role="tab"
      [attr.aria-selected]="mode() === 'json'"
      [class.active]="mode() === 'json'"
      (click)="mode.set('json')"
    >
      JSON
    </button>
    <button
      type="button"
      role="tab"
      [attr.aria-selected]="mode() === 'csv'"
      [class.active]="mode() === 'csv'"
      (click)="mode.set('csv')"
    >
      CSV
    </button>
  </div>

  @if (mode() === 'json') {
    <label for="json-text">Paste JSON ({ nodes, edges })</label>
    <textarea
      id="json-text"
      rows="10"
      [ngModel]="jsonText()"
      (ngModelChange)="jsonText.set($event)"
    ></textarea>
    <label for="json-file" class="file-label">…or upload a .json file</label>
    <input id="json-file" type="file" accept=".json,application/json" #jf (change)="readFile('json', jf)" />
  } @else {
    <label for="nodes-csv">nodes.csv</label>
    <textarea
      id="nodes-csv"
      rows="6"
      placeholder="tempId,:label,name:string"
      [ngModel]="nodesCsv()"
      (ngModelChange)="nodesCsv.set($event)"
    ></textarea>
    <input id="nodes-file" type="file" accept=".csv,text/csv" #nf (change)="readFile('nodes', nf)" />
    <label for="edges-csv">edges.csv</label>
    <textarea
      id="edges-csv"
      rows="6"
      placeholder=":from,:to,:type"
      [ngModel]="edgesCsv()"
      (ngModelChange)="edgesCsv.set($event)"
    ></textarea>
    <input id="edges-file" type="file" accept=".csv,text/csv" #ef (change)="readFile('edges', ef)" />
  }

  <label class="atomic">
    <input
      type="checkbox"
      [ngModel]="atomic()"
      (ngModelChange)="atomic.set($event)"
    />
    Atomic (all-or-nothing)
  </label>

  <button type="button" (click)="submit()" [disabled]="store.busy() || !name">
    {{ store.busy() ? 'Importing…' : 'Run import' }}
  </button>

  @if (store.error()) {
    <p class="error" role="alert">{{ store.error() }}</p>
  }

  @if (store.result(); as r) {
    <div class="import-result" aria-live="polite">
      <p>
        Committed <strong>{{ r.committed.nodes }}</strong> nodes and
        <strong>{{ r.committed.edges }}</strong> edges. idMap: {{ idMapSize() }} entries.
      </p>
      @if (r.error) {
        <p class="error">
          First error at {{ r.error.at.kind }} #{{ r.error.at.index }}: {{ r.error.message }}
        </p>
      } @else {
        <p class="ok">No errors.</p>
      }
    </div>
  }
</section>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — builder validation matrix, store run/error mapping, and the page smoke.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): import page with JSON/CSV builder, atomic toggle, and result view"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 5: ⌘K command palette — node search that selects + centers on the canvas

A keyboard-triggered (⌘/Ctrl+K) overlay that searches nodes in the current database via AQL and, on selection, brings the chosen node onto the canvas and selects + centers it through the real `GraphStore` + `GraphCanvas.fit()`. The AQL search-query builder + the row→hit mapper are pure (unit-tested); the overlay is a focus-trapped `role="dialog"` with an ARIA listbox and arrow-key navigation (§7.5).

**Files:**
- Create: `apps/web/src/app/search/node-search.ts`, `apps/web/src/app/search/command-palette.ts`, `apps/web/src/app/search/command-palette.html`
- Modify: `apps/web/src/app/workspace/workspace.ts`, `apps/web/src/app/workspace/workspace.html`
- Test: `apps/web/src/app/search/node-search.spec.ts`, `apps/web/src/app/search/command-palette.spec.ts`, `apps/web/src/app/workspace/workspace.spec.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/search/node-search.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { searchQuery, toHits, type NodeHit } from './node-search';
import type { QueryResponse } from '@atlas/protocol';

describe('searchQuery', () => {
  it('builds a parameterized AQL query that CONTAINS the term on name/title', () => {
    const { query, params } = searchQuery('Ada', 25);
    expect(query).toContain('MATCH (n)');
    expect(query).toContain('CONTAINS');
    expect(query).toContain('$term');
    expect(query).toContain('n.name');
    expect(query).toContain('n.title');
    expect(query).toContain('LIMIT $limit');
    // The term is bound verbatim as a parameter — never interpolated into the query.
    expect(params.term).toBe('Ada');
    expect(params.limit).toBe(25);
  });

  it('trims surrounding whitespace from the bound term', () => {
    expect(searchQuery('  Ada  ', 10).params.term).toBe('Ada');
  });
});

describe('toHits', () => {
  const res: QueryResponse = {
    columns: ['n'],
    rows: [
      [{ id: '7', labels: ['Person'], props: { name: 'Ada Lovelace' } }],
      [{ id: '8', labels: ['City'], props: { title: 'Bath' } }],
    ],
    stats: { rowsExamined: 2, elapsedMs: 0 },
  };

  it('maps node cells to hits with a display label derived from props', () => {
    const hits: NodeHit[] = toHits(res);
    expect(hits[0]).toEqual({ id: '7', labels: ['Person'], label: 'Ada Lovelace' });
    // Falls back to the next common name-ish prop, then to the id.
    expect(hits[1].label).toBe('Bath');
  });

  it('falls back to "#id" when no name-ish property exists', () => {
    const noName: QueryResponse = {
      columns: ['n'],
      rows: [[{ id: '9', labels: ['X'], props: { weight: 3 } }]],
      stats: { rowsExamined: 1, elapsedMs: 0 },
    };
    expect(toHits(noName)[0].label).toBe('#9');
  });

  it('ignores non-node cells', () => {
    const mixed: QueryResponse = {
      columns: ['x'],
      rows: [[42], ['str'], [null]],
      stats: { rowsExamined: 0, elapsedMs: 0 },
    };
    expect(toHits(mixed)).toEqual([]);
  });
});
```

`apps/web/src/app/search/command-palette.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { CommandPalette } from './command-palette';
import type { QueryResponse } from '@atlas/protocol';

const found: QueryResponse = {
  columns: ['n'],
  rows: [[{ id: '7', labels: ['Person'], props: { name: 'Ada' } }]],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};

describe('CommandPalette', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup(query = vi.fn().mockResolvedValue(found)) {
    TestBed.configureTestingModule({
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query }) } }],
    });
    const fixture = TestBed.createComponent(CommandPalette);
    fixture.componentRef.setInput('database', 'kb');
    return { fixture, query };
  }

  it('runs the search and exposes hits', async () => {
    const { fixture, query } = setup();
    const cmp = fixture.componentInstance;
    cmp.term.set('ada');
    await cmp.search();
    expect(query).toHaveBeenCalledTimes(1);
    expect(cmp.hits()).toHaveLength(1);
    expect(cmp.hits()[0].label).toBe('Ada');
  });

  it('arrow keys move the active index and Enter emits the active hit', async () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    const picked: string[] = [];
    cmp.pick.subscribe((h) => picked.push(h.id));
    cmp.term.set('ada');
    await cmp.search();
    cmp.onKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picked).toEqual(['7']);
  });

  it('Escape emits close', () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    let closed = false;
    cmp.closed.subscribe(() => (closed = true));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(true);
  });
});
```

Add to `apps/web/src/app/workspace/workspace.spec.ts` (inside the existing `describe`, reusing its `setup`/`schema`/`initial` fixtures and the `db()` helper that returns `{ query, schema, subscribe }`):

```ts
  it('⌘K toggles the command palette open', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const fixture = setup(query, schemaFn);
    fixture.detectChanges();
    await fixture.componentInstance.ready;
    expect(fixture.componentInstance.paletteOpen()).toBe(false);
    fixture.componentInstance.onHostKey(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
    );
    expect(fixture.componentInstance.paletteOpen()).toBe(true);
  });

  it('picking a search hit adds it to the store and selects it', async () => {
    const query = vi.fn().mockResolvedValue(initial);
    const schemaFn = vi.fn().mockResolvedValue(schema);
    const fixture = setup(query, schemaFn);
    fixture.detectChanges();
    await fixture.componentInstance.ready;
    await fixture.whenStable();
    await fixture.componentInstance.onPick({ id: '1', labels: ['Person'], label: 'Ada' });
    expect(fixture.componentInstance.store.selection()).toEqual({ kind: 'node', id: '1' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./node-search`, `./command-palette` not found; `paletteOpen`/`onHostKey`/`onPick` not on `Workspace`.

- [ ] **Step 3: Implement the pure search module**

`apps/web/src/app/search/node-search.ts`:

```ts
import type { QueryResponse } from '@atlas/protocol';

export interface NodeHit {
  id: string;
  labels: string[];
  /** Human display string derived from the node's props (falls back to "#id"). */
  label: string;
}

/** Props checked, in order, to derive a node's display label. */
const NAME_KEYS = ['name', 'title', 'label', 'username', 'id'];

interface RawNode {
  id: string | number;
  labels?: string[];
  props?: Record<string, unknown>;
}
function isRawNode(v: unknown): v is RawNode {
  return typeof v === 'object' && v !== null && 'id' in v && 'props' in v && 'labels' in v;
}

/**
 * Build a parameterized AQL query that finds nodes whose `name` or `title`
 * property CONTAINS the term. The term and limit are always bound as
 * `$term`/`$limit` — never string-interpolated — so the search is injection-safe.
 *
 * Constrained to what the engine actually supports (verified in
 * `@atlas/query` `eval.ts`/`parser.ts`): the only scalar functions are
 * `id()`/`labels()`/`type()` (no `toLower`/`toString`), and `CONTAINS` is the
 * `text` op which returns `false` unless BOTH operands are strings — so it is
 * case-sensitive and only matches string-valued `name`/`title` props. We bind
 * the term verbatim (trimmed) and OR the two most common name-ish properties;
 * `CONTAINS` uses the full-text index when present and falls back to a scan
 * otherwise (spec §4.5), which is fine for the explorer's interactive cap.
 */
export function searchQuery(term: string, limit: number): {
  query: string;
  params: Record<string, unknown>;
} {
  const query =
    'MATCH (n) WHERE n.name CONTAINS $term OR n.title CONTAINS $term RETURN n LIMIT $limit';
  return { query, params: { term: term.trim(), limit } };
}

/** Map a node-shaped query result into display hits, ignoring non-node cells. */
export function toHits(res: QueryResponse): NodeHit[] {
  const hits: NodeHit[] = [];
  const seen = new Set<string>();
  for (const row of res.rows)
    for (const cell of row) {
      if (!isRawNode(cell)) continue;
      const id = String(cell.id);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({ id, labels: cell.labels ?? [], label: displayLabel(cell) });
    }
  return hits;
}

function displayLabel(node: RawNode): string {
  const props = node.props ?? {};
  for (const key of NAME_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return `#${node.id}`;
}
```

`apps/web/src/app/search/command-palette.ts`:

```ts
import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AtlasApi } from '../core/atlas-api';
import { searchQuery, toHits, type NodeHit } from './node-search';

/** Max hits surfaced per search — keeps the overlay scannable and the query capped. */
const SEARCH_LIMIT = 25;

@Component({
  selector: 'app-command-palette',
  imports: [FormsModule],
  templateUrl: './command-palette.html',
})
export class CommandPalette {
  private readonly api = inject(AtlasApi);
  /** Current database name (workspace passes it in). */
  readonly database = input.required<string>();

  /** Emits the picked node hit; the workspace brings it onto the canvas. */
  readonly pick = output<NodeHit>();
  /** Emits when the palette should close (Escape / backdrop). */
  readonly closed = output<void>();

  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('box');

  readonly term = signal('');
  readonly hits = signal<NodeHit[]>([]);
  readonly active = signal(0);
  readonly busy = signal(false);

  /** Focus the search box on open (called by the workspace after it mounts). */
  focusInput(): void {
    this.searchBox()?.nativeElement.focus();
  }

  async search(): Promise<void> {
    const term = this.term().trim();
    if (!term) {
      this.hits.set([]);
      return;
    }
    this.busy.set(true);
    try {
      const { query, params } = searchQuery(term, SEARCH_LIMIT);
      const res = await this.api.database(this.database()).query(query, params);
      this.hits.set(toHits(res));
      this.active.set(0);
    } catch {
      this.hits.set([]);
    } finally {
      this.busy.set(false);
    }
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.closed.emit();
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

  choose(hit: NodeHit): void {
    this.pick.emit(hit);
  }
}
```

`apps/web/src/app/search/command-palette.html`:

```html
<div class="palette-backdrop" (click)="closed.emit()"></div>
<div
  class="palette"
  role="dialog"
  aria-modal="true"
  aria-label="Search nodes"
  (keydown)="onKey($event)"
>
  <label class="sr-only" for="palette-box">Search nodes</label>
  <input
    #box
    id="palette-box"
    type="search"
    placeholder="Search nodes by name…"
    autocomplete="off"
    role="combobox"
    aria-expanded="true"
    aria-controls="palette-list"
    [attr.aria-activedescendant]="hits().length ? 'hit-' + active() : null"
    [ngModel]="term()"
    (ngModelChange)="term.set($event)"
    (input)="search()"
  />
  @if (busy()) {
    <p class="palette-status">Searching…</p>
  }
  <ul id="palette-list" class="palette-list" role="listbox" aria-label="Search results">
    @for (hit of hits(); track hit.id; let i = $index) {
      <li
        [id]="'hit-' + i"
        class="palette-hit"
        role="option"
        [attr.aria-selected]="i === active()"
        [class.active]="i === active()"
        (click)="choose(hit)"
      >
        <span class="hit-label">{{ hit.label }}</span>
        <span class="hit-labels">{{ hit.labels.join(', ') }}</span>
      </li>
    } @empty {
      @if (term().trim() && !busy()) {
        <li class="palette-empty">No matches.</li>
      }
    }
  </ul>
</div>
```

- [ ] **Step 4: Wire the palette into the workspace**

Add to `apps/web/src/app/workspace/workspace.ts`: import the palette + the `NodeHit` type and `parseGraphRows`/`neighborQuery` already imported; add a `paletteOpen` signal, a host key handler bound in the template, and an `onPick` that fetches the node, adds it to the store, selects it, and re-fits the canvas.

Add to the imports:

```ts
import { CommandPalette } from '../search/command-palette';
import type { NodeHit } from '../search/node-search';
```

Add `CommandPalette` to the component `imports` array. Add these members to the `Workspace` class:

```ts
  /** Whether the ⌘K command palette overlay is open. */
  readonly paletteOpen = signal(false);
  private readonly palette = viewChild(CommandPalette);

  /** ⌘/Ctrl+K toggles the palette; bound on the workspace host in the template. */
  onHostKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      this.paletteOpen.update((v) => !v);
      if (this.paletteOpen()) queueMicrotask(() => this.palette()?.focusInput());
    }
  }

  closePalette(): void {
    this.paletteOpen.set(false);
  }

  /**
   * Bring a searched node onto the canvas: fetch it (with its immediate neighbors,
   * reusing the expand query so the node is not stranded), merge into the store,
   * select it, close the palette, and re-fit the camera so the node is centered.
   */
  async onPick(hit: NodeHit): Promise<void> {
    this.paletteOpen.set(false);
    const { query, params } = neighborQuery(hit.id);
    try {
      const res = await this.api.database(this.name).query(query, params);
      this.store.addGraph(parseGraphRows(res));
    } catch {
      // If the node has no neighbors (or the expand query fails), still select it
      // from whatever is already loaded so the inspector opens.
    }
    this.store.select({ kind: 'node', id: hit.id });
    this.canvas().fit();
  }
```

Add `signal` and `viewChild` to the existing `@angular/core` import in `workspace.ts` if not already present (both are already imported: `viewChild`, `signal`).

`apps/web/src/app/workspace/workspace.html` — add the host key binding to the root element, a ⌘K button next to the dock tabs, and the overlay after the body:

Change the root element:

```html
<div class="workspace" tabindex="0" (keydown)="onHostKey($event)">
```

Add inside `<header class="ws-topbar">`, before `<span class="ws-stats">`:

```html
    <button type="button" class="ws-search" (click)="onHostKey({ metaKey: true, key: 'k', preventDefault: () => {} } )" aria-keyshortcuts="Meta+K Control+K">
      Search nodes <kbd>⌘K</kbd>
    </button>
```

> Note: the inline-object form above is awkward; prefer a dedicated method. Replace it with a `openPalette()` method on the component (`this.paletteOpen.set(true); queueMicrotask(() => this.palette()?.focusInput());`) and bind `(click)="openPalette()"`. Add `openPalette()` to the class alongside `onHostKey`.

Add at the end of the template (after the closing `</div>` of `.ws-dock` block, inside the root `.workspace`):

```html
  @if (paletteOpen()) {
    <app-command-palette
      [database]="name"
      (pick)="onPick($event)"
      (closed)="closePalette()"
    />
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — the pure search module, the palette overlay (search/arrow/Enter/Escape), and the workspace ⌘K toggle + pick→select.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): ⌘K command palette node search that selects and centers on the canvas"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 6: Admin — token management + per-database role management

A guarded Admin view (a child of the shell) with two panels. **Tokens:** create (full secret shown once), list, and revoke the current user's API tokens via `/api/tokens`. **Roles:** for databases the user OWNS, grant/revoke `viewer`/`editor`/`owner` by username via `/api/db/:name/roles`, with current owners surfaced from `GET /api/db/:name`. Each panel has a signal store with unit-tested logic; components get smoke specs.

**Files:**
- Create: `apps/web/src/app/admin/admin.ts`, `apps/web/src/app/admin/admin.html`, `apps/web/src/app/admin/tokens.store.ts`, `apps/web/src/app/admin/tokens-panel.ts`, `apps/web/src/app/admin/tokens-panel.html`, `apps/web/src/app/admin/roles.store.ts`, `apps/web/src/app/admin/roles-panel.ts`, `apps/web/src/app/admin/roles-panel.html`
- Test: `apps/web/src/app/admin/tokens.store.spec.ts`, `apps/web/src/app/admin/tokens-panel.spec.ts`, `apps/web/src/app/admin/roles.store.spec.ts`, `apps/web/src/app/admin/roles-panel.spec.ts`, `apps/web/src/app/admin/admin.spec.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/admin/tokens.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { TokensStore } from './tokens.store';
import type { CreatedToken, TokenSummary } from '@atlas/client';

const list: TokenSummary[] = [{ tokenId: 't1', name: 'ci' }];
const created: CreatedToken = { tokenId: 't2', name: 'cli', token: 't2.secretsecret' };

function withApi(api: Partial<AtlasApi>): TokensStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(TokensStore);
}

describe('TokensStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the tokens signal', async () => {
    const store = withApi({ listTokens: vi.fn().mockResolvedValue(list) });
    await store.load();
    expect(store.tokens()).toEqual(list);
  });

  it('create() shows the full secret once and reloads the list', async () => {
    const listTokens = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce([...list, { tokenId: 't2', name: 'cli' }]);
    const createToken = vi.fn().mockResolvedValue(created);
    const store = withApi({ listTokens, createToken });
    await store.load();
    await store.create('cli');
    expect(createToken).toHaveBeenCalledWith('cli');
    expect(store.lastSecret()).toBe('t2.secretsecret');
    expect(store.tokens().map((t) => t.tokenId)).toContain('t2');
  });

  it('revoke() removes the token and reloads', async () => {
    const listTokens = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce([]);
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listTokens, revokeToken });
    await store.load();
    await store.revoke('t1');
    expect(revokeToken).toHaveBeenCalledWith('t1');
    expect(store.tokens()).toEqual([]);
  });

  it('clearSecret() hides the one-time secret', async () => {
    const store = withApi({
      listTokens: vi.fn().mockResolvedValue(list),
      createToken: vi.fn().mockResolvedValue(created),
    });
    await store.create('cli');
    expect(store.lastSecret()).not.toBe('');
    store.clearSecret();
    expect(store.lastSecret()).toBe('');
  });
});
```

`apps/web/src/app/admin/roles.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { RolesStore } from './roles.store';
import type { DbSummary } from '@atlas/client';
import type { DbInfo } from '@atlas/protocol';

const dbs: DbSummary[] = [
  { name: 'kb', description: '', role: 'owner' },
  { name: 'readonly', description: '', role: 'viewer' },
];
const kbInfo: DbInfo = { name: 'kb', role: 'owner', owners: ['ada'] };

function withApi(api: Partial<AtlasApi>): RolesStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(RolesStore);
}

describe('RolesStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() keeps only databases the user owns', async () => {
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs) });
    await store.load();
    expect(store.ownedDatabases().map((d) => d.name)).toEqual(['kb']);
  });

  it('selecting a db loads its owners', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs), getDatabase });
    await store.load();
    await store.select('kb');
    expect(store.selected()).toBe('kb');
    expect(store.owners()).toEqual(['ada']);
  });

  it('grant() calls the API then refreshes owners', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const grantRole = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs), getDatabase, grantRole });
    await store.load();
    await store.select('kb');
    await store.grant('bob', 'editor');
    expect(grantRole).toHaveBeenCalledWith('kb', 'bob', 'editor');
  });

  it('grant() maps a 404 (unknown user) to a friendly error', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const grantRole = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 404 }));
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs), getDatabase, grantRole });
    await store.load();
    await store.select('kb');
    await store.grant('ghost', 'viewer');
    expect(store.error()).toContain('No user');
  });

  it('revoke() calls the API with the db + username', async () => {
    const getDatabase = vi.fn().mockResolvedValue(kbInfo);
    const revokeRole = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs), getDatabase, revokeRole });
    await store.load();
    await store.select('kb');
    await store.revoke('bob');
    expect(revokeRole).toHaveBeenCalledWith('kb', 'bob');
  });
});
```

`apps/web/src/app/admin/tokens-panel.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { TokensPanel } from './tokens-panel';
import type { CreatedToken, TokenSummary } from '@atlas/client';

const list: TokenSummary[] = [{ tokenId: 't1', name: 'ci' }];
const created: CreatedToken = { tokenId: 't2', name: 'cli', token: 't2.secret' };

describe('TokensPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists tokens and shows the one-time secret after create', async () => {
    const listTokens = vi.fn().mockResolvedValue(list);
    const createToken = vi.fn().mockResolvedValue(created);
    await TestBed.configureTestingModule({
      imports: [TokensPanel],
      providers: [{ provide: AtlasApi, useValue: { listTokens, createToken } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(TokensPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ci');

    fixture.componentInstance.newName.set('cli');
    await fixture.componentInstance.create();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('t2.secret');
  });
});
```

`apps/web/src/app/admin/roles-panel.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { RolesPanel } from './roles-panel';
import type { DbSummary } from '@atlas/client';
import type { DbInfo } from '@atlas/protocol';

const dbs: DbSummary[] = [{ name: 'kb', description: '', role: 'owner' }];
const kbInfo: DbInfo = { name: 'kb', role: 'owner', owners: ['ada'] };

describe('RolesPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders owned databases and their owners', async () => {
    await TestBed.configureTestingModule({
      imports: [RolesPanel],
      providers: [
        {
          provide: AtlasApi,
          useValue: {
            listDatabases: vi.fn().mockResolvedValue(dbs),
            getDatabase: vi.fn().mockResolvedValue(kbInfo),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(RolesPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('kb');
  });
});
```

`apps/web/src/app/admin/admin.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Admin } from './admin';

describe('Admin page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the Tokens and Roles tabs', async () => {
    await TestBed.configureTestingModule({
      imports: [Admin],
      providers: [
        {
          provide: AtlasApi,
          useValue: { listTokens: vi.fn().mockResolvedValue([]), listDatabases: vi.fn().mockResolvedValue([]) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Admin);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Tokens');
    expect(text).toContain('Roles');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — none of the admin stores/components exist yet.

- [ ] **Step 3: Implement the stores and components**

`apps/web/src/app/admin/tokens.store.ts`:

```ts
import { inject, Injectable, signal } from '@angular/core';
import type { TokenSummary } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable()
export class TokensStore {
  private readonly api = inject(AtlasApi);
  private readonly _tokens = signal<TokenSummary[]>([]);
  private readonly _error = signal('');
  /** The full secret of the most recently created token — shown once, then cleared. */
  private readonly _lastSecret = signal('');

  readonly tokens = this._tokens.asReadonly();
  readonly error = this._error.asReadonly();
  readonly lastSecret = this._lastSecret.asReadonly();

  async load(): Promise<void> {
    this._error.set('');
    try {
      this._tokens.set(await this.api.listTokens());
    } catch {
      this._error.set('Could not load tokens.');
    }
  }

  async create(name: string): Promise<void> {
    this._error.set('');
    try {
      const created = await this.api.createToken(name);
      this._lastSecret.set(created.token);
      await this.load();
    } catch {
      this._error.set('Could not create the token.');
    }
  }

  async revoke(tokenId: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.revokeToken(tokenId);
      await this.load();
    } catch {
      this._error.set('Could not revoke the token.');
    }
  }

  clearSecret(): void {
    this._lastSecret.set('');
  }
}
```

`apps/web/src/app/admin/tokens-panel.ts`:

```ts
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TokensStore } from './tokens.store';

@Component({
  selector: 'app-tokens-panel',
  imports: [FormsModule],
  templateUrl: './tokens-panel.html',
  providers: [TokensStore],
})
export class TokensPanel implements OnInit {
  readonly store = inject(TokensStore);
  readonly newName = signal('');

  ngOnInit(): void {
    void this.store.load();
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    await this.store.create(name);
    if (!this.store.error()) this.newName.set('');
  }
}
```

`apps/web/src/app/admin/tokens-panel.html`:

```html
<section class="admin-panel">
  <h2>API tokens</h2>
  <p class="muted">Programmatic access tokens scoped to your account.</p>

  <form class="create" (ngSubmit)="create()">
    <label class="sr-only" for="token-name">New token name</label>
    <input
      id="token-name"
      placeholder="token name (e.g. ci)"
      [ngModel]="newName()"
      (ngModelChange)="newName.set($event)"
      name="token-name"
    />
    <button type="submit" [disabled]="!newName().trim()">Create token</button>
  </form>

  @if (store.lastSecret(); as secret) {
    <div class="token-secret" role="alert">
      <p>Copy this token now — it is shown only once:</p>
      <code>{{ secret }}</code>
      <button type="button" (click)="store.clearSecret()">Done</button>
    </div>
  }

  @if (store.error()) {
    <p class="error" role="alert">{{ store.error() }}</p>
  }

  <ul class="token-list">
    @for (t of store.tokens(); track t.tokenId) {
      <li class="token-row">
        <span class="token-name">{{ t.name }}</span>
        <code class="token-id">{{ t.tokenId }}</code>
        <button type="button" (click)="store.revoke(t.tokenId)">Revoke</button>
      </li>
    } @empty {
      <li class="muted">No tokens yet.</li>
    }
  </ul>
</section>
```

`apps/web/src/app/admin/roles.store.ts`:

```ts
import { computed, inject, Injectable, signal } from '@angular/core';
import type { DbSummary } from '@atlas/client';
import type { RoleName } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';

@Injectable()
export class RolesStore {
  private readonly api = inject(AtlasApi);
  private readonly _databases = signal<DbSummary[]>([]);
  private readonly _selected = signal('');
  private readonly _owners = signal<string[]>([]);
  private readonly _error = signal('');

  /** Only databases the caller owns can have their roles managed (spec §6.2). */
  readonly ownedDatabases = computed(() => this._databases().filter((d) => d.role === 'owner'));
  readonly selected = this._selected.asReadonly();
  readonly owners = this._owners.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._error.set('');
    try {
      this._databases.set(await this.api.listDatabases());
    } catch {
      this._error.set('Could not load databases.');
    }
  }

  async select(name: string): Promise<void> {
    this._selected.set(name);
    this._owners.set([]);
    this._error.set('');
    try {
      const info = await this.api.getDatabase(name);
      this._owners.set(info.owners);
    } catch {
      this._error.set('Could not load database owners.');
    }
  }

  async grant(username: string, role: RoleName): Promise<void> {
    if (!this._selected()) return;
    this._error.set('');
    try {
      await this.api.grantRole(this._selected(), username, role);
      await this.select(this._selected());
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 404 ? `No user named "${username}".` : 'Could not grant the role.',
      );
    }
  }

  async revoke(username: string): Promise<void> {
    if (!this._selected()) return;
    this._error.set('');
    try {
      await this.api.revokeRole(this._selected(), username);
      await this.select(this._selected());
    } catch {
      this._error.set('Could not revoke the role.');
    }
  }
}
```

`apps/web/src/app/admin/roles-panel.ts`:

```ts
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RoleName } from '@atlas/protocol';
import { RolesStore } from './roles.store';

@Component({
  selector: 'app-roles-panel',
  imports: [FormsModule],
  templateUrl: './roles-panel.html',
  providers: [RolesStore],
})
export class RolesPanel implements OnInit {
  readonly store = inject(RolesStore);
  readonly grantUser = signal('');
  readonly grantRole = signal<RoleName>('viewer');
  readonly roles: RoleName[] = ['viewer', 'editor', 'owner'];

  ngOnInit(): void {
    void this.store.load();
  }

  async grant(): Promise<void> {
    const user = this.grantUser().trim();
    if (!user) return;
    await this.store.grant(user, this.grantRole());
    if (!this.store.error()) this.grantUser.set('');
  }
}
```

`apps/web/src/app/admin/roles-panel.html`:

```html
<section class="admin-panel">
  <h2>Database roles</h2>
  <p class="muted">Grant or revoke roles on databases you own.</p>

  <label for="role-db">Database</label>
  <select id="role-db" [ngModel]="store.selected()" (ngModelChange)="store.select($event)">
    <option value="" disabled>Choose a database…</option>
    @for (db of store.ownedDatabases(); track db.name) {
      <option [value]="db.name">{{ db.name }}</option>
    }
  </select>

  @if (store.ownedDatabases().length === 0) {
    <p class="muted">You do not own any databases.</p>
  }

  @if (store.selected()) {
    <p class="owners">Owners: {{ store.owners().join(', ') || '—' }}</p>

    <form class="grant" (ngSubmit)="grant()">
      <label class="sr-only" for="grant-user">Username</label>
      <input
        id="grant-user"
        placeholder="username"
        [ngModel]="grantUser()"
        (ngModelChange)="grantUser.set($event)"
        name="grant-user"
      />
      <label class="sr-only" for="grant-role">Role</label>
      <select
        id="grant-role"
        [ngModel]="grantRole()"
        (ngModelChange)="grantRole.set($event)"
        name="grant-role"
      >
        @for (r of roles; track r) {
          <option [value]="r">{{ r }}</option>
        }
      </select>
      <button type="submit" [disabled]="!grantUser().trim()">Grant</button>
    </form>

    <ul class="owner-list">
      @for (owner of store.owners(); track owner) {
        <li class="owner-row">
          <span>{{ owner }} <span class="role role-owner">owner</span></span>
          <button type="button" (click)="store.revoke(owner)">Revoke</button>
        </li>
      }
    </ul>
  }

  @if (store.error()) {
    <p class="error" role="alert">{{ store.error() }}</p>
  }
</section>
```

`apps/web/src/app/admin/admin.ts`:

```ts
import { Component, signal } from '@angular/core';
import { RolesPanel } from './roles-panel';
import { TokensPanel } from './tokens-panel';

type AdminTab = 'tokens' | 'roles';

@Component({
  selector: 'app-admin',
  imports: [TokensPanel, RolesPanel],
  templateUrl: './admin.html',
})
export class Admin {
  readonly tab = signal<AdminTab>('tokens');
}
```

`apps/web/src/app/admin/admin.html`:

```html
<section class="admin">
  <h1>Admin</h1>
  <nav class="admin-tabs" role="tablist" aria-label="Admin sections">
    <button
      type="button"
      role="tab"
      [attr.aria-selected]="tab() === 'tokens'"
      [class.active]="tab() === 'tokens'"
      (click)="tab.set('tokens')"
    >
      Tokens
    </button>
    <button
      type="button"
      role="tab"
      [attr.aria-selected]="tab() === 'roles'"
      [class.active]="tab() === 'roles'"
      (click)="tab.set('roles')"
    >
      Roles
    </button>
  </nav>

  @switch (tab()) {
    @case ('tokens') {
      <app-tokens-panel />
    }
    @case ('roles') {
      <app-roles-panel />
    }
  }
</section>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — tokens store/panel, roles store/panel, and the Admin tabs.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): admin views for API tokens and per-database role management"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 7: Wire routes + nav, Playwright e2e, README, and the full M6 gate

Add the Import and Admin routes (guarded) and surface them in the shell nav and the picker; add one Playwright e2e covering ⌘K search and the import flow (excluded from the default gate); flip the README to "M6 complete"; run the full gate green. Note the M7 deferrals.

**Files:**
- Modify: `apps/web/src/app/app.routes.ts`, `apps/web/src/app/shell/shell.html`, `apps/web/src/app/picker/picker.html`, `apps/web/src/styles.css`, `README.md`
- Create: `apps/web/e2e/explorer-m6d.spec.ts`

- [ ] **Step 1: Add the guarded routes**

Add to `apps/web/src/app/app.routes.ts`, inside the `databases` route's `children` array (so they render under the shell with the top bar) — replace the single-child array:

```ts
    children: [
      { path: '', loadComponent: () => import('./picker/picker').then((m) => m.Picker) },
      { path: 'import', loadComponent: () => import('./import/import').then((m) => m.Import) },
      { path: 'admin', loadComponent: () => import('./admin/admin').then((m) => m.Admin) },
    ],
```

(The import page reads `?db=` from the query string, so it is reachable as `/databases/import?db=kb`.)

- [ ] **Step 2: Surface the nav links**

`apps/web/src/app/shell/shell.html` — add a nav between the brand and the right-side controls:

```html
<div class="shell">
  <header class="topbar">
    <div class="brand">Atlas</div>
    <nav class="shell-nav" aria-label="Primary">
      <a routerLink="/databases" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Databases</a>
      <a routerLink="/databases/import" routerLinkActive="active">Import</a>
      <a routerLink="/databases/admin" routerLinkActive="active">Admin</a>
    </nav>
    <div class="topbar-right">
      <app-theme-switcher />
      @if (auth.user(); as u) {
        <div class="user-menu">
          <span class="username">{{ u.username }}</span>
          <button type="button" class="logout" (click)="logout()">Log out</button>
        </div>
      }
    </div>
  </header>
  <main class="shell-body">
    <router-outlet />
  </main>
</div>
```

Add `RouterLink` and `RouterLinkActive` to the `Shell` component's imports (`apps/web/src/app/shell/shell.ts`): change the import to `import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';` and add `RouterLink, RouterLinkActive` to the `imports` array.

`apps/web/src/app/picker/picker.html` — add a per-db Import link inside `.db-actions` (owner/editor only, matching the seed gate):

```html
          <div class="db-actions">
            <button type="button" (click)="open(db.name)">Open</button>
            @if (db.role === 'owner' || db.role === 'editor') {
              <button type="button" (click)="seed(db.name)">Seed science-history</button>
              <a class="db-import" routerLink="/databases/import" [queryParams]="{ db: db.name }">Import</a>
            }
          </div>
```

Add `RouterLink` to the `Picker` component imports (`apps/web/src/app/picker/picker.ts`): `import { RouterLink, Router } from '@angular/router';` and add `RouterLink` to the `imports` array.

- [ ] **Step 3: Add the overlay / admin / import styling**

Append to `apps/web/src/styles.css` (uses the existing theme tokens; the `.sr-only` and form rules already exist from M6a):

```css
.shell-nav {
  display: flex;
  gap: 1rem;
  margin-left: 1.5rem;
}
.shell-nav a {
  color: var(--text-muted);
  text-decoration: none;
}
.shell-nav a.active {
  color: var(--text);
  border-bottom: 2px solid var(--accent);
}

.palette-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 40;
}
.palette {
  position: fixed;
  top: 12vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(40rem, 92vw);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.75rem;
  z-index: 41;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
}
.palette input[type='search'] {
  width: 100%;
}
.palette-list {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  max-height: 50vh;
  overflow: auto;
}
.palette-hit {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
  cursor: pointer;
}
.palette-hit.active {
  background: var(--accent);
  color: #fff;
}
.palette-hit .hit-labels,
.palette-empty,
.palette-status {
  color: var(--text-muted);
}
.ws-search {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.ws-search kbd {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 0.25rem;
  margin-left: 0.35rem;
}

.admin,
.import {
  padding: 1.5rem;
  max-width: 48rem;
  margin: 0 auto;
}
.admin-tabs,
.import-modes {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.admin-tabs button.active,
.import-modes button.active {
  border-color: var(--accent);
  color: var(--text);
}
.admin-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.token-list,
.owner-list {
  list-style: none;
  padding: 0;
}
.token-row,
.owner-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-top: 1px solid var(--border);
}
.token-secret {
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 0.75rem;
  margin: 0.75rem 0;
}
.token-secret code {
  display: block;
  word-break: break-all;
  margin: 0.5rem 0;
}
.import textarea {
  width: 100%;
  font-family: var(--font);
}
.import-result {
  margin-top: 1rem;
}
.muted {
  color: var(--text-muted);
}
.ok {
  color: var(--accent-2);
}
```

- [ ] **Step 4: Write the Playwright e2e (excluded from the default gate)**

`apps/web/e2e/explorer-m6d.spec.ts` (the `apps/web/playwright.config.ts` + the `e2e`/`e2e:web` scripts already exist from M6a; this spec is auto-picked up by `testDir: './e2e'`):

```ts
import { expect, test } from '@playwright/test';

test('import data, then find a node with ⌘K and center it on the canvas', async ({ page }) => {
  const username = `m6d_${Date.now()}`;

  // Register (auto-logs in) and create a database.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  await page.getByPlaceholder('new-database').fill('m6d-kb');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('m6d-kb')).toBeVisible();

  // Import a tiny JSON graph via the Import page.
  await page.getByRole('link', { name: 'Import' }).first().click();
  await expect(page).toHaveURL(/\/databases\/import/);
  await page.getByLabel(/Paste JSON/).fill(
    JSON.stringify({
      nodes: [
        { tempId: 'a', labels: ['Person'], properties: { name: 'Ada Lovelace' } },
        { tempId: 'b', labels: ['Person'], properties: { name: 'Bob' } },
      ],
      edges: [{ from: 'a', to: 'b', type: 'KNOWS', properties: {} }],
    }),
  );
  await page.getByRole('button', { name: /run import/i }).click();
  await expect(page.getByText(/Committed/)).toContainText('2');

  // Open the workspace and search for the node with ⌘K.
  await page.goto('/db/m6d-kb');
  await expect(page.getByRole('heading', { name: 'm6d-kb' })).toBeVisible();
  await page.locator('.workspace').focus();
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search nodes' });
  await expect(palette).toBeVisible();
  // CONTAINS is case-sensitive in the engine, so search with the real casing.
  await page.getByPlaceholder('Search nodes by name…').fill('Ada');
  await expect(page.getByRole('option', { name: /Ada Lovelace/ })).toBeVisible();
  await page.getByRole('option', { name: /Ada Lovelace/ }).click();
  // Selecting a hit closes the palette and selects the node (inspector shows it).
  await expect(palette).toBeHidden();
});
```

> If `Meta+k` is flaky on the CI Chromium, fall back to `Control+k`; both are handled by `onHostKey`. Do not weaken the import-count or palette assertions.

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `pnpm -F web e2e`
Expected: PASS — register→create→import (committed 2)→workspace→⌘K→find "Ada Lovelace"→select. If the built static path differs, fix `ATLAS_STATIC_DIR` in `playwright.config.ts` (the M6a note) and rerun.

- [ ] **Step 6: Update the README**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M6 complete — the Knowledge Graph Explorer (`apps/web`, Angular 20
standalone + signals + zoneless) is feature-complete. On top of the M6a–M6c
shell, themes, auth, database picker, graph canvas, AQL console, schema view, and
algorithms view, M6d adds: data import (paste/upload JSON `{nodes,edges}` and CSV,
atomic toggle, committed/idMap/first-error result); a ⌘K command palette that
searches nodes by name via AQL and selects + centers the chosen node on the
canvas; and Admin views for API token management (create-once / list / revoke)
and per-database role grants (grant/revoke viewer/editor/owner on databases you
own, owners surfaced from the db info). Login/register now route through
AuthService and the session rehydrates on a hard refresh. Deferred to M7
(production hardening): global user management and audit-log UI (no server
endpoints yet), inline AQL error squiggles, and editable db settings UI.
```

- [ ] **Step 7: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green — `tsc -b` builds the libraries (ignoring `apps/web`), the Angular builder builds the app, `typecheck:test` covers the new client test tsconfig, eslint + prettier cover `apps/web/src`, and `pnpm test` runs the library Vitest suite plus the app's `ng test` suite. The e2e is intentionally excluded (run separately via `pnpm e2e:web`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): wire import/admin routes + nav, M6d e2e, README M6-complete, full gate"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Spec coverage

| Spec ref | Requirement | Task(s) |
|---|---|---|
| §7.1 | Angular 20 standalone + signals + zoneless; server comms exclusively via `@atlas/client` | T1 (client surface complete), T2 (`provideAppInitializer`/`provideSessionRehydration`), T3 (`AtlasApi` re-exposes new methods — the app's only door) |
| §7.2 — Workspace ⌘K node search | top-bar ⌘K node search; selects/centers on canvas | T5 (pure `searchQuery` = `n.name/n.title CONTAINS $term` / `toHits`; `CommandPalette` overlay; `Workspace.onHostKey`/`onPick` → `GraphStore.select` + `addGraph` + `GraphCanvas.fit`) |
| §7.2 — Database picker / Workspace import files | import files into a database | T4 (Import page: JSON/CSV, atomic, result), T7 (picker per-db Import link; nav) |
| §7.2 — Admin | users, tokens, roles, audit log, db settings | T6 ships **tokens** (create-once/list/revoke) + **roles** (grant/revoke on owned dbs, owners surfaced); **users + audit log + db-settings UI deferred to M7** (no server endpoints) |
| §6.4 | Import format (JSON `{nodes,edges}` / CSV `nodes.csv`,`edges.csv`), atomic flag, result = committed + `tempId→id` map + first error w/ row index | T1 (`import`/`importCsv` client methods → `ImportResult`), T4 (`parseJsonImport` builder + result view rendering committed/idMap/`error.at.kind`#`index`) |
| §6.2 | only owners grant/revoke roles; editor/owner import; viewer read-only | T6 (`RolesStore.ownedDatabases` filters to `role==='owner'`; server enforces), T4/T7 (import gated to owner/editor in the picker; server returns 403 mapped to a friendly message) |
| §7.5 | keyboard nav, visible focus, ARIA labeling | T5 (`role="dialog"`/`aria-modal`, `role="listbox"`/`option`, `aria-activedescendant`, arrow/Enter/Escape, focus-on-open), T2 (theme-switcher single accessible name), T4/T6 (labelled inputs, `role="tab"`/`aria-selected`, `role="alert"`/`aria-live` results) |

## Plan self-review notes

- **Targets real surfaces only.** Every endpoint, method name, and response shape was read from source: tokens (`routes/tokens.ts` — `POST` 201 `{tokenId,name,token}`, `GET` `{tokenId,name}[]`, `DELETE :id` 204/404), roles (`routes/databases.ts` — `POST /api/db/:name/roles {username,role}` 204/404, `DELETE …/roles/:user` 204, `GET /api/db/:name` → `DbInfo{name,role,owners}`), import (`routes/io.ts` — JSON `ImportReq`, `?format=csv {nodesCsv,edgesCsv,atomic}`, both → `ImportResult`). The `@atlas/client` additions reuse the existing `request`/`buildHeaders`/`readError`/`CookieJar` helpers verified in `src/index.ts`. `RoleName`/`ImportReq`/`ImportResult` are already exported by `@atlas/protocol` (`wire.ts`) — no protocol edits.
- **No invented server endpoints.** Enumerated `routes/*.ts` = `auth`, `data`, `databases`, `io`, `metrics`, `query`, `tokens`, `ws`. There is **no** global user-list endpoint and **no** audit-log endpoint. Admin is therefore scoped to (a) the current user's own tokens and (b) role grant/revoke for databases the user OWNS, using only the existing routes. Global user management, audit-log UI, and editable db-settings UI are explicitly **deferred to M7** (each needs a new server endpoint or a `PATCH /api/db/:name` UI that is hardening, not feature).
- **⌘K search uses only verified AQL.** The engine's expression evaluator (`@atlas/query` `eval.ts`/`parser.ts`) exposes **only** `id()`/`labels()`/`type()` scalar functions — there is no `toLower`/`toString` — and `CONTAINS` (the `text` op) returns `false` unless both operands are strings, so it is **case-sensitive** and matches only string-valued props. `searchQuery` is therefore `MATCH (n) WHERE n.name CONTAINS $term OR n.title CONTAINS $term RETURN n LIMIT $limit` with `$term` bound verbatim (trimmed). The e2e searches with the real casing (`Ada`). Case-insensitive / multi-property search is an **M7** item (needs a `toLower`-style engine function or a dedicated search endpoint) — out of M6d scope.
- **Deliberate v1 deferrals (M7, production hardening only):** global user management + per-db/global audit-log UI (no endpoints); case-insensitive ⌘K search (needs an engine scalar function); inline AQL error squiggles in the console editor (noted in the M6c README as deferred — out of M6d scope, which is admin/import/search/polish); editable database-settings UI (the `PATCH /api/db/:name` endpoint exists but a settings form is hardening). The live-update `WsFrame` follow-up is **resolved** — `workspace.ts` `onFrame` already consumes the real `@atlas/protocol` `WsFrame` (`ready`/`batch`/`resync_required`/`error`); M6d adds no change there.
- **Cross-task name/type consistency.** Client method names are identical across T1 (`AtlasClient`), T3 (`AtlasApi`), and the consumers: `createToken`/`listTokens`/`revokeToken`, `grantRole(name,username,role)`/`revokeRole(name,username)`, `getDatabase`, `import(name,ImportReq)`/`importCsv(name,ImportCsvBody)`. Types flow from `@atlas/client` (`TokenSummary`, `CreatedToken`, `ImportCsvBody`, `DbSummary`) and `@atlas/protocol` (`RoleName`, `ImportReq`, `ImportResult`, `DbInfo`). The ⌘K pick path uses the real `GraphStore.select({kind:'node',id})` + `addGraph(parseGraphRows(...))` and `GraphCanvas.fit()` (all verified present) to center the node.
- **Route + key consistency.** New routes are children of `/databases` so they share the shell top bar: `/databases/import` (reads `?db=`) and `/databases/admin`, both under `authGuard`. The picker's per-db Import link uses `routerLink="/databases/import"` `[queryParams]="{ db: name }"`. The ⌘K shortcut is handled in `Workspace.onHostKey` for both `Meta+K` and `Ctrl+K`; the e2e presses `Meta+k` with a `Control+k` fallback note. Storage key `atlas.theme` and cookie name `atlas_session` are unchanged.
- **Test discipline.** Pure logic (`import-request`, `node-search`) and stores are unit-tested first; the `@atlas/client` additions are integration-tested against a real `buildServer` listener (mirrors `client-session.test.ts`, including a bearer round-trip proving a minted token authenticates). Components get smoke specs. Library tests run via `pnpm vitest run <path>`; app tests via `pnpm -F web exec ng test --watch=false`; the e2e via `pnpm -F web e2e` and is excluded from `pnpm test` (root `e2e:web` alias already exists). Every command matches the established setup; Prettier `{singleQuote:true,printWidth:100}`; Angular source uses bare specifiers, `@atlas/client` uses `.js` extensions.
- **Self-review fixes applied inline.** Replaced the awkward inline-object `(click)` on the ⌘K button in the workspace template with a dedicated `openPalette()` method (note added in T5 Step 4). The Import page disables submit when no `?db=` is present (`!name`) so it cannot post to an empty path. Role management filters to owned databases client-side AND relies on server `admin-db` enforcement (defense in depth). Token secret is held in a signal and cleared via `clearSecret()` so it is never persisted. The session-rehydration initializer swallows a failed `whoami` so an anonymous hard-load still boots cleanly to `/login`.
