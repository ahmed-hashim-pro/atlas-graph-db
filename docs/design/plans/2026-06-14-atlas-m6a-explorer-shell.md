# Atlas M6a — Knowledge Graph Explorer: App Shell, Auth, Database Picker, Theming

**Goal:** Stand up the Knowledge Graph Explorer's foundation: extend `@atlas/client` to a browser-friendly **session/cookie** mode with full auth + database-management coverage so the Angular app talks to the server exclusively through the SDK (spec §7.1); scaffold the Angular 20 app at `apps/web` into the monorepo gate (zoneless, signals, Vitest builder); ship the three first-class CSS-token themes with a persisted signal-based `ThemeService`; an `AtlasApi` Angular service wrapping the client; an `AuthService` + login/register components + route guard; an authenticated app shell with a top bar (theme switcher + user menu) and a database picker (list/create/seed/navigate); and a Playwright e2e smoke that drives register→login→create db→see it→switch theme. The `/db/:name` workspace is a placeholder this milestone.

**Architecture:** `@atlas/client` stays the single API surface. It gains a cookie mode (`mode: 'cookie'` → `credentials: 'include'` on every `fetch`, no `Authorization` header) alongside the existing bearer mode, plus auth methods (`register`/`login`/`logout`/`whoami`) and database methods (`listDatabases`/`createDatabase`/`seed`/`schema`) on `AtlasClient`, and `Database.schema()`. The Angular app (`apps/web`) is a standalone, zoneless, signal-based SPA: `AtlasApi` (DI service) wraps `connect(baseUrl, { mode: 'cookie' })` reading the base URL from Angular `environment` (default same-origin `''` so it hits the hosting `@atlas/server`); `AuthService` holds the current-user signal and calls `AtlasApi`; a functional route guard gates the shell; `ThemeService` applies a `data-theme` attribute on `<html>` and persists to `localStorage`; feature signal stores hold database-picker state. The app builds via the Angular builder (NOT `tsc -b`) and tests via the `@angular/build:unit-test` Vitest runner; the root gate runs both the library Vitest suite and the app suite.

**Tech Stack:** Existing stack (Node 24, pnpm 9.15.4, TypeScript, Vitest, ESLint, Prettier) + Angular 20.3 (standalone, signals, zoneless, Router), `@angular/build` Vitest unit-test runner with jsdom, Playwright for e2e. The client extension uses global `fetch` (cookie mode adds `credentials: 'include'`). CodeMirror AQL editor, the Canvas2D/d3-force graph renderer, the schema view, the algorithms view, the admin screens, and the `/db/:name` workspace itself are **M6b/M6c/M6d — out of scope here.**

**Spec:** `docs/design/specs/2026-06-10-atlas-graph-platform-design.md` §7.1 (Angular 20 standalone + signals + zoneless; server communication exclusively through `@atlas/client`), §7.2 (screens — M6a does Login/register and the Database picker; Workspace/Schema/Algorithms/Admin are later), §7.4 (three first-class themes as CSS custom-property token sets — Midnight Observatory default, Clean Laboratory, Neon Terminal — instant switching, persisted), §7.5 (keyboard nav, visible focus, ARIA labelling on the shell + auth forms).

**Existing code anchors:**
- `@atlas/client` (`packages/client/src/index.ts`): `connect(url, { token? }) → AtlasClient`; `AtlasClient.database(name) → Database`; `Database.query(aql, params) → Promise<QueryResponse>`, `Database.subscribe(filter, onFrame) → Promise<Subscription>`; `AtlasClientError { code, status, message, problem? }`. Uses global `fetch`/`WebSocket`. Currently bearer-token only — M6a extends it.
- `@atlas/protocol` (`packages/protocol/src/wire.ts`): `UserInfo { username, isAdmin }`; `DbInfo { name, description?, role: RoleName|null, owners: string[] }`; `QueryResponse { columns, rows, stats }`; `RoleName = 'owner'|'editor'|'viewer'`; `ProblemDetails`.
- `@atlas/server` routes (verified): `POST /api/auth/register` (201 → `UserInfo`, no cookie), `POST /api/auth/login` (200 → `UserInfo`, sets signed `atlas_session` cookie), `POST /api/auth/logout` (200 → `{ ok: true }`, clears cookie), `GET /api/auth/whoami` (200 → `UserInfo`); `GET /api/db` (→ `{ name, description, role }[]`), `POST /api/db` (201 → `{ name }`), `GET /api/db/:name` (→ `DbInfo`); `POST /api/db/:name/query` (→ `QueryResponse`), `GET /api/db/:name/schema` (→ `SchemaSummary`); `POST /api/db/:name/seed/:dataset` (`science-history` only → `{ committed: { nodes, edges } }`). The session cookie name is `atlas_session`. `buildServer(loadConfig(env)) → Promise<FastifyInstance>`; tests start a real listener with `app.listen({ port: 0, host: '127.0.0.1' })`.
- `SchemaSummary` (`packages/core/src/schema.ts`): `{ labels: { label, count, properties: { property, types }[] }[]; edgeTypes: { type, count, from, to }[] }`.

## File structure

```
packages/client/
  src/index.ts            MODIFY: add cookie mode + auth/db methods + Database.schema()
  test/client.test.ts     (existing — unchanged)
  test/client-session.test.ts  CREATE: cookie-mode auth + db methods against a real listener

apps/web/                 CREATE (Angular 20 scaffold)
  package.json            @atlas/web (deps: @angular/*, rxjs, tslib, @atlas/client, @atlas/protocol)
  angular.json            build = @angular/build:application; test = @angular/build:unit-test (vitest)
  tsconfig.json           SELF-CONTAINED (does NOT extend tsconfig.base.json)
  tsconfig.app.json       browser build
  tsconfig.spec.json      includes src/**/*.spec.ts + src/test-setup.ts; types: ["vitest/globals"]
  eslint.config.js        angular-eslint (ts + html)
  playwright.config.ts    CREATE (Task 7): e2e against built app served by @atlas/server
  src/main.ts             bootstrapApplication(App, appConfig)
  src/test-setup.ts       provideZonelessChangeDetection() providersFile
  src/styles.css          theme token sets (:root + [data-theme=...]) + base layout
  src/environments/environment.ts          { apiBaseUrl: '' }  (same-origin default)
  src/environments/environment.development.ts  { apiBaseUrl: 'http://127.0.0.1:4848' }
  src/app/app.ts / app.html / app.spec.ts   root component + smoke spec
  src/app/app.config.ts   providers: zoneless CD + router
  src/app/app.routes.ts   routes (login, register, picker, /db/:name placeholder)
  src/app/core/atlas-api.ts / atlas-api.spec.ts     AtlasApi service (wraps @atlas/client)
  src/app/core/theme.service.ts / theme.service.spec.ts   ThemeService (signals + localStorage)
  src/app/core/auth.service.ts / auth.service.spec.ts     AuthService (signals)
  src/app/core/auth.guard.ts / auth.guard.spec.ts         functional CanActivate guard
  src/app/auth/login.ts / login.html / login.spec.ts      login component
  src/app/auth/register.ts / register.html                register component
  src/app/shell/shell.ts / shell.html / shell.spec.ts     authenticated shell (top bar)
  src/app/shell/theme-switcher.ts / theme-switcher.html   theme switcher control
  src/app/picker/picker.store.ts / picker.store.spec.ts   database-picker signal store
  src/app/picker/picker.ts / picker.html / picker.spec.ts database-picker page
  src/app/workspace/workspace-placeholder.ts              placeholder for /db/:name (M6b)
  e2e/explorer.spec.ts    CREATE (Task 7): Playwright smoke

tsconfig.json             (root) — UNCHANGED: references must NOT include apps/web
package.json              (root) — MODIFY: build += app build; test += app test; test:web; e2e:web
.gitignore                MODIFY: add .angular/ and apps/web build artifacts
README.md                 MODIFY (Task 7): status → M6a
```

Conventions: ESM `.js` import extensions in the `@atlas/client` library code (Task 1). Angular code uses bare specifiers (no `.js` suffix) — the Angular builder resolves them. Commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NEVER run bare `vitest` — library tests run via `pnpm vitest run`, the app suite via `pnpm -F web exec ng test --watch=false`. Prettier config is `{ singleQuote: true, printWidth: 100 }`.

---

### Task 1: Extend `@atlas/client` with cookie mode + auth + database methods

The Angular app authenticates via httpOnly session cookies, not bearer tokens. Extend the client so every request can opt into `credentials: 'include'`, and add the auth/database surface the app needs — keeping `@atlas/client` the single API surface (spec §7.1). Backward compatible: the existing bearer-token path and the existing `client.test.ts` keep passing.

**Files:**
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/client-session.test.ts`

- [x] **Step 1: Write the failing test**

`packages/client/test/client-session.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-client-session-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('@atlas/client cookie mode', () => {
  it('register → login → whoami round trip with a cookie jar', async () => {
    const client = connect(url, { mode: 'cookie' });
    const reg = await client.register('ada', 'secret12');
    expect(reg).toEqual({ username: 'ada', isAdmin: false });
    const me = await client.login('ada', 'secret12');
    expect(me).toEqual({ username: 'ada', isAdmin: false });
    expect(await client.whoami()).toEqual({ username: 'ada', isAdmin: false });
  });

  it('whoami returns null when not authenticated (401 → null, not throw)', async () => {
    const client = connect(url, { mode: 'cookie' });
    expect(await client.whoami()).toBeNull();
  });

  it('logout ends the session', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('bob', 'secret12');
    await client.login('bob', 'secret12');
    expect(await client.whoami()).not.toBeNull();
    await client.logout();
    expect(await client.whoami()).toBeNull();
  });

  it('lists, creates, and seeds databases; the creator is owner', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    expect(await client.listDatabases()).toEqual([]);

    const created = await client.createDatabase('kb');
    expect(created).toEqual({ name: 'kb' });
    expect(await client.listDatabases()).toEqual([{ name: 'kb', description: '', role: 'owner' }]);

    const seeded = await client.seed('kb', 'science-history');
    expect(seeded.committed.nodes).toBeGreaterThan(0);
    expect(seeded.committed.edges).toBeGreaterThan(0);
  });

  it('queries and introspects schema through the cookie session', async () => {
    const client = connect(url, { mode: 'cookie' });
    await client.register('ada', 'secret12');
    await client.login('ada', 'secret12');
    await client.createDatabase('kb');
    const db = client.database('kb');
    await db.query("CREATE (p:Person {name: 'Ada'}) RETURN p", {});
    const res = await db.query('MATCH (p:Person) RETURN p.name AS name', {});
    expect(res.rows).toEqual([['Ada']]);
    const schema = await db.schema();
    expect(schema.labels.map((l) => l.label)).toContain('Person');
  });

  it('surfaces auth failures as AtlasClientError with status', async () => {
    const client = connect(url, { mode: 'cookie' });
    await expect(client.login('nobody', 'whatever1')).rejects.toMatchObject({ status: 401 });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm install && pnpm vitest run packages/client/test/client-session.test.ts`
Expected: FAIL — `connect` does not accept `mode`, and `register`/`login`/`whoami`/`logout`/`listDatabases`/`createDatabase`/`seed` / `Database.schema()` do not exist yet.

- [x] **Step 3: Implement — replace `packages/client/src/index.ts`**

```ts
import type {
  DbInfo,
  ProblemDetails,
  QueryResponse,
  SubscribeFilter,
  UserInfo,
  WsFrame,
} from '@atlas/protocol';
import type { SchemaSummary } from '@atlas/core';

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

/**
 * `bearer` (default) sends an `Authorization: Bearer <token>` header — for server-to-server
 * and CLI use. `cookie` sends `credentials: 'include'` on every request and never sets an
 * Authorization header — for the browser app, which authenticates via the httpOnly
 * `atlas_session` cookie set by `login()`.
 */
export interface ConnectOptions {
  token?: string;
  mode?: 'bearer' | 'cookie';
}

export interface Subscription {
  close(): void;
}

/** A db's summary as returned by `GET /api/db` (caller's role on each db). */
export interface DbSummary {
  name: string;
  description: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface SeedResult {
  committed: { nodes: number; edges: number };
}

function buildHeaders(opts: ConnectOptions, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (opts.mode !== 'cookie' && opts.token) headers.authorization = `Bearer ${opts.token}`;
  return headers;
}

function fetchInit(opts: ConnectOptions, init: RequestInit): RequestInit {
  return opts.mode === 'cookie' ? { ...init, credentials: 'include' } : init;
}

async function readError(res: Response): Promise<AtlasClientError> {
  const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
  return new AtlasClientError(
    problem?.code ?? 'ERROR',
    res.status,
    problem?.detail ?? res.statusText,
    problem,
  );
}

export class Database {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly opts: ConnectOptions,
  ) {}

  async query(aql: string, params: Record<string, unknown> = {}): Promise<QueryResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/db/${this.name}/query`,
      fetchInit(this.opts, {
        method: 'POST',
        headers: buildHeaders(this.opts, true),
        body: JSON.stringify({ query: aql, params }),
      }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as QueryResponse;
  }

  /** Introspected schema summary for this database (`GET /api/db/:name/schema`). */
  async schema(): Promise<SchemaSummary> {
    const res = await fetch(
      `${this.baseUrl}/api/db/${this.name}/schema`,
      fetchInit(this.opts, { method: 'GET', headers: buildHeaders(this.opts, false) }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as SchemaSummary;
  }

  /** Live change-feed subscription. Resolves once the socket is open. */
  subscribe(filter: SubscribeFilter, onFrame: (frame: WsFrame) => void): Promise<Subscription> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams();
    if (this.opts.mode !== 'cookie' && this.opts.token) qs.set('token', this.opts.token);
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

  // ---- auth ----
  async register(username: string, password: string): Promise<UserInfo> {
    const res = await fetch(
      `${this.baseUrl}/api/auth/register`,
      fetchInit(this.opts, {
        method: 'POST',
        headers: buildHeaders(this.opts, true),
        body: JSON.stringify({ username, password }),
      }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  async login(username: string, password: string): Promise<UserInfo> {
    const res = await fetch(
      `${this.baseUrl}/api/auth/login`,
      fetchInit(this.opts, {
        method: 'POST',
        headers: buildHeaders(this.opts, true),
        body: JSON.stringify({ username, password }),
      }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  async logout(): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/auth/logout`,
      fetchInit(this.opts, { method: 'POST', headers: buildHeaders(this.opts, false) }),
    );
    if (!res.ok) throw await readError(res);
  }

  /** Current user, or `null` when unauthenticated (401 → null, never throws on 401). */
  async whoami(): Promise<UserInfo | null> {
    const res = await fetch(
      `${this.baseUrl}/api/auth/whoami`,
      fetchInit(this.opts, { method: 'GET', headers: buildHeaders(this.opts, false) }),
    );
    if (res.status === 401) return null;
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  // ---- databases ----
  async listDatabases(): Promise<DbSummary[]> {
    const res = await fetch(
      `${this.baseUrl}/api/db`,
      fetchInit(this.opts, { method: 'GET', headers: buildHeaders(this.opts, false) }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as DbSummary[];
  }

  async createDatabase(name: string): Promise<{ name: string }> {
    const res = await fetch(
      `${this.baseUrl}/api/db`,
      fetchInit(this.opts, {
        method: 'POST',
        headers: buildHeaders(this.opts, true),
        body: JSON.stringify({ name }),
      }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as { name: string };
  }

  async getDatabase(name: string): Promise<DbInfo> {
    const res = await fetch(
      `${this.baseUrl}/api/db/${name}`,
      fetchInit(this.opts, { method: 'GET', headers: buildHeaders(this.opts, false) }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as DbInfo;
  }

  async seed(name: string, dataset: string): Promise<SeedResult> {
    const res = await fetch(
      `${this.baseUrl}/api/db/${name}/seed/${dataset}`,
      fetchInit(this.opts, { method: 'POST', headers: buildHeaders(this.opts, false) }),
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as SeedResult;
  }
}

export function connect(url: string, opts: ConnectOptions = {}): AtlasClient {
  return new AtlasClient(url.replace(/\/$/, ''), opts);
}
```

Add the `@atlas/core` reference so the `SchemaSummary` type import resolves. In `packages/client/package.json`, add `"@atlas/core": "workspace:*"` to `dependencies` (it is a type-only import, but the workspace link + tsconfig reference are required). In `packages/client/tsconfig.json`, extend `references` to `[{ "path": "../protocol" }, { "path": "../core" }]`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm install && pnpm vitest run packages/client/test/client-session.test.ts packages/client/test/client.test.ts && pnpm build`
Expected: PASS — both the new cookie-mode suite and the existing bearer-mode suite, and a clean build.

- [x] **Step 5: Run the full library gate**

Run: `pnpm typecheck:test && pnpm lint && pnpm format`
Expected: green (no new packages added to the gate yet; `apps/web` does not exist).

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): cookie/session mode plus auth and database methods"
```

The commit message body must end with a blank line then:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 2: Scaffold the Angular 20 app at `apps/web` and wire it into the gate

Use the empirically verified recipe exactly — do not re-derive flags. The app builds via the Angular builder (NOT `tsc -b`) and tests via the `@angular/build:unit-test` Vitest runner with jsdom. A passing smoke spec proves the toolchain works.

**Files:**
- Create (via scaffold): `apps/web/**`
- Modify: root `package.json`, root `.gitignore`
- Test: `apps/web/src/app/app.spec.ts`

- [x] **Step 1: Scaffold the app**

Run from the repo root:

```bash
pnpm dlx @angular/cli@20 new web --standalone --routing --style=css --ssr=false --zoneless --skip-git --package-manager=pnpm --defaults --directory apps/web
```

If `--directory apps/web` is rejected by this CLI version, generate into a temp name and move it:

```bash
pnpm dlx @angular/cli@20 new web --standalone --routing --style=css --ssr=false --zoneless --skip-git --package-manager=pnpm --defaults
mkdir -p apps && mv web apps/web
```

- [x] **Step 2: Swap Karma for Vitest + jsdom**

```bash
pnpm -F web remove jasmine-core @types/jasmine karma karma-chrome-launcher karma-coverage karma-jasmine karma-jasmine-html-reporter
pnpm -F web add -D vitest@^3 jsdom@^29
```

- [x] **Step 3: Pin `apps/web/package.json` to the verified shape**

Set `name` to `web` (so `pnpm -F web` targets it), `private: true`, `"scripts": { "ng": "ng", "start": "ng serve", "build": "ng build", "test": "ng test --watch=false" }`. Ensure `dependencies` include `@angular/common`, `@angular/compiler`, `@angular/core`, `@angular/forms`, `@angular/platform-browser`, `@angular/router` all at `^20.3.0`, `rxjs ~7.8.0`, `tslib ^2.3.0`, plus `@atlas/client": "workspace:*"` and `@atlas/protocol": "workspace:*"`. Ensure `devDependencies` include `@angular/build ^20.3.28`, `@angular/cli ^20.3.28`, `@angular/compiler-cli ^20.3.0`, `jsdom ^29`, `typescript ~5.9.2`, `vitest ^3`. Remove any `zone.js` dependency (zoneless). Then:

```bash
pnpm -F web add @atlas/client@workspace:* @atlas/protocol@workspace:*
pnpm install
```

- [x] **Step 4: Configure the Vitest test target in `apps/web/angular.json`**

The `projects.web.architect` (or `targets`) block must contain a `test` target:

```json
{
  "test": {
    "builder": "@angular/build:unit-test",
    "options": {
      "buildTarget": "web:build",
      "tsConfig": "tsconfig.spec.json",
      "runner": "vitest",
      "providersFile": "src/test-setup.ts"
    }
  }
}
```

Confirm the `build` target is `@angular/build:application` with `browser: "src/main.ts"`, `tsConfig: "tsconfig.app.json"`, and `styles: ["src/styles.css"]`.

- [x] **Step 5: Write the zoneless test-setup providers file**

`apps/web/src/test-setup.ts`:

```ts
import { provideZonelessChangeDetection } from '@angular/core';

export default [provideZonelessChangeDetection()];
```

`apps/web/tsconfig.spec.json` must include the setup file and the vitest globals types:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./out-tsc/spec",
    "types": ["vitest/globals", "node"]
  },
  "include": ["src/**/*.spec.ts", "src/**/*.d.ts", "src/test-setup.ts"]
}
```

`apps/web/tsconfig.json` is SELF-CONTAINED (does NOT extend `../../tsconfig.base.json`); leave the Angular-generated compiler options as-is (it sets `strict`, `moduleResolution: "bundler"`, etc.).

- [x] **Step 6: Confirm `tsc -b` ignores the app**

Open the root `tsconfig.json` and verify its `references` array does NOT contain `apps/web` (it lists only `packages/*`). Do not add it — the app builds via the Angular builder, never `tsc -b`.

- [x] **Step 7: Write the smoke spec and a minimal root component**

`apps/web/src/app/app.ts` (replace the generated component):

```ts
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {}
```

`apps/web/src/app/app.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('App', () => {
  it('creates the root component', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
  });
});
```

Ensure `apps/web/src/app/app.config.ts` provides zoneless change detection and the router:

```ts
import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideZonelessChangeDetection(), provideRouter(routes)],
};
```

`apps/web/src/main.ts`:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
```

`apps/web/src/app/app.routes.ts` (placeholder; Task 5–6 populate it):

```ts
import { Routes } from '@angular/router';

export const routes: Routes = [];
```

- [x] **Step 8: Run the smoke spec**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — one test, the Vitest builder runs headless under jsdom and exits.

- [x] **Step 9: Add angular-eslint and gitignore the cache**

```bash
pnpm -F web exec ng add angular-eslint --skip-confirmation
```

This creates `apps/web/eslint.config.js` covering `.ts` and `.html`. If `ng add` proves flaky, fall back to a hand-written `apps/web/eslint.config.js` that lints only the app's `.ts` files with the existing `typescript-eslint` recommended config and excludes `.html`. Append to the root `.gitignore`:

```
.angular/
apps/web/.angular/
apps/web/dist/
apps/web/out-tsc/
```

- [x] **Step 10: Wire the root gate**

In the root `package.json`, change:
- `"build": "tsc -b"` → `"build": "tsc -b && pnpm -F web build"`
- `"test": "vitest run"` → `"test": "vitest run && pnpm -F web exec ng test --watch=false"`
- add `"test:web": "pnpm -F web exec ng test --watch=false"`

Confirm `lint` (`eslint .`) and `format` (`prettier --check .`) reach `apps/web/src`. The root `eslint.config.js` already runs from the repo root; the app's own flat config nests under `apps/web`. Prettier's `.prettierignore` already excludes `dist`/`docs` — add `apps/web/.angular`, `apps/web/dist`, `apps/web/out-tsc` if not already covered by the `dist` glob.

- [x] **Step 11: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: green — `tsc -b` ignores `apps/web`, the app builds via the Angular builder, the library Vitest suite passes, and the app smoke spec passes.

- [x] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold Angular 20 zoneless app wired into the monorepo gate"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 3: Theme system — three CSS-token themes + signal-based `ThemeService`

Ship the three first-class themes (spec §7.4) as CSS custom-property token sets and a `ThemeService` that applies a `data-theme` attribute on `<html>`, exposes the active theme as a signal, and persists/restores the choice via `localStorage`.

**Files:**
- Create: `apps/web/src/app/core/theme.service.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/app/core/theme.service.spec.ts`

- [x] **Step 1: Write the failing test**

`apps/web/src/app/core/theme.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeService, THEMES, type ThemeId } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  function make(): ThemeService {
    return TestBed.runInInjectionContext(() => new ThemeService());
  }

  it('defaults to Midnight Observatory and applies data-theme on <html>', () => {
    const svc = make();
    expect(svc.current()).toBe<ThemeId>('midnight-observatory');
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight-observatory');
  });

  it('switches theme, updates the signal, and writes the attribute', () => {
    const svc = make();
    svc.set('neon-terminal');
    expect(svc.current()).toBe<ThemeId>('neon-terminal');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon-terminal');
  });

  it('persists the choice to localStorage and restores it on a new instance', () => {
    const a = make();
    a.set('clean-laboratory');
    expect(localStorage.getItem('atlas.theme')).toBe('clean-laboratory');
    const b = make();
    expect(b.current()).toBe<ThemeId>('clean-laboratory');
    expect(document.documentElement.getAttribute('data-theme')).toBe('clean-laboratory');
  });

  it('ignores an invalid persisted value and falls back to the default', () => {
    localStorage.setItem('atlas.theme', 'bogus');
    const svc = make();
    expect(svc.current()).toBe<ThemeId>('midnight-observatory');
  });

  it('exposes the three theme descriptors for a switcher UI', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'midnight-observatory',
      'clean-laboratory',
      'neon-terminal',
    ]);
    expect(THEMES.every((t) => t.label.length > 0)).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./theme.service` not found.

- [x] **Step 3: Implement `apps/web/src/app/core/theme.service.ts`**

```ts
import { Injectable, signal } from '@angular/core';

export type ThemeId = 'midnight-observatory' | 'clean-laboratory' | 'neon-terminal';

export interface ThemeDescriptor {
  id: ThemeId;
  label: string;
  description: string;
}

export const THEMES: readonly ThemeDescriptor[] = [
  {
    id: 'midnight-observatory',
    label: 'Midnight Observatory',
    description: 'Dark, glowing nodes, violet and cyan accents.',
  },
  {
    id: 'clean-laboratory',
    label: 'Clean Laboratory',
    description: 'Light, crisp, white panels with indigo accents.',
  },
  {
    id: 'neon-terminal',
    label: 'Neon Terminal',
    description: 'Monospace, neon green on near-black.',
  },
] as const;

export const DEFAULT_THEME: ThemeId = 'midnight-observatory';
const STORAGE_KEY = 'atlas.theme';

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && THEMES.some((t) => t.id === value);
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _current = signal<ThemeId>(this.restore());
  /** The active theme id (signal). */
  readonly current = this._current.asReadonly();
  readonly themes = THEMES;

  constructor() {
    this.apply(this._current());
  }

  set(id: ThemeId): void {
    this._current.set(id);
    this.apply(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage may be unavailable (private mode); theme still applies in-memory.
    }
  }

  private restore(): ThemeId {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isThemeId(stored)) return stored;
    } catch {
      // ignore — fall back to the default
    }
    return DEFAULT_THEME;
  }

  private apply(id: ThemeId): void {
    document.documentElement.setAttribute('data-theme', id);
  }
}
```

- [x] **Step 4: Define the token sets in `apps/web/src/styles.css`**

Replace the file with the three token sets plus base layout. Tokens: `--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-2`, and a six-entry node-label palette `--node-1`..`--node-6`.

```css
/* Midnight Observatory — default (also bound to :root so it applies before JS) */
:root,
[data-theme='midnight-observatory'] {
  --bg: #0b0f1d;
  --surface: #141a2e;
  --border: #2a3350;
  --text: #e6ebff;
  --text-muted: #9aa6c8;
  --accent: #6366f1;
  --accent-2: #22d3ee;
  --node-1: #6366f1;
  --node-2: #22d3ee;
  --node-3: #a855f7;
  --node-4: #f472b6;
  --node-5: #34d399;
  --node-6: #fbbf24;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color-scheme: dark;
}

[data-theme='clean-laboratory'] {
  --bg: #f7f8fb;
  --surface: #ffffff;
  --border: #d9dde7;
  --text: #1a2233;
  --text-muted: #5b6577;
  --accent: #4f46e5;
  --accent-2: #0ea5e9;
  --node-1: #4f46e5;
  --node-2: #0ea5e9;
  --node-3: #9333ea;
  --node-4: #db2777;
  --node-5: #059669;
  --node-6: #d97706;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color-scheme: light;
}

[data-theme='neon-terminal'] {
  --bg: #050806;
  --surface: #0c120d;
  --border: #1f3a24;
  --text: #d6ffe0;
  --text-muted: #6fae7e;
  --accent: #22c55e;
  --accent-2: #4ade80;
  --node-1: #22c55e;
  --node-2: #4ade80;
  --node-3: #16a34a;
  --node-4: #84cc16;
  --node-5: #10b981;
  --node-6: #a3e635;
  --font: 'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', Menlo, monospace;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.5;
}

a {
  color: var(--accent);
}

button {
  font-family: inherit;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — default, switch, persist/restore, invalid-fallback, and descriptor list.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): three CSS-token themes and a persisted ThemeService"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 4: `AtlasApi` Angular service wrapping `@atlas/client`

A single DI service is the app's only door to the server. It constructs a cookie-mode client from the Angular `environment` base URL and re-exposes the methods the app needs.

**Files:**
- Create: `apps/web/src/app/core/atlas-api.ts`, `apps/web/src/environments/environment.ts`, `apps/web/src/environments/environment.development.ts`
- Test: `apps/web/src/app/core/atlas-api.spec.ts`

- [x] **Step 1: Write the failing test**

`apps/web/src/app/core/atlas-api.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AtlasApi } from './atlas-api';

describe('AtlasApi', () => {
  it('is injectable and exposes the auth + database methods', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    expect(typeof api.register).toBe('function');
    expect(typeof api.login).toBe('function');
    expect(typeof api.logout).toBe('function');
    expect(typeof api.whoami).toBe('function');
    expect(typeof api.listDatabases).toBe('function');
    expect(typeof api.createDatabase).toBe('function');
    expect(typeof api.seed).toBe('function');
    expect(typeof api.database).toBe('function');
  });

  it('delegates a database handle through the client', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    const db = api.database('kb');
    expect(typeof db.query).toBe('function');
    expect(typeof db.schema).toBe('function');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `./atlas-api` not found.

- [x] **Step 3: Implement the environment files and the service**

`apps/web/src/environments/environment.ts`:

```ts
export const environment = {
  production: true,
  /** Empty = same-origin: the app talks to the @atlas/server that hosts it. */
  apiBaseUrl: '',
};
```

`apps/web/src/environments/environment.development.ts`:

```ts
export const environment = {
  production: false,
  /** Dev: ng serve on :4200 talks to a separately-run @atlas/server on :4848. */
  apiBaseUrl: 'http://127.0.0.1:4848',
};
```

`apps/web/src/app/core/atlas-api.ts`:

```ts
import { Injectable } from '@angular/core';
import { connect, type AtlasClient, type Database, type DbSummary, type SeedResult } from '@atlas/client';
import type { UserInfo } from '@atlas/protocol';
import { environment } from '../../environments/environment';

/**
 * The app's single API surface. Wraps a cookie-mode `@atlas/client` so every request
 * carries the httpOnly `atlas_session` cookie (`credentials: 'include'`).
 */
@Injectable({ providedIn: 'root' })
export class AtlasApi {
  private readonly client: AtlasClient = connect(environment.apiBaseUrl, { mode: 'cookie' });

  register(username: string, password: string): Promise<UserInfo> {
    return this.client.register(username, password);
  }
  login(username: string, password: string): Promise<UserInfo> {
    return this.client.login(username, password);
  }
  logout(): Promise<void> {
    return this.client.logout();
  }
  whoami(): Promise<UserInfo | null> {
    return this.client.whoami();
  }
  listDatabases(): Promise<DbSummary[]> {
    return this.client.listDatabases();
  }
  createDatabase(name: string): Promise<{ name: string }> {
    return this.client.createDatabase(name);
  }
  seed(name: string, dataset: string): Promise<SeedResult> {
    return this.client.seed(name, dataset);
  }
  database(name: string): Database {
    return this.client.database(name);
  }
}
```

If `connect(environment.apiBaseUrl, …)` with an empty string trips the client's trailing-slash strip harmlessly (it does: `''.replace(/\/$/, '') === ''`), no change is needed — same-origin relative URLs like `/api/...` resolve against the page origin.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): AtlasApi service wrapping the cookie-mode @atlas/client"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 5: `AuthService`, login + register components, and the route guard

Signals hold the current user; the service calls `AtlasApi`; a functional `CanActivate` guard redirects anonymous callers to `/login`. Login/register components drive the flow.

**Files:**
- Create: `apps/web/src/app/core/auth.service.ts`, `apps/web/src/app/core/auth.guard.ts`, `apps/web/src/app/auth/login.ts`, `apps/web/src/app/auth/login.html`, `apps/web/src/app/auth/register.ts`, `apps/web/src/app/auth/register.html`
- Modify: `apps/web/src/app/app.routes.ts`
- Test: `apps/web/src/app/core/auth.service.spec.ts`, `apps/web/src/app/core/auth.guard.spec.ts`, `apps/web/src/app/auth/login.spec.ts`

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/core/auth.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './atlas-api';
import { AuthService } from './auth.service';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

function withApi(api: Partial<AtlasApi>): AuthService {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(AuthService);
}

describe('AuthService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts unauthenticated', () => {
    const svc = withApi({ whoami: vi.fn().mockResolvedValue(null) });
    expect(svc.user()).toBeNull();
    expect(svc.isAuthenticated()).toBe(false);
  });

  it('login sets the user signal', async () => {
    const svc = withApi({ login: vi.fn().mockResolvedValue(ada) });
    await svc.login('ada', 'secret12');
    expect(svc.user()).toEqual(ada);
    expect(svc.isAuthenticated()).toBe(true);
  });

  it('register then login', async () => {
    const register = vi.fn().mockResolvedValue(ada);
    const login = vi.fn().mockResolvedValue(ada);
    const svc = withApi({ register, login });
    await svc.register('ada', 'secret12');
    expect(register).toHaveBeenCalledWith('ada', 'secret12');
    await svc.login('ada', 'secret12');
    expect(svc.user()).toEqual(ada);
  });

  it('logout clears the user signal', async () => {
    const svc = withApi({ login: vi.fn().mockResolvedValue(ada), logout: vi.fn().mockResolvedValue(undefined) });
    await svc.login('ada', 'secret12');
    await svc.logout();
    expect(svc.user()).toBeNull();
  });

  it('refresh() rehydrates the user from whoami (session restore)', async () => {
    const svc = withApi({ whoami: vi.fn().mockResolvedValue(ada) });
    await svc.refresh();
    expect(svc.user()).toEqual(ada);
  });
});
```

`apps/web/src/app/core/auth.guard.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './atlas-api';
import { authGuard } from './auth.guard';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

function run(api: Partial<AtlasApi>): Promise<boolean | ReturnType<Router['parseUrl']>> {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.runInInjectionContext(() => authGuard());
}

describe('authGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('allows an authenticated caller', async () => {
    const result = await run({ whoami: vi.fn().mockResolvedValue(ada) });
    expect(result).toBe(true);
  });

  it('redirects an anonymous caller to /login', async () => {
    const result = await run({ whoami: vi.fn().mockResolvedValue(null) });
    expect(String(result)).toBe('/login');
  });
});
```

`apps/web/src/app/auth/login.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Login } from './login';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Login component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('submits credentials and navigates to the picker on success', async () => {
    const login = vi.fn().mockResolvedValue(ada);
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } }],
    }).compileComponents();
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Login);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('secret12');
    await cmp.submit();
    expect(login).toHaveBeenCalledWith('ada', 'secret12');
    expect(navSpy).toHaveBeenCalledWith('/databases');
  });

  it('shows an error message when login fails', async () => {
    const login = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } }],
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

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — `auth.service`, `auth.guard`, and `login` not found.

- [x] **Step 3: Implement the service, guard, and components**

`apps/web/src/app/core/auth.service.ts`:

```ts
import { computed, inject, Injectable, signal } from '@angular/core';
import type { UserInfo } from '@atlas/protocol';
import { AtlasApi } from './atlas-api';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(AtlasApi);
  private readonly _user = signal<UserInfo | null>(null);
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  async login(username: string, password: string): Promise<UserInfo> {
    const user = await this.api.login(username, password);
    this._user.set(user);
    return user;
  }

  async register(username: string, password: string): Promise<UserInfo> {
    return this.api.register(username, password);
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this._user.set(null);
  }

  /** Rehydrate from the session cookie (e.g. on app start or guard activation). */
  async refresh(): Promise<UserInfo | null> {
    const user = await this.api.whoami();
    this._user.set(user);
    return user;
  }
}
```

`apps/web/src/app/core/auth.guard.ts`:

```ts
import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

/** Allows the route when a session exists; otherwise redirects to /login. */
export const authGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  const user = await auth.refresh();
  return user !== null ? true : router.parseUrl('/login');
};
```

`apps/web/src/app/auth/login.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
})
export class Login {
  private readonly api = inject(AtlasApi);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(status === 401 ? 'Invalid username or password.' : 'Login failed. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
```

`apps/web/src/app/auth/login.html`:

```html
<main class="auth-card">
  <h1>Sign in to Atlas</h1>
  <form (ngSubmit)="submit()">
    <label for="login-username">Username</label>
    <input
      id="login-username"
      name="username"
      [ngModel]="username()"
      (ngModelChange)="username.set($event)"
      autocomplete="username"
      required
    />
    <label for="login-password">Password</label>
    <input
      id="login-password"
      name="password"
      type="password"
      [ngModel]="password()"
      (ngModelChange)="password.set($event)"
      autocomplete="current-password"
      required
    />
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <button type="submit" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
  </form>
  <p>No account? <a routerLink="/register">Create one</a>.</p>
</main>
```

`apps/web/src/app/auth/register.ts`:

```ts
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.html',
})
export class Register {
  private readonly api = inject(AtlasApi);
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
      await this.api.register(this.username(), this.password());
      await this.api.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(status === 409 ? 'That username is taken.' : 'Registration failed. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
```

`apps/web/src/app/auth/register.html`:

```html
<main class="auth-card">
  <h1>Create your Atlas account</h1>
  <form (ngSubmit)="submit()">
    <label for="reg-username">Username</label>
    <input
      id="reg-username"
      name="username"
      [ngModel]="username()"
      (ngModelChange)="username.set($event)"
      autocomplete="username"
      required
    />
    <label for="reg-password">Password</label>
    <input
      id="reg-password"
      name="password"
      type="password"
      [ngModel]="password()"
      (ngModelChange)="password.set($event)"
      autocomplete="new-password"
      required
    />
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <button type="submit" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create account' }}</button>
  </form>
  <p>Already have an account? <a routerLink="/login">Sign in</a>.</p>
</main>
```

- [x] **Step 4: Wire the routes in `apps/web/src/app/app.routes.ts`**

```ts
import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'databases' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: 'register', loadComponent: () => import('./auth/register').then((m) => m.Register) },
  {
    path: 'databases',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', loadComponent: () => import('./picker/picker').then((m) => m.Picker) },
    ],
  },
  {
    path: 'db/:name',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./workspace/workspace-placeholder').then((m) => m.WorkspacePlaceholder),
  },
  { path: '**', redirectTo: 'databases' },
];
```

The `shell`, `picker`, and `workspace-placeholder` components are created in Task 6; this route file references them by their lazy import paths so it compiles only once Task 6 lands. To keep Task 5 independently green, temporarily comment out the `databases` and `db/:name` routes' `loadComponent` bodies OR create empty placeholder components now and flesh them out in Task 6. Preferred: create the three stub files in Task 6's Step 0 (below) — for Task 5, restrict `routes` to `''`/`login`/`register`/`**` and add the `databases`/`db/:name` entries in Task 6.

For Task 5, use this minimal `routes`:

```ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: 'register', loadComponent: () => import('./auth/register').then((m) => m.Register) },
  { path: '**', redirectTo: 'login' },
];
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — service signal transitions, guard allow/redirect, and login submit/navigate/error.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): AuthService, login/register components, and route guard"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 6: App shell + database picker (store, page, top bar, theme switcher)

The authenticated shell renders a top bar (app name, theme switcher, user menu/logout) and routes the picker page underneath. The picker lists databases with their role, creates a database, seeds `science-history`, and navigates to the placeholder `/db/:name` workspace. State lives in a signal store with unit-tested logic.

**Files:**
- Create: `apps/web/src/app/picker/picker.store.ts`, `apps/web/src/app/picker/picker.ts`, `apps/web/src/app/picker/picker.html`, `apps/web/src/app/shell/shell.ts`, `apps/web/src/app/shell/shell.html`, `apps/web/src/app/shell/theme-switcher.ts`, `apps/web/src/app/shell/theme-switcher.html`, `apps/web/src/app/workspace/workspace-placeholder.ts`
- Modify: `apps/web/src/app/app.routes.ts`
- Test: `apps/web/src/app/picker/picker.store.spec.ts`, `apps/web/src/app/picker/picker.spec.ts`, `apps/web/src/app/shell/shell.spec.ts`

- [x] **Step 0: Create the placeholder workspace component**

`apps/web/src/app/workspace/workspace-placeholder.ts`:

```ts
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-workspace-placeholder',
  imports: [RouterLink],
  template: `
    <main class="placeholder">
      <h1>Workspace: {{ name }}</h1>
      <p>The graph workspace (canvas, AQL console, schema, algorithms) arrives in M6b–M6c.</p>
      <a routerLink="/databases">Back to databases</a>
    </main>
  `,
})
export class WorkspacePlaceholder {
  readonly name = inject(ActivatedRoute).snapshot.paramMap.get('name') ?? '';
}
```

- [x] **Step 1: Write the failing tests**

`apps/web/src/app/picker/picker.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { PickerStore } from './picker.store';
import type { DbSummary } from '@atlas/client';

const dbs: DbSummary[] = [
  { name: 'kb', description: '', role: 'owner' },
  { name: 'shared', description: 'team', role: 'editor' },
];

function withApi(api: Partial<AtlasApi>): PickerStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(PickerStore);
}

describe('PickerStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the databases signal and clears loading', async () => {
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue(dbs) });
    expect(store.loading()).toBe(false);
    const p = store.load();
    expect(store.loading()).toBe(true);
    await p;
    expect(store.databases()).toEqual(dbs);
    expect(store.loading()).toBe(false);
  });

  it('create() adds the new database then reloads the list', async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'new', description: '', role: 'owner' }]);
    const createDatabase = vi.fn().mockResolvedValue({ name: 'new' });
    const store = withApi({ listDatabases, createDatabase });
    await store.load();
    await store.create('new');
    expect(createDatabase).toHaveBeenCalledWith('new');
    expect(store.databases().map((d) => d.name)).toContain('new');
  });

  it('create() surfaces a 409 as a friendly error and does not throw', async () => {
    const createDatabase = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { status: 409 }));
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue([]), createDatabase });
    await store.create('kb');
    expect(store.error()).toContain('already exists');
  });

  it('seed() calls the API for science-history', async () => {
    const seed = vi.fn().mockResolvedValue({ committed: { nodes: 10, edges: 12 } });
    const store = withApi({ listDatabases: vi.fn().mockResolvedValue([]), seed });
    await store.seed('kb');
    expect(seed).toHaveBeenCalledWith('kb', 'science-history');
  });
});
```

`apps/web/src/app/picker/picker.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Picker } from './picker';
import type { DbSummary } from '@atlas/client';

const dbs: DbSummary[] = [{ name: 'kb', description: '', role: 'owner' }];

describe('Picker component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the databases returned by the API with their role', async () => {
    await TestBed.configureTestingModule({
      imports: [Picker],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { listDatabases: vi.fn().mockResolvedValue(dbs) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Picker);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('kb');
    expect(text).toContain('owner');
  });
});
```

`apps/web/src/app/shell/shell.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuthService } from '../core/auth.service';
import { Shell } from './shell';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Shell component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the username and logs out', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { whoami: vi.fn().mockResolvedValue(ada), logout } },
      ],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    await auth.refresh();
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ada');

    await fixture.componentInstance.logout();
    expect(logout).toHaveBeenCalled();
    expect(navSpy).toHaveBeenCalledWith('/login');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F web exec ng test --watch=false`
Expected: FAIL — picker store/component and shell not found.

- [x] **Step 3: Implement the store, picker, shell, and theme switcher**

`apps/web/src/app/picker/picker.store.ts`:

```ts
import { inject, Injectable, signal } from '@angular/core';
import type { DbSummary } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class PickerStore {
  private readonly api = inject(AtlasApi);
  private readonly _databases = signal<DbSummary[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal('');

  readonly databases = this._databases.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._loading.set(true);
    this._error.set('');
    try {
      this._databases.set(await this.api.listDatabases());
    } catch {
      this._error.set('Could not load databases.');
    } finally {
      this._loading.set(false);
    }
  }

  async create(name: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.createDatabase(name);
      await this.load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 409
          ? `A database named "${name}" already exists.`
          : status === 400
            ? 'Invalid database name (letters, digits, - and _ only).'
            : 'Could not create the database.',
      );
    }
  }

  async seed(name: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.seed(name, 'science-history');
    } catch {
      this._error.set('Could not seed the database.');
    }
  }
}
```

`apps/web/src/app/picker/picker.ts`:

```ts
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { PickerStore } from './picker.store';

@Component({
  selector: 'app-picker',
  imports: [FormsModule],
  templateUrl: './picker.html',
})
export class Picker implements OnInit {
  readonly store = inject(PickerStore);
  private readonly router = inject(Router);
  readonly newName = signal('');
  readonly creating = signal(false);

  ngOnInit(): void {
    void this.store.load();
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    await this.store.create(name);
    this.creating.set(false);
    if (!this.store.error()) this.newName.set('');
  }

  async seed(name: string): Promise<void> {
    await this.store.seed(name);
  }

  open(name: string): void {
    void this.router.navigateByUrl(`/db/${name}`);
  }
}
```

`apps/web/src/app/picker/picker.html`:

```html
<section class="picker">
  <header class="picker-head">
    <h1>Databases</h1>
    <form class="create" (ngSubmit)="create()">
      <label class="sr-only" for="new-db">New database name</label>
      <input
        id="new-db"
        name="new-db"
        placeholder="new-database"
        [ngModel]="newName()"
        (ngModelChange)="newName.set($event)"
      />
      <button type="submit" [disabled]="creating() || !newName().trim()">Create</button>
    </form>
  </header>

  @if (store.error()) {
    <p class="error" role="alert">{{ store.error() }}</p>
  }

  @if (store.loading()) {
    <p>Loading…</p>
  } @else if (store.databases().length === 0) {
    <p class="empty">No databases yet. Create one above to get started.</p>
  } @else {
    <ul class="db-list">
      @for (db of store.databases(); track db.name) {
        <li class="db-card">
          <div class="db-meta">
            <button class="db-name" type="button" (click)="open(db.name)">{{ db.name }}</button>
            <span class="role role-{{ db.role }}">{{ db.role }}</span>
          </div>
          @if (db.description) {
            <p class="db-desc">{{ db.description }}</p>
          }
          <div class="db-actions">
            <button type="button" (click)="open(db.name)">Open</button>
            @if (db.role === 'owner' || db.role === 'editor') {
              <button type="button" (click)="seed(db.name)">Seed science-history</button>
            }
          </div>
        </li>
      }
    </ul>
  }
</section>
```

`apps/web/src/app/shell/theme-switcher.ts`:

```ts
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThemeService, type ThemeId } from '../core/theme.service';

@Component({
  selector: 'app-theme-switcher',
  imports: [FormsModule],
  templateUrl: './theme-switcher.html',
})
export class ThemeSwitcher {
  readonly theme = inject(ThemeService);

  change(id: string): void {
    this.theme.set(id as ThemeId);
  }
}
```

`apps/web/src/app/shell/theme-switcher.html`:

```html
<label class="sr-only" for="theme-select">Theme</label>
<select
  id="theme-select"
  aria-label="Theme"
  [ngModel]="theme.current()"
  (ngModelChange)="change($event)"
>
  @for (t of theme.themes; track t.id) {
    <option [value]="t.id">{{ t.label }}</option>
  }
</select>
```

`apps/web/src/app/shell/shell.ts`:

```ts
import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ThemeSwitcher } from './theme-switcher';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, ThemeSwitcher],
  templateUrl: './shell.html',
})
export class Shell {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
```

`apps/web/src/app/shell/shell.html`:

```html
<div class="shell">
  <header class="topbar">
    <div class="brand">Atlas</div>
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

- [x] **Step 4: Restore the full route table in `apps/web/src/app/app.routes.ts`**

Replace the Task 5 minimal routes with the full table (the one shown in Task 5 Step 4's first listing), now that `shell`, `picker`, and `workspace-placeholder` exist:

```ts
import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'databases' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: 'register', loadComponent: () => import('./auth/register').then((m) => m.Register) },
  {
    path: 'databases',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [{ path: '', loadComponent: () => import('./picker/picker').then((m) => m.Picker) }],
  },
  {
    path: 'db/:name',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./workspace/workspace-placeholder').then((m) => m.WorkspacePlaceholder),
  },
  { path: '**', redirectTo: 'databases' },
];
```

- [x] **Step 5: Add shell + form styling to `apps/web/src/styles.css`**

Append layout styles using the theme tokens (top bar, auth card, picker grid, role badges, `.sr-only` for screen-reader-only labels):

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.brand {
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--accent);
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.user-menu {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.shell-body,
.picker,
.auth-card,
.placeholder {
  padding: 1.5rem;
}

.auth-card {
  max-width: 24rem;
  margin: 4rem auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.auth-card form,
.create {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

input,
select,
button {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}

button {
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  border-color: transparent;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.create {
  flex-direction: row;
}

.db-list {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
}

.db-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem;
}

.db-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.db-name {
  background: none;
  color: var(--text);
  border: none;
  font-size: 1.1rem;
  font-weight: 600;
  padding: 0;
}

.role {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}

.db-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.error {
  color: #f87171;
}

.empty,
.db-desc {
  color: var(--text-muted);
}
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F web exec ng test --watch=false`
Expected: PASS — store load/create/seed/error, picker renders rows + role, shell shows username + logs out.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): app shell, theme switcher, and database picker with signal store"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 7: Playwright e2e smoke, exports, README, and the full gate

Add a Playwright e2e that drives the real flow (register→login→create db→see it→switch theme) against the built app served by `@atlas/server`'s static hosting, wired so it is runnable but NOT part of the default `pnpm test`. Then update the README and run the full gate green.

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/explorer.spec.ts`
- Modify: root `package.json`, `README.md`, `apps/web/package.json`, `.gitignore`
- Test: `apps/web/e2e/explorer.spec.ts`

- [x] **Step 1: Add Playwright**

```bash
pnpm -F web add -D @playwright/test
pnpm -F web exec playwright install chromium
```

- [x] **Step 2: Write the e2e config**

The e2e serves the production-built SPA from `@atlas/server` static hosting so cookies are same-origin (the most robust option — no CORS, real `credentials: 'include'`). The `webServer` block builds the app, then starts the server pointed at the built `dist` via `ATLAS_STATIC_DIR`, on a fixed port with a temp data dir.

`apps/web/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4899;
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'] },
  webServer: {
    // Build the SPA, then serve it from @atlas/server static hosting (same origin → real cookies).
    command: `pnpm -F web build && node --import tsx ../../packages/server/src/start.ts`,
    url: `http://127.0.0.1:${port}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    cwd: __dirname,
    env: {
      ATLAS_DATA_DIR: dataDir,
      ATLAS_SECRET: 'e'.repeat(32),
      ATLAS_PORT: String(port),
      ATLAS_STATIC_DIR: join(__dirname, 'dist/web/browser'),
    },
  },
});
```

Verify the built browser output path: Angular 20's `@angular/build:application` emits to `dist/<project>/browser`. Confirm with `ls apps/web/dist/web/browser/index.html` after a build; if the path differs, set `ATLAS_STATIC_DIR` and the `outputPath` in `angular.json` to match. Confirm `@atlas/server` reads `ATLAS_STATIC_DIR` into `config.staticDir` (the server's `loadConfig` + `app.ts` static branch already support a static dir; if the env var name differs, align `playwright.config.ts` to the actual name used by `loadConfig`).

- [x] **Step 3: Write the e2e smoke**

`apps/web/e2e/explorer.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('register, login, create a database, see it, and switch theme', async ({ page }) => {
  const username = `e2e_${Date.now()}`;

  // Register.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();

  // Lands on the database picker (registration logs in).
  await expect(page).toHaveURL(/\/databases$/);
  await expect(page.getByRole('heading', { name: 'Databases' })).toBeVisible();

  // Create a database.
  await page.getByPlaceholder('new-database').fill('e2e-kb');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-kb')).toBeVisible();
  await expect(page.getByText('owner')).toBeVisible();

  // Switch the theme — the <html> data-theme attribute updates.
  await page.getByLabel('Theme').selectOption('neon-terminal');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neon-terminal');

  // Log out returns to login.
  await page.getByRole('button', { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
```

- [x] **Step 4: Wire the e2e script (excluded from the default gate)**

In `apps/web/package.json` `scripts`, add `"e2e": "playwright test"`. In the root `package.json`, add `"e2e:web": "pnpm -F web e2e"`. Do NOT add e2e to the root `test` script — keep the default gate fast. Append to `.gitignore`:

```
apps/web/playwright-report/
apps/web/test-results/
```

- [x] **Step 5: Run the e2e to verify it passes**

Run: `pnpm -F web e2e`
Expected: PASS — the webServer builds the SPA, starts `@atlas/server` serving it, and the single spec drives register→picker→create→theme→logout. If the build output path differs, fix `ATLAS_STATIC_DIR` (Step 2 note) and rerun. Do not weaken the assertions.

- [x] **Step 6: Update the README**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M6a — Knowledge Graph Explorer foundation (`apps/web`, Angular 20
standalone + signals + zoneless): the `@atlas/client` SDK gains a cookie/session
mode so the app talks to the server exclusively through it; three first-class
themes (Midnight Observatory, Clean Laboratory, Neon Terminal) with a persisted
ThemeService; auth (login/register + route guard); and an authenticated shell
with a database picker (list/create/seed/open). The graph workspace canvas,
AQL console, schema view, algorithms view, and admin land in M6b–M6d; the
`/db/:name` route is a placeholder here.
```

- [x] **Step 7: Run the full gate**

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green — `tsc -b` builds the libraries (ignoring `apps/web`), the Angular builder builds the app, `typecheck:test` covers the new client session test tsconfig, eslint + prettier cover `apps/web/src`, and `pnpm test` runs the library Vitest suite plus the app's `ng test` suite. The e2e is intentionally excluded (run separately via `pnpm e2e:web`).

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): Playwright e2e smoke, README status, and full M6a gate green"
```

End the body with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Plan self-review notes

- **Spec coverage (§7 slice for M6a):**
  - §7.1 Angular 20 standalone + signals + zoneless; server communication exclusively through `@atlas/client` → T1 (cookie mode + auth/db methods make the client a complete surface), T2 (verified scaffold: zoneless bootstrap, signal components, Vitest builder), T4 (`AtlasApi` is the app's only door to the server).
  - §7.2 screens — Login/register → T5; Database picker (list/create/seed/import) → T6 (list/create/seed shipped; file import deferred to M6d admin/io); Workspace/Schema/Algorithms/Admin → **deferred** (placeholder `/db/:name` route only).
  - §7.4 three first-class themes as CSS custom-property token sets, instant switching, persisted → T3 (`ThemeService` + `styles.css` token sets; switcher in T6). "Persisted per user" is implemented as `localStorage` per browser in v1 (see deliberate decisions).
  - §7.5 accessibility — keyboard nav (native form controls + buttons), visible focus (`:focus-visible` outline using `--accent`), ARIA labelling (`role="alert"` on errors, `aria-label`/`<label>` on the theme select and all inputs, `.sr-only` labels) → T3/T5/T6. Full WCAG-AA contrast verification across all three themes and the accessible results table mirror are revisited with the canvas in M6b/M6c.
- **Deferred to M6b/M6c/M6d (explicitly out of scope):** the Canvas2D + d3-force graph renderer in a Web Worker (§7.3) → M6b; the CodeMirror AQL console with schema-aware autocomplete + EXPLAIN plan + history, the schema view, and the algorithms view → M6c; the admin screens (users, tokens, roles, audit, db settings) and file import → M6d. The `/db/:name` workspace route renders only `WorkspacePlaceholder` in M6a.
- **Deliberate v1 decisions:**
  - **Cookie-mode client:** the browser authenticates via the httpOnly `atlas_session` cookie (`credentials: 'include'`), never a bearer token — so no token is exposed to JS. The bearer path is retained unchanged for server-to-server/CLI use; the existing `client.test.ts` keeps passing.
  - **Theme persistence is per-browser (`localStorage`), not per-server-user.** The spec says "persisted per user"; storing it server-side would need a user-prefs endpoint that does not exist yet — `localStorage` is the pragmatic v1, and the `ThemeService` API is unchanged if we later sync it server-side.
  - **e2e excluded from the default gate:** Playwright runs via `pnpm e2e:web` only, keeping `pnpm test` fast (libraries' Vitest + the app's `ng test`). The e2e serves the built SPA from `@atlas/server` static hosting so cookies are genuinely same-origin (no CORS shim).
  - **Placeholder workspace route:** `/db/:name` renders a stub by design — the hero workspace is M6b/M6c.
- **Type/signature consistency (cross-task anchors):**
  - Client method names are identical between T1 (`AtlasClient`: `register`, `login`, `logout`, `whoami`, `listDatabases`, `createDatabase`, `getDatabase`, `seed`, `database`; `Database`: `query`, `schema`, `subscribe`) and the T4 `AtlasApi` wrapper, and the T6 `PickerStore`/components. `whoami(): Promise<UserInfo | null>` (401 → null) is consumed by `AuthService.refresh()` and `authGuard` consistently.
  - Shared types flow from `@atlas/protocol` (`UserInfo`, `DbInfo`) and from `@atlas/client` (`DbSummary`, `SeedResult`, `Database`). `DbSummary { name, description, role }` matches `GET /api/db`'s verified shape exactly; `SchemaSummary` is imported type-only from `@atlas/core` (T1 adds the `@atlas/core` dep + tsconfig reference to `@atlas/client`).
  - Theme ids are the single union `ThemeId = 'midnight-observatory' | 'clean-laboratory' | 'neon-terminal'`, used identically by `ThemeService`, the `styles.css` `[data-theme=…]` selectors, the `ThemeSwitcher`, and the e2e (`selectOption('neon-terminal')`, asserting `data-theme='neon-terminal'`).
  - Route paths are consistent everywhere: `/login`, `/register`, `/databases` (shell + picker child), `/db/:name` (placeholder). `Login.submit` and `Register.submit` navigate to `/databases`; `Shell.logout` and `authGuard` use `/login`; the e2e asserts `/databases` and `/login`. Storage key `atlas.theme`; cookie name `atlas_session` (server-set, never read by JS).
- **Self-review fixes applied:** Task 5 ships a minimal route table (login/register only) so it is independently green, and Task 6 restores the full table once `shell`/`picker`/`workspace-placeholder` exist (no forward-reference compile break). The `WorkspacePlaceholder` is created in Task 6 Step 0 before the full routes reference it. The picker only offers "Seed" to owner/editor roles (viewers cannot write — matches the server's permission matrix, avoiding a guaranteed 403). `connect('')` is confirmed safe (`''.replace(/\/$/, '') === ''`) for same-origin requests. The Angular `apps/web/tsconfig.json` stays self-contained and out of the root `tsc -b` references, per the verified recipe; the build is wired via `pnpm -F web build` in the root `build` script and the test via `pnpm -F web exec ng test --watch=false` in the root `test` script. Every `pnpm`/`ng`/`pnpm dlx` command matches the verified Angular 20 recipe (zoneless, Vitest builder, jsdom, `providersFile: src/test-setup.ts`).
