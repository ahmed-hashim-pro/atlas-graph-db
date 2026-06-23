import type {
  AuditEntry,
  DbInfo,
  ImportReq,
  ImportResult,
  ProblemDetails,
  QueryResponse,
  RoleName,
  SubscribeFilter,
  UserInfo,
  UserSummary,
  WsFrame,
} from '@atlas/protocol';
import type { SchemaSummary } from '@atlas/core';

export type { AuditEntry, UserSummary } from '@atlas/protocol';

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

/**
 * A minimal per-connection cookie jar. In the browser, cookies set by `login()` are persisted
 * and replayed automatically by the platform; in non-browser runtimes (Node's `fetch`/undici,
 * tests) there is no shared jar, so a cookie-mode client keeps its own. Bearer mode never uses
 * it. The jar is shared between an `AtlasClient` and every `Database` it creates, so a query
 * issued after `login()` carries the session cookie.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Capture `Set-Cookie` headers from a response, applying clear-on-empty semantics. */
  capture(res: Response): void {
    const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const lines =
      typeof getSetCookie === 'function'
        ? getSetCookie.call(res.headers)
        : ((): string[] => {
            const raw = res.headers.get('set-cookie');
            return raw ? [raw] : [];
          })();
    for (const line of lines) {
      const pair = line.split(';', 1)[0]!;
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** The `Cookie` request header value, or `undefined` when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function buildHeaders(
  opts: ConnectOptions,
  hasBody: boolean,
  jar: CookieJar,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (opts.mode === 'cookie') {
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
  } else if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  return headers;
}

function fetchInit(opts: ConnectOptions, init: RequestInit): RequestInit {
  return opts.mode === 'cookie' ? { ...init, credentials: 'include' } : init;
}

/** A `fetch` that, in cookie mode, replays and captures the connection's cookie jar. */
async function request(
  opts: ConnectOptions,
  jar: CookieJar,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, fetchInit(opts, init));
  if (opts.mode === 'cookie') jar.capture(res);
  return res;
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
    private readonly jar: CookieJar,
  ) {}

  async query(aql: string, params: Record<string, unknown> = {}): Promise<QueryResponse> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${this.name}/query`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ query: aql, params }),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as QueryResponse;
  }

  /** Introspected schema summary for this database (`GET /api/db/:name/schema`). */
  async schema(): Promise<SchemaSummary> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${this.name}/schema`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
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
  private readonly jar = new CookieJar();

  constructor(
    private readonly baseUrl: string,
    private readonly opts: ConnectOptions,
  ) {}

  database(name: string): Database {
    return new Database(this.baseUrl, name, this.opts, this.jar);
  }

  // ---- auth ----
  async register(username: string, password: string): Promise<UserInfo> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  async login(username: string, password: string): Promise<UserInfo> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  async logout(): Promise<void> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
  }

  /** Current user, or `null` when unauthenticated (401 → null, never throws on 401). */
  async whoami(): Promise<UserInfo | null> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/auth/whoami`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (res.status === 401) return null;
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserInfo;
  }

  // ---- databases ----
  async listDatabases(): Promise<DbSummary[]> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as DbSummary[];
  }

  async createDatabase(name: string): Promise<{ name: string }> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as { name: string };
  }

  async getDatabase(name: string): Promise<DbInfo> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${name}`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as DbInfo;
  }

  /** Update a database's settings (currently its description); requires `admin-db`. */
  async patchDatabase(name: string, patch: { description?: string }): Promise<void> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/db/${name}`, {
      method: 'PATCH',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await readError(res);
  }

  async seed(name: string, dataset: string): Promise<SeedResult> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/db/${name}/seed/${dataset}`,
      {
        method: 'POST',
        headers: buildHeaders(this.opts, false, this.jar),
      },
    );
    if (!res.ok) throw await readError(res);
    return (await res.json()) as SeedResult;
  }

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

  // ---- user administration (server-admin only, enforced server-side) ----
  async listUsers(): Promise<UserSummary[]> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/users`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as UserSummary[];
  }

  async createUser(username: string, password: string, isAdmin = false): Promise<void> {
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/users`, {
      method: 'POST',
      headers: buildHeaders(this.opts, true, this.jar),
      body: JSON.stringify({ username, password, isAdmin }),
    });
    if (!res.ok) throw await readError(res);
  }

  async updateUser(username: string, patch: { isAdmin: boolean }): Promise<void> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/users/${encodeURIComponent(username)}`,
      {
        method: 'PATCH',
        headers: buildHeaders(this.opts, true, this.jar),
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) throw await readError(res);
  }

  async resetUserPassword(username: string, password: string): Promise<void> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/users/${encodeURIComponent(username)}/password`,
      {
        method: 'POST',
        headers: buildHeaders(this.opts, true, this.jar),
        body: JSON.stringify({ password }),
      },
    );
    if (!res.ok) throw await readError(res);
  }

  async deleteUser(username: string): Promise<void> {
    const res = await request(
      this.opts,
      this.jar,
      `${this.baseUrl}/api/users/${encodeURIComponent(username)}`,
      { method: 'DELETE', headers: buildHeaders(this.opts, false, this.jar) },
    );
    if (!res.ok) throw await readError(res);
  }

  // ---- audit log (server-admin only, enforced server-side) ----
  async listAudit(limit?: number): Promise<AuditEntry[]> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    const res = await request(this.opts, this.jar, `${this.baseUrl}/api/audit${qs}`, {
      method: 'GET',
      headers: buildHeaders(this.opts, false, this.jar),
    });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as AuditEntry[];
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
}

export function connect(url: string, opts: ConnectOptions = {}): AtlasClient {
  return new AtlasClient(url.replace(/\/$/, ''), opts);
}
