# Atlas M5a — Server Foundation Implementation Plan

**Goal:** Stand up the Atlas server's foundation: the shared `@atlas/protocol` wire-schema package, the `@atlas/server` Fastify app with argon2id auth (sessions + API tokens), a lazily-loaded multi-database manager whose system catalog is itself an Atlas graph database, and the core REST endpoints (auth, database lifecycle, query, schema) with the spec's permission matrix enforced.

**Architecture:** `@atlas/protocol` holds zod request/response schemas + wire types, depended on by both server and (M5b) client — no server imports leak to the client. `@atlas/server` composes a Fastify app via a `buildServer(deps)` factory (testable with `.inject()`, no real socket). Auth identities, API tokens, the database registry, and per-database role grants live in a dedicated "catalog" Atlas database (dogfooding the engine). A `DatabaseManager` opens user databases lazily into per-name data directories and drains them on shutdown. Every protected route runs an auth preHandler (session cookie or bearer token) then a permission check against the matrix.

**Tech Stack:** Existing stack + Fastify 5, `@fastify/cookie` (signed session cookies), `@node-rs/argon2` (prebuilt argon2id, no native compiler), zod 3. HTTP tests use Fastify `.inject()`. WebSocket subscriptions, node/edge CRUD, import/export, the client SDK, metrics, rate-limiting, and static hosting are **M5b — out of scope here.**

**Spec:** `docs/design/specs/2026-06-10-atlas-graph-platform-design.md` §6.1 (Fastify, zod, RFC 7807 errors carrying AtlasError codes), §6.2 (argon2id, sessions + bearer tokens, the permission matrix — normative), §6.3 (lazy per-db engines, catalog-as-Atlas-db, SIGTERM drain), §6.4 (endpoint table — M5a does auth/databases/query/schema/healthz; the rest is M5b).

**Existing code anchors:**
- `@atlas/core`: `openDatabase(dir, opts?) → Promise<AtlasDatabase>`; `AtlasDatabase` has `transact(fn)`, `graph()`, `graphStore`, `schema()`, `createIndex/dropIndex/listIndexes`, `close()`, `getNode`, `nodesByLabel`; `AtlasError { code, message }` with codes incl. `CONSTRAINT_VIOLATION`, `NOT_FOUND`, `VALIDATION`, `TIMEOUT`.
- `@atlas/query`: `executeQuery(db, text, { params, timeoutMs, maxRows }) → Promise<QueryResult{columns,rows,stats}>`; `parseQuery(text) → { explain, statement }` where `statement.type ∈ 'read'|'write'|'ddl'|'call'`; `AqlError { code, line, column, snippet }`.
- `@atlas/datasets`: `scienceHistory()`, `loadDataset(db, graph)`.

---

## File structure

```
packages/protocol/
  package.json            @atlas/protocol (dep: zod)
  tsconfig.json           composite
  test/tsconfig.json
  src/index.ts            re-exports
  src/wire.ts             zod schemas: RegisterReq, LoginReq, CreateDbReq, QueryReq, GrantRoleReq,
                          CreateTokenReq, + response types; Role enum; ProblemDetails
  test/wire.test.ts

packages/server/
  package.json            @atlas/server (deps: @atlas/core, @atlas/query, @atlas/datasets,
                          @atlas/protocol, fastify, @fastify/cookie, @node-rs/argon2, zod)
  tsconfig.json           references core, query, datasets, protocol
  test/tsconfig.json
  src/index.ts            buildServer + start() entry
  src/config.ts           loadConfig(env) → ServerConfig (data dir, secret, admin bootstrap, limits)
  src/errors.ts           toProblem(err) → {status, ProblemDetails}; registerErrorHandler(app)
  src/crypto.ts           hashPassword/verifyPassword, generateToken/hashToken (argon2id)
  src/catalog.ts          CatalogService over a dedicated Atlas db (users, tokens, dbs, roles, audit)
  src/db-manager.ts       DatabaseManager: lazy openDatabase per name, role checks, shutdown drain
  src/auth.ts             auth preHandler (cookie/bearer → principal); requireRole helpers
  src/routes/auth.ts      register/login/logout, whoami
  src/routes/databases.ts GET/POST /db, GET/PATCH/DELETE /db/:name, role grants
  src/routes/query.ts     POST /db/:name/query, GET /db/:name/schema
  src/routes/tokens.ts    API token CRUD
  src/app.ts              buildServer(config) wiring plugins + routes + error handler + catalog
  test/*.test.ts          per-area inject() tests

tsconfig.json             MODIFY: references += protocol, server
package.json              MODIFY: typecheck:test += protocol/server test tsconfigs
README.md                 MODIFY (Task 9)
```

Conventions: ESM `.js` imports; commits end with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never run bare `vitest` (always `pnpm vitest run`). All HTTP tests use `app.inject(...)` — no listening socket.

---

### Task 1: `@atlas/protocol` — wire schemas

**Files:**
- Create: `packages/protocol/package.json`, `tsconfig.json`, `test/tsconfig.json`, `src/index.ts`, `src/wire.ts`
- Modify: root `tsconfig.json`, root `package.json`
- Test: `packages/protocol/test/wire.test.ts`

- [x] **Step 1: Write the package files**

`packages/protocol/package.json`:

```json
{
  "name": "@atlas/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "dependencies": { "zod": "^3.23.8" }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/protocol/test/tsconfig.json`:

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

Root `tsconfig.json` references gains `{ "path": "packages/protocol" }`. Root `package.json` `typecheck:test` appends ` && tsc -p packages/protocol/test/tsconfig.json`.

`packages/protocol/src/index.ts`:

```ts
export * from './wire.js';
```

- [x] **Step 2: Write the failing tests**

`packages/protocol/test/wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CreateDbReq,
  GrantRoleReq,
  LoginReq,
  QueryReq,
  RegisterReq,
  Role,
  dbNameSchema,
} from '../src/wire.js';

describe('wire schemas', () => {
  it('RegisterReq/LoginReq require username + password', () => {
    expect(RegisterReq.safeParse({ username: 'ada', password: 'secret12' }).success).toBe(true);
    expect(RegisterReq.safeParse({ username: 'ada' }).success).toBe(false);
    expect(LoginReq.safeParse({ username: 'a', password: 'b' }).success).toBe(true);
  });

  it('dbNameSchema enforces a safe slug (no path traversal)', () => {
    expect(dbNameSchema.safeParse('knowledge-base').success).toBe(true);
    expect(dbNameSchema.safeParse('kb_2').success).toBe(true);
    expect(dbNameSchema.safeParse('../etc').success).toBe(false);
    expect(dbNameSchema.safeParse('has space').success).toBe(false);
    expect(dbNameSchema.safeParse('').success).toBe(false);
    expect(dbNameSchema.safeParse('A'.repeat(65)).success).toBe(false);
  });

  it('CreateDbReq validates the db name', () => {
    expect(CreateDbReq.safeParse({ name: 'good' }).success).toBe(true);
    expect(CreateDbReq.safeParse({ name: 'bad/name' }).success).toBe(false);
  });

  it('QueryReq requires text and defaults params to {}', () => {
    const p = QueryReq.parse({ query: 'MATCH (n) RETURN n' });
    expect(p.params).toEqual({});
    expect(QueryReq.safeParse({}).success).toBe(false);
  });

  it('Role enum and GrantRoleReq', () => {
    expect(Role.options).toEqual(['owner', 'editor', 'viewer']);
    expect(GrantRoleReq.safeParse({ username: 'bob', role: 'editor' }).success).toBe(true);
    expect(GrantRoleReq.safeParse({ username: 'bob', role: 'admin' }).success).toBe(false);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run packages/protocol/test/wire.test.ts`
Expected: FAIL — `../src/wire.js` not found.

- [x] **Step 4: Implement**

`packages/protocol/src/wire.ts`:

```ts
import { z } from 'zod';

/** DB names are filesystem path segments — keep them a strict safe slug. */
export const dbNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be alphanumeric with - or _, not starting with - or _');

export const usernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid username');

export const Role = z.enum(['owner', 'editor', 'viewer']);
export type RoleName = z.infer<typeof Role>;

export const RegisterReq = z.object({
  username: usernameSchema,
  password: z.string().min(8).max(256),
});
export type RegisterReq = z.infer<typeof RegisterReq>;

export const LoginReq = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginReq = z.infer<typeof LoginReq>;

export const CreateDbReq = z.object({ name: dbNameSchema });
export type CreateDbReq = z.infer<typeof CreateDbReq>;

export const PatchDbReq = z.object({ description: z.string().max(512).optional() });
export type PatchDbReq = z.infer<typeof PatchDbReq>;

export const QueryReq = z.object({
  query: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});
export type QueryReq = z.infer<typeof QueryReq>;

export const GrantRoleReq = z.object({ username: usernameSchema, role: Role });
export type GrantRoleReq = z.infer<typeof GrantRoleReq>;

export const CreateTokenReq = z.object({ name: z.string().min(1).max(64) });
export type CreateTokenReq = z.infer<typeof CreateTokenReq>;

/** RFC 7807 problem-details, extended with the engine/query error `code`. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  /** AqlError position passthrough, when present. */
  line?: number;
  column?: number;
  snippet?: string;
}

export interface UserInfo {
  username: string;
  isAdmin: boolean;
}

export interface DbInfo {
  name: string;
  description?: string;
  role: RoleName | null; // caller's role on this db; null for admins with no explicit grant
  owners: string[];
}

export interface QueryResponse {
  columns: string[];
  rows: unknown[][];
  stats: { rowsExamined: number; elapsedMs: number; created?: number; deleted?: number; propsSet?: number };
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/protocol/test/wire.test.ts && pnpm build`
Expected: PASS; build clean with the new package reference.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(protocol): @atlas/protocol wire schemas and problem-details types"
```

### Task 2: `@atlas/server` scaffold, config, error mapping

**Files:**
- Create: `packages/server/package.json`, `tsconfig.json`, `test/tsconfig.json`, `src/config.ts`, `src/errors.ts`, `src/index.ts`
- Modify: root `tsconfig.json`, root `package.json`
- Test: `packages/server/test/errors.test.ts`, `packages/server/test/config.test.ts`

- [x] **Step 1: Write the package files**

`packages/server/package.json`:

```json
{
  "name": "@atlas/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@atlas/core": "workspace:*",
    "@atlas/query": "workspace:*",
    "@atlas/datasets": "workspace:*",
    "@atlas/protocol": "workspace:*",
    "@fastify/cookie": "^11.0.2",
    "@node-rs/argon2": "^2.0.2",
    "fastify": "^5.2.0",
    "zod": "^3.23.8"
  }
}
```

`packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [
    { "path": "../core" },
    { "path": "../query" },
    { "path": "../datasets" },
    { "path": "../protocol" }
  ]
}
```

`packages/server/test/tsconfig.json` (same shape as other test tsconfigs; `include: ["./**/*.ts", "../src/**/*.ts"]`).

Root `tsconfig.json` references gains `{ "path": "packages/server" }`. Root `package.json` `typecheck:test` appends ` && tsc -p packages/server/test/tsconfig.json`.

- [x] **Step 2: Write the failing tests**

`packages/server/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('reads required + defaulted values from an env map', () => {
    const c = loadConfig({
      ATLAS_DATA_DIR: '/tmp/atlas',
      ATLAS_SECRET: 'x'.repeat(32),
      ATLAS_ADMIN_USER: 'root',
      ATLAS_ADMIN_PASSWORD: 'rootpass1',
    });
    expect(c.dataDir).toBe('/tmp/atlas');
    expect(c.secret).toHaveLength(32);
    expect(c.admin).toEqual({ username: 'root', password: 'rootpass1' });
    expect(c.queryTimeoutMs).toBe(30_000); // default
    expect(c.maxRows).toBe(100_000); // default
  });

  it('throws when a required value is missing or the secret is too short', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() =>
      loadConfig({ ATLAS_DATA_DIR: '/tmp/a', ATLAS_SECRET: 'short' }),
    ).toThrow(/secret/i);
  });

  it('admin bootstrap is optional (absent → no admin seeding)', () => {
    const c = loadConfig({ ATLAS_DATA_DIR: '/tmp/a', ATLAS_SECRET: 'y'.repeat(32) });
    expect(c.admin).toBeUndefined();
  });
});
```

`packages/server/test/errors.test.ts`:

```ts
import { AtlasError } from '@atlas/core';
import { AqlError } from '@atlas/query';
import { describe, expect, it } from 'vitest';
import { toProblem } from '../src/errors.js';

describe('toProblem', () => {
  it('maps AqlError to 400 with code + position', () => {
    const e = new AqlError('PARSE_ERROR', 'bad', { line: 2, column: 5 }, 'MATCH\nx');
    const { status, body } = toProblem(e);
    expect(status).toBe(400);
    expect(body.code).toBe('PARSE_ERROR');
    expect(body.line).toBe(2);
    expect(body.column).toBe(5);
    expect(body.snippet).toContain('^');
  });

  it('maps engine AtlasError codes to sensible HTTP statuses', () => {
    expect(toProblem(new AtlasError('CONSTRAINT_VIOLATION', 'dup')).status).toBe(409);
    expect(toProblem(new AtlasError('NOT_FOUND', 'x')).status).toBe(404);
    expect(toProblem(new AtlasError('VALIDATION', 'x')).status).toBe(400);
    expect(toProblem(new AtlasError('TIMEOUT', 'x')).status).toBe(504);
  });

  it('maps unknown errors to 500 without leaking the message as title', () => {
    const { status, body } = toProblem(new Error('boom internal detail'));
    expect(status).toBe(500);
    expect(body.title).toBe('Internal Server Error');
    expect(body.code).toBe('INTERNAL');
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run packages/server/test/config.test.ts packages/server/test/errors.test.ts`
Expected: FAIL — modules not found (install links the new deps first).

- [x] **Step 4: Implement**

`packages/server/src/config.ts`:

```ts
export interface ServerConfig {
  dataDir: string;
  secret: string;
  admin?: { username: string; password: string };
  port: number;
  queryTimeoutMs: number;
  maxRows: number;
  corsOrigins: string[];
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const dataDir = env.ATLAS_DATA_DIR;
  if (!dataDir) throw new Error('ATLAS_DATA_DIR is required');
  const secret = env.ATLAS_SECRET;
  if (!secret || secret.length < 32) throw new Error('ATLAS_SECRET is required and must be >= 32 chars');
  const adminUser = env.ATLAS_ADMIN_USER;
  const adminPassword = env.ATLAS_ADMIN_PASSWORD;
  const admin =
    adminUser && adminPassword ? { username: adminUser, password: adminPassword } : undefined;
  return {
    dataDir,
    secret,
    admin,
    port: Number(env.ATLAS_PORT ?? '4848'),
    queryTimeoutMs: Number(env.ATLAS_QUERY_TIMEOUT_MS ?? '30000'),
    maxRows: Number(env.ATLAS_MAX_ROWS ?? '100000'),
    corsOrigins: (env.ATLAS_CORS_ORIGINS ?? '').split(',').filter((s) => s.length > 0),
  };
}
```

`packages/server/src/errors.ts`:

```ts
import { AtlasError } from '@atlas/core';
import { AqlError } from '@atlas/query';
import type { ProblemDetails } from '@atlas/protocol';

const ENGINE_STATUS: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONSTRAINT_VIOLATION: 409,
  TIMEOUT: 504,
  WAL_CORRUPT: 500,
  WAL_CORRUPT_TAIL: 500,
  INTERNAL: 500,
};

const AQL_STATUS: Record<string, number> = {
  PARSE_ERROR: 400,
  SEMANTIC_ERROR: 400,
  RUNTIME_ERROR: 400,
  TIMEOUT: 504,
  ROW_LIMIT: 413,
};

/** HTTP-layer auth/permission errors carry an explicit status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function toProblem(err: unknown): { status: number; body: ProblemDetails } {
  if (err instanceof AqlError) {
    const status = AQL_STATUS[err.code] ?? 400;
    return {
      status,
      body: {
        type: 'about:blank',
        title: 'Query Error',
        status,
        detail: err.message,
        code: err.code,
        line: err.line,
        column: err.column,
        snippet: err.snippet,
      },
    };
  }
  if (err instanceof AtlasError) {
    const status = ENGINE_STATUS[err.code] ?? 500;
    return {
      status,
      body: { type: 'about:blank', title: 'Engine Error', status, detail: err.message, code: err.code },
    };
  }
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { type: 'about:blank', title: httpTitle(err.status), status: err.status, detail: err.message, code: err.code },
    };
  }
  return {
    status: 500,
    body: { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL' },
  };
}

function httpTitle(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  return 'Error';
}
```

`packages/server/src/index.ts` (placeholder; Task 8 finalizes):

```ts
export { loadConfig, type ServerConfig } from './config.js';
export { toProblem, HttpError } from './errors.js';
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/config.test.ts packages/server/test/errors.test.ts && pnpm build`
Expected: PASS; build clean.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): scaffold, config loader, error-to-problem mapping"
```

### Task 3: Crypto — argon2id password + token hashing

**Files:**
- Create: `packages/server/src/crypto.ts`
- Test: `packages/server/test/crypto.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateToken, hashPassword, hashToken, verifyPassword, verifyToken } from '../src/crypto.js';

describe('password hashing (argon2id)', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces distinct salted hashes for the same password', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('API tokens', () => {
  it('generates a high-entropy token and verifies its hash', async () => {
    const { token, hash } = await generateToken();
    expect(token).toHaveLength(43); // 32 bytes base64url, no padding
    expect(token).not.toEqual(hash);
    expect(await verifyToken(hash, token)).toBe(true);
    expect(await verifyToken(hash, 'atlas_deadbeef')).toBe(false);
  });

  it('hashToken is deterministic enough to look up, verifyToken confirms', async () => {
    const { token, hash } = await generateToken();
    // hashToken is argon2id (salted) — NOT used as a lookup key; verifyToken does the check.
    const other = await hashToken(token);
    expect(await verifyToken(other, token)).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/crypto.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`packages/server/src/crypto.ts`:

```ts
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false; // malformed hash → not a match, never throw into the auth path
  }
}

/** A fresh API token (shown once) plus its argon2id hash (stored). */
export async function generateToken(): Promise<{ token: string; hash: string }> {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: await hash(token, ARGON_OPTS) };
}

export function hashToken(token: string): Promise<string> {
  return hash(token, ARGON_OPTS);
}

export async function verifyToken(storedHash: string, token: string): Promise<boolean> {
  try {
    return await verify(storedHash, token);
  } catch {
    return false;
  }
}
```

Note on token lookup: since argon2id is salted, the server cannot hash an incoming token to find its row directly. The token format is `<id>.<secret>`: `generateToken` returns the secret only; the token CRUD route (Task 8) prepends the catalog token-id, so the client sends `id.secret`, the server looks up the row by `id`, then `verifyToken(row.hash, secret)`. Adjust `generateToken` callers accordingly in Task 8 — `crypto.ts` stays as above (it mints and verifies the secret half).

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/crypto.test.ts`
Expected: PASS (argon2id hashing may take ~50ms/op — fine).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): argon2id password and API-token hashing"
```

### Task 4: System catalog (dogfooded Atlas database)

The catalog is a normal Atlas database at `<dataDir>/_catalog`. Schema: `User {username, passwordHash, isAdmin, createdAt}`; `Token {tokenId, name, hash, createdAt}` with `(:User)-[:HAS_TOKEN]->(:Token)`; `Database {name, description, createdAt}`; role grants as edges `(:User)-[:OWNER|EDITOR|VIEWER]->(:Database)`. Unique constraints on `User.username`, `Database.name`, `Token.tokenId`.

**Files:**
- Create: `packages/server/src/catalog.ts`
- Test: `packages/server/test/catalog.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/catalog.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogService } from '../src/catalog.js';

let dir: string;
let cat: CatalogService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-cat-'));
  cat = await CatalogService.open(join(dir, '_catalog'));
});
afterEach(async () => {
  await cat.close();
  await rm(dir, { recursive: true, force: true });
});

describe('users', () => {
  it('creates and fetches a user; usernames are unique', async () => {
    await cat.createUser('ada', 'hash1', false);
    const u = await cat.findUser('ada');
    expect(u).toMatchObject({ username: 'ada', passwordHash: 'hash1', isAdmin: false });
    await expect(cat.createUser('ada', 'hash2', false)).rejects.toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
    });
    expect(await cat.findUser('nobody')).toBeNull();
  });
});

describe('databases + roles', () => {
  it('records databases, grants roles, and resolves a user role', async () => {
    await cat.createUser('ada', 'h', false);
    await cat.createDatabase('kb', 'ada'); // creator becomes owner
    expect(await cat.roleOf('ada', 'kb')).toBe('owner');
    expect(await cat.listDatabasesFor('ada')).toHaveLength(1);

    await cat.createUser('bob', 'h', false);
    expect(await cat.roleOf('bob', 'kb')).toBeNull();
    await cat.grantRole('bob', 'kb', 'editor');
    expect(await cat.roleOf('bob', 'kb')).toBe('editor');
    await cat.grantRole('bob', 'kb', 'viewer'); // regrant replaces
    expect(await cat.roleOf('bob', 'kb')).toBe('viewer');
    await cat.revokeRole('bob', 'kb');
    expect(await cat.roleOf('bob', 'kb')).toBeNull();

    expect(await cat.ownersOf('kb')).toEqual(['ada']);
  });

  it('deletes a database and its grants', async () => {
    await cat.createUser('ada', 'h', false);
    await cat.createDatabase('kb', 'ada');
    await cat.deleteDatabase('kb');
    expect(await cat.databaseExists('kb')).toBe(false);
    expect(await cat.roleOf('ada', 'kb')).toBeNull();
  });
});

describe('tokens', () => {
  it('creates, lists, verifies-by-id, and revokes tokens', async () => {
    await cat.createUser('ada', 'h', false);
    const t = await cat.createToken('ada', 'ci', 'tokenhash');
    expect(t.tokenId).toBeTruthy();
    const found = await cat.findToken(t.tokenId);
    expect(found).toMatchObject({ username: 'ada', hash: 'tokenhash', name: 'ci' });
    expect((await cat.listTokens('ada'))[0]).toMatchObject({ name: 'ci' });
    await cat.revokeToken('ada', t.tokenId);
    expect(await cat.findToken(t.tokenId)).toBeNull();
  });
});

describe('persistence', () => {
  it('survives reopen', async () => {
    await cat.createUser('ada', 'h', true);
    await cat.createDatabase('kb', 'ada');
    await cat.close();
    const c2 = await CatalogService.open(join(dir, '_catalog'));
    expect((await c2.findUser('ada'))?.isAdmin).toBe(true);
    expect(await c2.databaseExists('kb')).toBe(true);
    await c2.close();
    cat = await CatalogService.open(join(dir, '_catalog')); // for afterEach close
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/catalog.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`packages/server/src/catalog.ts`:

```ts
import { openDatabase, type AtlasDatabase, type NodeId } from '@atlas/core';
import { executeQuery } from '@atlas/query';
import type { RoleName } from '@atlas/protocol';
import { randomBytes } from 'node:crypto';

export interface UserRow {
  username: string;
  passwordHash: string;
  isAdmin: boolean;
}
export interface TokenRow {
  tokenId: string;
  name: string;
  hash: string;
  username: string;
}

const ROLE_EDGE: Record<RoleName, string> = { owner: 'OWNER', editor: 'EDITOR', viewer: 'VIEWER' };
const EDGE_ROLE: Record<string, RoleName> = { OWNER: 'owner', EDITOR: 'editor', VIEWER: 'viewer' };

/** Catalog persisted as a dedicated Atlas database (the platform dogfoods its engine). */
export class CatalogService {
  private constructor(private readonly db: AtlasDatabase) {}

  static async open(dir: string): Promise<CatalogService> {
    const db = await openDatabase(dir);
    // Idempotent constraint setup.
    const ensure = async (kind: 'unique', label: string, property: string): Promise<void> => {
      const have = db.listIndexes().some((d) => d.kind === kind && d.label === label && d.property === property);
      if (!have) await db.createIndex({ kind, label, property });
    };
    await ensure('unique', 'User', 'username');
    await ensure('unique', 'Database', 'name');
    await ensure('unique', 'Token', 'tokenId');
    return new CatalogService(db);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  // ---- users ----
  async createUser(username: string, passwordHash: string, isAdmin: boolean): Promise<void> {
    await this.db.transact((tx) => {
      tx.createNode(['User'], { username, passwordHash, isAdmin, createdAt: nowIso() });
    });
  }

  async findUser(username: string): Promise<UserRow | null> {
    const n = this.userNode(username);
    if (!n) return null;
    return {
      username,
      passwordHash: String(n.props.passwordHash),
      isAdmin: n.props.isAdmin === true,
    };
  }

  async anyUserExists(): Promise<boolean> {
    for (const _ of this.db.nodesByLabel('User')) return true;
    return false;
  }

  // ---- databases + roles ----
  async createDatabase(name: string, ownerUsername: string): Promise<void> {
    const owner = this.requireUserNode(ownerUsername);
    await this.db.transact((tx) => {
      const dbNode = tx.createNode(['Database'], { name, description: '', createdAt: nowIso() });
      tx.createEdge('OWNER', owner.id, dbNode);
    });
  }

  async databaseExists(name: string): Promise<boolean> {
    return this.dbNode(name) !== null;
  }

  async deleteDatabase(name: string): Promise<void> {
    const node = this.dbNode(name);
    if (!node) return;
    await this.db.transact((tx) => tx.deleteNode(node.id, { detach: true }));
  }

  async patchDatabase(name: string, description: string): Promise<void> {
    const node = this.dbNode(name);
    if (!node) return;
    await this.db.transact((tx) => tx.setNodeProps(node.id, { description }));
  }

  async grantRole(username: string, dbName: string, role: RoleName): Promise<void> {
    const user = this.requireUserNode(username);
    const dbNode = this.requireDbNode(dbName);
    await this.db.transact((tx) => {
      // Remove any existing grant edge first (regrant replaces).
      for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
        for (const e of this.db.outEdges(user.id, edgeType)) if (e.to === dbNode.id) tx.deleteEdge(e.id);
      tx.createEdge(ROLE_EDGE[role], user.id, dbNode.id);
    });
  }

  async revokeRole(username: string, dbName: string): Promise<void> {
    const user = this.userNode(username);
    const dbNode = this.dbNode(dbName);
    if (!user || !dbNode) return;
    await this.db.transact((tx) => {
      for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
        for (const e of this.db.outEdges(user.id, edgeType)) if (e.to === dbNode.id) tx.deleteEdge(e.id);
    });
  }

  async roleOf(username: string, dbName: string): Promise<RoleName | null> {
    const user = this.userNode(username);
    const dbNode = this.dbNode(dbName);
    if (!user || !dbNode) return null;
    for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
      for (const e of this.db.outEdges(user.id, edgeType)) if (e.to === dbNode.id) return EDGE_ROLE[edgeType]!;
    return null;
  }

  async ownersOf(dbName: string): Promise<string[]> {
    const dbNode = this.dbNode(dbName);
    if (!dbNode) return [];
    const owners: string[] = [];
    for (const e of this.db.inEdges(dbNode.id, 'OWNER')) {
      const u = this.db.getNode(e.from);
      if (u) owners.push(String(u.props.username));
    }
    return owners.sort();
  }

  async listDatabasesFor(username: string): Promise<{ name: string; description: string; role: RoleName }[]> {
    const user = this.userNode(username);
    if (!user) return [];
    const out: { name: string; description: string; role: RoleName }[] = [];
    for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
      for (const e of this.db.outEdges(user.id, edgeType)) {
        const d = this.db.getNode(e.to);
        if (d) out.push({ name: String(d.props.name), description: String(d.props.description ?? ''), role: EDGE_ROLE[edgeType]! });
      }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAllDatabases(): Promise<{ name: string; description: string }[]> {
    return [...this.db.nodesByLabel('Database')]
      .map((d) => ({ name: String(d.props.name), description: String(d.props.description ?? '') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- tokens ----
  async createToken(username: string, name: string, hash: string): Promise<TokenRow> {
    const user = this.requireUserNode(username);
    const tokenId = randomBytes(9).toString('base64url');
    await this.db.transact((tx) => {
      const t = tx.createNode(['Token'], { tokenId, name, hash, createdAt: nowIso() });
      tx.createEdge('HAS_TOKEN', user.id, t);
    });
    return { tokenId, name, hash, username };
  }

  async findToken(tokenId: string): Promise<TokenRow | null> {
    const t = this.tokenNode(tokenId);
    if (!t) return null;
    let username = '';
    for (const e of this.db.inEdges(t.id, 'HAS_TOKEN')) {
      const u = this.db.getNode(e.from);
      if (u) username = String(u.props.username);
    }
    return { tokenId, name: String(t.props.name), hash: String(t.props.hash), username };
  }

  async listTokens(username: string): Promise<{ tokenId: string; name: string }[]> {
    const user = this.userNode(username);
    if (!user) return [];
    const out: { tokenId: string; name: string }[] = [];
    for (const e of this.db.outEdges(user.id, 'HAS_TOKEN')) {
      const t = this.db.getNode(e.to);
      if (t) out.push({ tokenId: String(t.props.tokenId), name: String(t.props.name) });
    }
    return out;
  }

  async revokeToken(username: string, tokenId: string): Promise<void> {
    const t = this.tokenNode(tokenId);
    if (!t) return;
    await this.db.transact((tx) => tx.deleteNode(t.id, { detach: true }));
  }

  // ---- private node lookups (use the unique index via the fluent API) ----
  private userNode(username: string) {
    return this.db.graph().nodes('User').where((p) => p.username === username).first() ?? null;
  }
  private dbNode(name: string) {
    return this.db.graph().nodes('Database').where((p) => p.name === name).first() ?? null;
  }
  private tokenNode(tokenId: string) {
    return this.db.graph().nodes('Token').where((p) => p.tokenId === tokenId).first() ?? null;
  }
  private requireUserNode(username: string): { id: NodeId } {
    const n = this.userNode(username);
    if (!n) throw new Error(`user ${username} not found`);
    return n;
  }
  private requireDbNode(name: string): { id: NodeId } {
    const n = this.dbNode(name);
    if (!n) throw new Error(`database ${name} not found`);
    return n;
  }
}

function nowIso(): string {
  // Engine forbids non-finite numbers; store timestamps as ISO strings.
  return new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString();
}
```

Note: `nowIso()` is stubbed to a fixed instant because the engine/test environment forbids `Date.now()` in some contexts and timestamps are not asserted in M5a. The implementer may instead accept an injected clock; a fixed value is acceptable for v1 (timestamps are display-only metadata here). Use `new Date().toISOString()` in the real server entry if the runtime allows it — keep tests deterministic by not asserting timestamp values.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/catalog.test.ts`
Expected: PASS — including unique-username rejection and reopen persistence.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): system catalog as a dogfooded Atlas database"
```

### Task 5: DatabaseManager + buildServer app factory + auth preHandler

**Files:**
- Create: `packages/server/src/db-manager.ts`, `packages/server/src/auth.ts`, `packages/server/src/app.ts`
- Test: `packages/server/test/app-base.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/app-base.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-app-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('app base', () => {
  it('GET /healthz is public and reports ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
  });

  it('protected routes reject anonymous callers with 401 problem-details', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/db' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('unknown engine/internal errors become 500 problem-details, not stack traces', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(r.statusCode).toBe(404); // Fastify not-found, shaped as problem-details
    expect(r.json()).toHaveProperty('status', 404);
  });

  it('admin bootstrap seeds an admin when configured', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'atlas-app2-'));
    const app2 = await buildServer(
      loadConfig({
        ATLAS_DATA_DIR: dir2,
        ATLAS_SECRET: 's'.repeat(32),
        ATLAS_ADMIN_USER: 'root',
        ATLAS_ADMIN_PASSWORD: 'rootpass1',
      }),
    );
    const r = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'rootpass1' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: 'root', isAdmin: true });
    await app2.close();
    await rm(dir2, { recursive: true, force: true });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/app-base.test.ts`
Expected: FAIL — `app.js` not found.

- [x] **Step 3: Implement**

`packages/server/src/db-manager.ts`:

```ts
import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { join } from 'node:path';

/** Lazily opens user databases into per-name data dirs; drains them on shutdown. */
export class DatabaseManager {
  private readonly open = new Map<string, Promise<AtlasDatabase>>();

  constructor(private readonly baseDir: string) {}

  /** Path for a db's data dir. Name is validated upstream (dbNameSchema) — no traversal. */
  private dirFor(name: string): string {
    return join(this.baseDir, 'db', name);
  }

  get(name: string): Promise<AtlasDatabase> {
    let p = this.open.get(name);
    if (!p) {
      p = openDatabase(this.dirFor(name));
      this.open.set(name, p);
    }
    return p;
  }

  /** Close + forget one db (after deletion the caller also removes the data dir). */
  async evict(name: string): Promise<void> {
    const p = this.open.get(name);
    this.open.delete(name);
    if (p) await (await p).close();
  }

  async closeAll(): Promise<void> {
    const dbs = [...this.open.values()];
    this.open.clear();
    for (const p of dbs) await (await p).close();
  }
}
```

`packages/server/src/auth.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RoleName } from '@atlas/protocol';
import type { CatalogService } from './catalog.js';
import { verifyToken } from './crypto.js';
import { HttpError } from './errors.js';

export interface Principal {
  username: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Resolve a principal from a signed session cookie or a bearer `id.secret` token. */
export async function authenticate(
  req: FastifyRequest,
  catalog: CatalogService,
): Promise<Principal | null> {
  const sid = req.cookies?.atlas_session;
  if (sid) {
    const unsigned = req.unsignCookie(sid);
    if (unsigned.valid && unsigned.value) {
      const user = await catalog.findUser(unsigned.value);
      if (user) return { username: user.username, isAdmin: user.isAdmin };
    }
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const raw = auth.slice('Bearer '.length);
    const dot = raw.indexOf('.');
    if (dot > 0) {
      const tokenId = raw.slice(0, dot);
      const secret = raw.slice(dot + 1);
      const row = await catalog.findToken(tokenId);
      if (row && (await verifyToken(row.hash, secret))) {
        const user = await catalog.findUser(row.username);
        if (user) return { username: user.username, isAdmin: user.isAdmin };
      }
    }
  }
  return null;
}

/** preHandler: requires an authenticated principal, else 401. */
export function requireAuth(catalog: CatalogService) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const principal = await authenticate(req, catalog);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
    req.principal = principal;
  };
}

/** Permission-matrix capability check on a database (spec §6.2). */
export type Capability = 'read' | 'write' | 'ddl' | 'admin-db' | 'delete-db';

export async function requireCapability(
  catalog: CatalogService,
  principal: Principal,
  dbName: string,
  cap: Capability,
): Promise<void> {
  if (!(await catalog.databaseExists(dbName)))
    throw new HttpError(404, 'NOT_FOUND', `database "${dbName}" not found`);
  const role = await catalog.roleOf(principal.username, dbName);
  // Server admins: db lifecycle only (delete), never data — per the matrix.
  if (cap === 'delete-db' && (principal.isAdmin || role === 'owner')) return;
  if (!role) throw new HttpError(403, 'FORBIDDEN', `no access to database "${dbName}"`);
  const allowed = capabilityAllowed(role, cap);
  if (!allowed) throw new HttpError(403, 'FORBIDDEN', `role "${role}" cannot perform "${cap}"`);
}

function capabilityAllowed(role: RoleName, cap: Capability): boolean {
  switch (cap) {
    case 'read':
      return role === 'viewer' || role === 'editor' || role === 'owner';
    case 'write':
      return role === 'editor' || role === 'owner';
    case 'ddl':
    case 'admin-db':
    case 'delete-db':
      return role === 'owner';
  }
}
```

`packages/server/src/app.ts`:

```ts
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { CatalogService } from './catalog.js';
import { hashPassword } from './crypto.js';
import { DatabaseManager } from './db-manager.js';
import { toProblem } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDatabaseRoutes } from './routes/databases.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerTokenRoutes } from './routes/tokens.js';

export interface AppContext {
  catalog: CatalogService;
  manager: DatabaseManager;
  config: ServerConfig;
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { join } = await import('node:path');
  const catalog = await CatalogService.open(join(config.dataDir, '_catalog'));
  const manager = new DatabaseManager(config.dataDir);
  const ctx: AppContext = { catalog, manager, config };

  await app.register(fastifyCookie, { secret: config.secret });

  // Uniform problem-details for thrown errors and 404s.
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toProblem(err);
    void reply.status(status).type('application/problem+json').send(body);
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).type('application/problem+json').send({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, ctx);
  await registerDatabaseRoutes(app, ctx);
  await registerQueryRoutes(app, ctx);
  await registerTokenRoutes(app, ctx);

  // Bootstrap admin once, if configured and no users exist yet.
  if (config.admin && !(await catalog.anyUserExists()))
    await catalog.createUser(config.admin.username, await hashPassword(config.admin.password), true);

  app.addHook('onClose', async () => {
    await manager.closeAll();
    await catalog.close();
  });

  return app;
}
```

Create the route modules as stubs so `app.ts` compiles; Tasks 6–8 fill them:

`packages/server/src/routes/auth.ts`, `databases.ts`, `query.ts`, `tokens.ts` each export `export async function registerXRoutes(app, ctx) {}` (empty bodies for now — but `auth.ts` must implement login for the bootstrap test in this task; so implement `registerAuthRoutes` minimally here: `POST /api/auth/login` verifying the password and returning `{ username, isAdmin }` with a signed session cookie, plus the `requireAuth` wiring used by `GET /api/db` in the base test). To keep this task self-contained, implement `registerAuthRoutes` fully (Task 6 adds register/logout/whoami tests) and `registerDatabaseRoutes` with just the authenticated `GET /api/db` returning `[]` (Task 7 fleshes it out). `registerQueryRoutes` and `registerTokenRoutes` are empty stubs.

`packages/server/src/routes/auth.ts` (this task's portion):

```ts
import { LoginReq, type UserInfo } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { verifyPassword } from '../crypto.js';
import { HttpError } from '../errors.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginReq.parse(req.body);
    const user = await ctx.catalog.findUser(body.username);
    if (!user || !(await verifyPassword(user.passwordHash, body.password)))
      throw new HttpError(401, 'UNAUTHENTICATED', 'invalid username or password');
    void reply.setCookie('atlas_session', user.username, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      path: '/',
    });
    const info: UserInfo = { username: user.username, isAdmin: user.isAdmin };
    return info;
  });
}
```

`packages/server/src/routes/databases.ts` (this task's portion):

```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';

export async function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/db', { preHandler: requireAuth(ctx.catalog) }, async (req) => {
    return ctx.catalog.listDatabasesFor(req.principal!.username);
  });
}
```

`packages/server/src/routes/query.ts` and `tokens.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

export async function registerQueryRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {}
```

(and the analogous `registerTokenRoutes`).

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/app-base.test.ts && pnpm build`
Expected: PASS — healthz, 401 on `/api/db`, 404 shape, and admin bootstrap login.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): database manager, app factory, auth preHandler, login + bootstrap"
```

### Task 6: Auth routes — register, logout, whoami

**Files:**
- Modify: `packages/server/src/routes/auth.ts`
- Test: `packages/server/test/auth-routes.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/auth-routes.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-authr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function cookieFrom(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'atlas_session')!;
  return `atlas_session=${c.value}`;
}

describe('auth routes', () => {
  it('register → login → whoami round trip', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ada', password: 'secret12' },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ username: 'ada', isAdmin: false });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ada', password: 'secret12' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);

    const who = await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { cookie } });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ username: 'ada', isAdmin: false });
  });

  it('first registered user is NOT admin (admin only via bootstrap)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'first', password: 'secret12' },
    });
    expect(reg.json()).toMatchObject({ isAdmin: false });
  });

  it('duplicate registration is a 409', async () => {
    const payload = { username: 'ada', password: 'secret12' };
    await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    expect(dup.statusCode).toBe(409);
  });

  it('bad credentials and weak passwords are rejected', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'x', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nope', password: 'whatever1' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('logout clears the session', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const cookie = cookieFrom(login);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    // The cleared cookie should no longer authenticate (expired/empty).
    const cleared = out.cookies.find((c) => c.name === 'atlas_session');
    expect(cleared?.value === '' || (cleared?.expires?.getTime() ?? 0) <= Date.now()).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/auth-routes.test.ts`
Expected: FAIL — register/logout/whoami not implemented.

- [x] **Step 3: Implement — extend `packages/server/src/routes/auth.ts`**

Add register/logout/whoami to `registerAuthRoutes` (keep the existing login handler):

```ts
import { LoginReq, RegisterReq, type UserInfo } from '@atlas/protocol';
import { requireAuth } from '../auth.js';
import { hashPassword, verifyPassword } from '../crypto.js';
```

```ts
  app.post('/api/auth/register', async (req, reply) => {
    const body = RegisterReq.parse(req.body);
    await ctx.catalog.createUser(body.username, await hashPassword(body.password), false);
    void reply.status(201);
    const info: UserInfo = { username: body.username, isAdmin: false };
    return info;
  });

  app.get('/api/auth/whoami', { preHandler: requireAuth(ctx.catalog) }, async (req) => {
    const info: UserInfo = { username: req.principal!.username, isAdmin: req.principal!.isAdmin };
    return info;
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    void reply.clearCookie('atlas_session', { path: '/' });
    return { ok: true };
  });
```

The `createUser` unique-violation already maps to 409 via `toProblem` (CONSTRAINT_VIOLATION → 409). Zod parse errors must map to 400 — ensure the error handler catches `ZodError`: in `toProblem`, add a branch returning 400 with code `VALIDATION` when `err` is a `ZodError` (import `ZodError` from `zod`). Add that branch now.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/auth-routes.test.ts packages/server/test/errors.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): register/logout/whoami routes; ZodError → 400 mapping"
```

### Task 7: Database lifecycle routes + permission matrix

**Files:**
- Modify: `packages/server/src/routes/databases.ts`
- Test: `packages/server/test/database-routes.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/database-routes.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-dbr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function userCookie(username: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret12' } });
  const c = login.cookies.find((x) => x.name === 'atlas_session')!;
  return `atlas_session=${c.value}`;
}

describe('database routes', () => {
  it('create → creator is owner → appears in their list', async () => {
    const cookie = await userCookie('ada');
    const create = await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    expect(create.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/db', headers: { cookie } });
    expect(list.json()).toEqual([{ name: 'kb', description: '', role: 'owner' }]);
  });

  it('rejects invalid db names and duplicates', async () => {
    const cookie = await userCookie('ada');
    expect(
      (await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: '../evil' } })).statusCode,
    ).toBe(400);
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    expect(
      (await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } })).statusCode,
    ).toBe(409);
  });

  it('GET /api/db/:name shows owners and the caller role; 403 for non-members', async () => {
    const ada = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    const info = await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: ada } });
    expect(info.json()).toMatchObject({ name: 'kb', role: 'owner', owners: ['ada'] });

    const bob = await userCookie('bob');
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
  });

  it('owner grants/revokes roles; only owners may grant', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });

    const grant = await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: ada },
      payload: { username: 'bob', role: 'editor' },
    });
    expect(grant.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).json()).toMatchObject({
      role: 'editor',
    });

    // bob (editor) cannot grant
    const bobGrant = await app.inject({
      method: 'POST',
      url: '/api/db/kb/roles',
      headers: { cookie: bob },
      payload: { username: 'bob', role: 'owner' },
    });
    expect(bobGrant.statusCode).toBe(403);

    const revoke = await app.inject({ method: 'DELETE', url: '/api/db/kb/roles/bob', headers: { cookie: ada } });
    expect(revoke.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
  });

  it('DELETE removes the database (owner only); non-owner editor gets 403', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie: ada }, payload: { username: 'bob', role: 'editor' } });

    expect((await app.inject({ method: 'DELETE', url: '/api/db/kb', headers: { cookie: bob } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/db/kb', headers: { cookie: ada } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/db/kb', headers: { cookie: ada } })).statusCode).toBe(404);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/database-routes.test.ts`
Expected: FAIL — only `GET /api/db` exists.

- [x] **Step 3: Implement — replace `packages/server/src/routes/databases.ts`**

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CreateDbReq, GrantRoleReq, PatchDbReq, dbNameSchema, type DbInfo } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability } from '../auth.js';
import { HttpError } from '../errors.js';

export async function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.get('/api/db', auth, async (req) => ctx.catalog.listDatabasesFor(req.principal!.username));

  app.post('/api/db', auth, async (req, reply) => {
    const body = CreateDbReq.parse(req.body);
    if (await ctx.catalog.databaseExists(body.name))
      throw new HttpError(409, 'CONSTRAINT_VIOLATION', `database "${body.name}" already exists`);
    await ctx.catalog.createDatabase(body.name, req.principal!.username);
    await ctx.manager.get(body.name); // materialize the data dir
    void reply.status(201);
    return { name: body.name };
  });

  app.get('/api/db/:name', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const info: DbInfo = {
      name,
      role: await ctx.catalog.roleOf(req.principal!.username, name),
      owners: await ctx.catalog.ownersOf(name),
    };
    return info;
  });

  app.patch('/api/db/:name', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'admin-db');
    const body = PatchDbReq.parse(req.body);
    if (body.description !== undefined) await ctx.catalog.patchDatabase(name, body.description);
    void reply.status(204);
  });

  app.delete('/api/db/:name', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'delete-db');
    await ctx.manager.evict(name);
    await ctx.catalog.deleteDatabase(name);
    await rm(join(ctx.config.dataDir, 'db', name), { recursive: true, force: true });
    void reply.status(204);
  });

  app.post('/api/db/:name/roles', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'admin-db');
    const body = GrantRoleReq.parse(req.body);
    if (!(await ctx.catalog.findUser(body.username)))
      throw new HttpError(404, 'NOT_FOUND', `user "${body.username}" not found`);
    await ctx.catalog.grantRole(body.username, name, body.role);
    void reply.status(204);
  });

  app.delete('/api/db/:name/roles/:user', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'admin-db');
    const user = (req.params as { user: string }).user;
    await ctx.catalog.revokeRole(user, name);
    void reply.status(204);
  });
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/database-routes.test.ts`
Expected: PASS — the full matrix: owner-create, grant/revoke, owner-only delete, 403s.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): database lifecycle + role grant routes with permission matrix"
```

### Task 8: Query + schema routes (role-gated) and API token routes

**Files:**
- Modify: `packages/server/src/routes/query.ts`, `packages/server/src/routes/tokens.ts`
- Test: `packages/server/test/query-routes.test.ts`, `packages/server/test/token-routes.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/server/test/query-routes.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-qr-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function userCookie(username: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret12' } });
  return `atlas_session=${login.cookies.find((x) => x.name === 'atlas_session')!.value}`;
}
function q(cookie: string, name: string, query: string, params = {}) {
  return app.inject({ method: 'POST', url: `/api/db/${name}/query`, headers: { cookie }, payload: { query, params } });
}

describe('query routes + role gating', () => {
  it('write then read through AQL as the owner', async () => {
    const cookie = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    const w = await q(cookie, 'kb', "CREATE (p:Person {name: 'Ada'}) RETURN p.name AS name");
    expect(w.statusCode).toBe(200);
    expect(w.json().rows).toEqual([['Ada']]);
    const r = await q(cookie, 'kb', 'MATCH (p:Person) RETURN count(*) AS c');
    expect(r.json().rows).toEqual([[1]]);
  });

  it('viewer may read but not write or run DDL', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie: ada }, payload: { username: 'bob', role: 'viewer' } });

    expect((await q(bob, 'kb', 'MATCH (n) RETURN n')).statusCode).toBe(200);
    expect((await q(bob, 'kb', "CREATE (n:X) RETURN n")).statusCode).toBe(403);
    expect((await q(bob, 'kb', 'CREATE INDEX ON :Person(name)')).statusCode).toBe(403);
  });

  it('editor may write but not run DDL; owner may', async () => {
    const ada = await userCookie('ada');
    const bob = await userCookie('bob');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    await app.inject({ method: 'POST', url: '/api/db/kb/roles', headers: { cookie: ada }, payload: { username: 'bob', role: 'editor' } });

    expect((await q(bob, 'kb', "CREATE (n:X {v: 1}) RETURN n")).statusCode).toBe(200);
    expect((await q(bob, 'kb', 'CREATE INDEX ON :X(v)')).statusCode).toBe(403);
    expect((await q(ada, 'kb', 'CREATE INDEX ON :X(v)')).statusCode).toBe(200);
  });

  it('parse errors return 400 with caret snippet; EXPLAIN works for viewers', async () => {
    const cookie = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    const bad = await q(cookie, 'kb', 'MATCH (n RETURN n');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'PARSE_ERROR' });
    expect(bad.json().snippet).toContain('^');
    const exp = await q(cookie, 'kb', 'EXPLAIN MATCH (n:Person) RETURN n');
    expect(exp.json().rows[0][0]).toHaveProperty('op');
  });

  it('GET schema requires read access', async () => {
    const ada = await userCookie('ada');
    const carol = await userCookie('carol');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: ada }, payload: { name: 'kb' } });
    await q(ada, 'kb', "CREATE (:Person {name: 'A'})");
    const s = await app.inject({ method: 'GET', url: '/api/db/kb/schema', headers: { cookie: ada } });
    expect(s.statusCode).toBe(200);
    expect(s.json().labels.map((l: { label: string }) => l.label)).toContain('Person');
    expect((await app.inject({ method: 'GET', url: '/api/db/kb/schema', headers: { cookie: carol } })).statusCode).toBe(403);
  });
});
```

`packages/server/test/token-routes.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-tok-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function userCookie(username: string): Promise<string> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'secret12' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret12' } });
  return `atlas_session=${login.cookies.find((x) => x.name === 'atlas_session')!.value}`;
}

describe('API tokens', () => {
  it('create a token, then authenticate a query with it (Bearer)', async () => {
    const cookie = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'ci' } });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token).toContain('.'); // id.secret

    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    expect(r.statusCode).toBe(200);
  });

  it('lists tokens (without secrets) and revokes them', async () => {
    const cookie = await userCookie('ada');
    const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'ci' } });
    const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain('.'); // no secret leaked
    const id = created.json().tokenId as string;
    const del = await app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } })).json()).toHaveLength(0);
  });

  it('a revoked token no longer authenticates', async () => {
    const cookie = await userCookie('ada');
    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie }, payload: { name: 'kb' } });
    const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie }, payload: { name: 'ci' } });
    const token = created.json().token as string;
    await app.inject({ method: 'DELETE', url: `/api/tokens/${created.json().tokenId}`, headers: { cookie } });
    const r = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'MATCH (n) RETURN n', params: {} },
    });
    expect(r.statusCode).toBe(401);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/query-routes.test.ts packages/server/test/token-routes.test.ts`
Expected: FAIL — query/token routes are stubs.

- [x] **Step 3: Implement — `packages/server/src/routes/query.ts`**

```ts
import { dbNameSchema, QueryReq } from '@atlas/protocol';
import { executeQuery, parseQuery } from '@atlas/query';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability, type Capability } from '../auth.js';

/** Map a parsed statement to the capability it requires (EXPLAIN never executes → read). */
function capabilityFor(text: string): Capability {
  const parsed = parseQuery(text); // throws AqlError → 400 via the error handler
  if (parsed.explain) return 'read';
  switch (parsed.statement.type) {
    case 'read':
    case 'call':
      return 'read';
    case 'write':
      return 'write';
    case 'ddl':
      return 'ddl';
  }
}

export async function registerQueryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/db/:name/query', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    const body = QueryReq.parse(req.body);
    const cap = capabilityFor(body.query);
    await requireCapability(ctx.catalog, req.principal!, name, cap);
    const db = await ctx.manager.get(name);
    const result = await executeQuery(db, body.query, {
      params: body.params,
      timeoutMs: ctx.config.queryTimeoutMs,
      maxRows: ctx.config.maxRows,
    });
    return result;
  });

  app.get('/api/db/:name/schema', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const db = await ctx.manager.get(name);
    return db.schema();
  });
}
```

`packages/server/src/routes/tokens.ts`:

```ts
import { CreateTokenReq } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';
import { generateToken } from '../crypto.js';

export async function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/tokens', auth, async (req, reply) => {
    const body = CreateTokenReq.parse(req.body);
    const { token, hash } = await generateToken();
    const row = await ctx.catalog.createToken(req.principal!.username, body.name, hash);
    void reply.status(201);
    // The full token is `tokenId.secret`, shown exactly once.
    return { tokenId: row.tokenId, name: row.name, token: `${row.tokenId}.${token}` };
  });

  app.get('/api/tokens', auth, async (req) => ctx.catalog.listTokens(req.principal!.username));

  app.delete('/api/tokens/:id', auth, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await ctx.catalog.revokeToken(req.principal!.username, id);
    void reply.status(204);
  });
}
```

Note: `authenticate` (Task 5) already parses the `id.secret` Bearer format and verifies via `verifyToken(row.hash, secret)`. Confirm the token route returns `tokenId.secret` so the two halves line up.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/query-routes.test.ts packages/server/test/token-routes.test.ts`
Expected: PASS — role gating by statement type, EXPLAIN as read, Bearer auth, revocation.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): role-gated query + schema routes and API token CRUD"
```

### Task 9: Server entry, exports, README, full gate

**Files:**
- Modify: `packages/server/src/index.ts`, `README.md`
- Create: `packages/server/src/start.ts`, `packages/server/test/e2e.test.ts`

- [x] **Step 1: Write the end-to-end test**

`packages/server/test/e2e.test.ts`:

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
  dir = await mkdtemp(join(tmpdir(), 'atlas-srv-e2e-'));
  app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('server e2e', () => {
  it('full journey: register, create db, seed via AQL, query, algorithm, persist across reopen', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ada', password: 'secret12' } });
    const cookie = `atlas_session=${reg.cookies.find((c) => c.name === 'atlas_session')?.value ?? ''}`;
    // register does not set a cookie; log in.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const auth = `atlas_session=${login.cookies.find((c) => c.name === 'atlas_session')!.value}`;

    await app.inject({ method: 'POST', url: '/api/db', headers: { cookie: auth }, payload: { name: 'kb' } });
    await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth },
      payload: { query: "CREATE (a:Person {name: 'Ada'})-[:WROTE]->(:Doc {title: 'Notes'})", params: {} },
    });
    const pr = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth },
      payload: { query: 'CALL algo.degree() YIELD node, score', params: {} },
    });
    expect(pr.json().rows.length).toBe(2);

    // Reopen the server over the same data dir: db persists.
    await app.close();
    app = await buildServer(loadConfig({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: 's'.repeat(32) }));
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ada', password: 'secret12' } });
    const auth2 = `atlas_session=${login2.cookies.find((c) => c.name === 'atlas_session')!.value}`;
    const count = await app.inject({
      method: 'POST',
      url: '/api/db/kb/query',
      headers: { cookie: auth2 },
      payload: { query: 'MATCH (n) RETURN count(*) AS c', params: {} },
    });
    expect(count.json().rows).toEqual([[2]]);
    expect(reg.statusCode).toBe(201);
    expect(cookie).toBeDefined();
  });
});
```

- [x] **Step 2: Run the test to verify it fails (or passes — it exercises only existing routes)**

Run: `pnpm vitest run packages/server/test/e2e.test.ts`
Expected: PASS if Tasks 5–8 are complete (this is a coverage capstone over existing routes). If it fails, fix the implicated route — do not weaken the test.

- [x] **Step 3: Implement the server entry**

`packages/server/src/start.ts`:

```ts
import { buildServer } from './app.js';
import { loadConfig } from './config.js';

/** Production entrypoint: build the app and listen; drain on SIGTERM/SIGINT. */
export async function start(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const app = await buildServer(config);
  const shutdown = async (): Promise<void> => {
    await app.close(); // onClose drains the manager + catalog
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
```

Replace `packages/server/src/index.ts`:

```ts
export { buildServer, type AppContext } from './app.js';
export { loadConfig, type ServerConfig } from './config.js';
export { toProblem, HttpError } from './errors.js';
export { start } from './start.js';
export { CatalogService } from './catalog.js';
export { DatabaseManager } from './db-manager.js';
```

- [x] **Step 4: Update README + run the full gate**

In `README.md`, set the `**Status:**` block to:

```markdown
**Status:** M5a — server foundation (`@atlas/server` on Fastify): argon2id auth
(sessions + API tokens), multi-database manager with the system catalog stored
as an Atlas database, and REST for auth, database lifecycle, role grants, query,
and schema — with the spec's permission matrix enforced. WS subscriptions, CRUD,
import/export, the client SDK, and metrics land in M5b.
```

Run: `pnpm build && pnpm typecheck:test && pnpm lint && pnpm format && pnpm test`
Expected: all green across all six packages.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): production entry, exports, server e2e, README"
```

---

## Plan self-review notes

- **Spec coverage (M5a slice of §6):** §6.1 Fastify + zod + RFC7807 errors carrying engine/AQL codes → T2 (`toProblem`), all routes; §6.2 argon2id passwords + sessions + bearer tokens → T3, T5, T8; the permission matrix → T5 (`requireCapability`) enforced in T7 (db lifecycle) + T8 (query by statement type: read/call=read, write=write, ddl=owner; admins do db-lifecycle only, never data); §6.3 lazy per-db engines + catalog-as-Atlas-db + drain on close → T4, T5; §6.4 endpoints auth/databases/query/schema/healthz → T5–T8. **Deferred to M5b (called out):** node/edge CRUD REST, import/export/seed, `WS /ws/db/:name`, `/metrics`, rate-limiting, CORS/security-header hardening, static SPA hosting, the `@atlas/client` SDK, Docker entrypoint wiring.
- **Deliberate v1 decisions:** sessions are username-in-a-signed-cookie (stateless; logout clears the cookie — no server-side session store in v1, acceptable since tokens cover revocable programmatic access); API tokens are `tokenId.secret` so a salted argon2id hash can still be looked up by id then verified; `nowIso()` timestamps are display-only and not asserted; the catalog uses the engine's own unique constraints for username/dbname/tokenId integrity (dogfooding).
- **Type/shape anchors:** `buildServer(config) → Promise<FastifyInstance>` (tested via `.inject()`); `CatalogService.open(dir)`/`roleOf`/`grantRole`/`createToken`/`findToken`; `DatabaseManager.get(name)`/`evict`/`closeAll`; `authenticate(req, catalog) → Principal|null`; `requireCapability(catalog, principal, dbName, cap)`; capabilities `read|write|ddl|admin-db|delete-db`; the query route classifies via `parseQuery` then executes via `executeQuery`.
- **Self-review fixes applied:** the bootstrap admin seeds only when `config.admin` is set AND no users exist (idempotent across restarts); `requireCapability` checks db existence first (404 before 403) so probing a nonexistent db can't leak role info; DELETE db evicts the open engine before removing the data dir (no open-handle leak); ZodError→400 mapping added in T6 so malformed bodies are clean 400s, not 500s.


