import { AtlasError, openDatabase, type AtlasDatabase, type NodeId } from '@atlas/core';
import type { AuditEntry, RoleName, UserSummary } from '@atlas/protocol';
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
  /** Monotonic audit sequence, seeded at open() from the current max and incremented per record. */
  #auditSeq: number;

  private constructor(
    private readonly db: AtlasDatabase,
    auditSeq: number,
  ) {
    this.#auditSeq = auditSeq;
  }

  static async open(dir: string): Promise<CatalogService> {
    const db = await openDatabase(dir);
    // Idempotent constraint setup.
    const ensure = async (kind: 'unique', label: string, property: string): Promise<void> => {
      const have = db
        .listIndexes()
        .some((d) => d.kind === kind && d.label === label && d.property === property);
      if (!have) await db.createIndex({ kind, label, property });
    };
    await ensure('unique', 'User', 'username');
    await ensure('unique', 'Database', 'name');
    await ensure('unique', 'Token', 'tokenId');
    await ensure('unique', 'Session', 'sid');
    await ensure('unique', 'Audit', 'seq');
    // Seed the in-memory seq counter from the highest persisted audit seq (0 if none).
    let maxSeq = 0;
    for (const n of db.nodesByLabel('Audit')) {
      const seq = Number(n.props.seq);
      if (seq > maxSeq) maxSeq = seq;
    }
    return new CatalogService(db, maxSeq);
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

  /** All users (no password hashes), sorted by username — backs the admin user list. */
  async listUsers(): Promise<UserSummary[]> {
    return [...this.db.nodesByLabel('User')]
      .map((n) => ({
        username: String(n.props.username),
        isAdmin: n.props.isAdmin === true,
        createdAt: String(n.props.createdAt ?? ''),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async deleteUser(username: string): Promise<void> {
    const user = this.userNode(username);
    if (!user) return;
    // The last-admin check and the delete must be atomic. Both run inside the
    // single-writer transact callback (reading committed state), so two
    // concurrent deletes of distinct admins can't both observe a safe count and
    // leave zero admins. Sessions are revoked only after the node is gone.
    await this.db.transact((tx) => {
      if (this.db.getNode(user.id)?.props.isAdmin === true && this.#adminCount() <= 1)
        throw new AtlasError('CONSTRAINT_VIOLATION', 'cannot delete the last admin');
      tx.deleteNode(user.id, { detach: true });
    });
    await this.deleteSessionsForUser(username);
  }

  async setUserAdmin(username: string, isAdmin: boolean): Promise<void> {
    const user = this.userNode(username);
    if (!user) return;
    // Atomic last-admin guard (see deleteUser): count admins from committed
    // state inside the write-queue callback so concurrent demotes can't race.
    await this.db.transact((tx) => {
      if (!isAdmin && this.db.getNode(user.id)?.props.isAdmin === true && this.#adminCount() <= 1)
        throw new AtlasError('CONSTRAINT_VIOLATION', 'cannot demote the last admin');
      tx.setNodeProps(user.id, { isAdmin });
    });
  }

  /** Count users currently holding the admin flag (committed state). */
  #adminCount(): number {
    let count = 0;
    for (const u of this.db.nodesByLabel('User')) if (u.props.isAdmin === true) count++;
    return count;
  }

  /** Replace a user's password hash and revoke all their sessions (a credential change). */
  async resetPassword(username: string, passwordHash: string): Promise<void> {
    const user = this.userNode(username);
    if (!user) return;
    await this.db.transact((tx) => tx.setNodeProps(user.id, { passwordHash }));
    await this.deleteSessionsForUser(username);
  }

  // ---- audit log (write-op trail; stored as catalog nodes) ----
  /** Append an audit entry with a real timestamp and the next monotonic seq. */
  async recordAudit(entry: {
    username: string;
    action: string;
    target: string;
    detail?: string;
  }): Promise<void> {
    const seq = ++this.#auditSeq;
    const props: Record<string, string | number> = {
      seq,
      at: new Date().toISOString(),
      username: entry.username,
      action: entry.action,
      target: entry.target,
    };
    if (entry.detail !== undefined) props.detail = entry.detail;
    await this.db.transact((tx) => {
      tx.createNode(['Audit'], props);
    });
  }

  /**
   * Best-effort audit append for request handlers. The audit trail must never
   * turn an already-committed write into a client-visible failure (which would
   * mislead a client into retrying a mutation that actually succeeded), so a
   * recording error is logged and swallowed rather than propagated. Tests that
   * must observe failures call recordAudit directly.
   */
  async tryRecordAudit(entry: {
    username: string;
    action: string;
    target: string;
    detail?: string;
  }): Promise<void> {
    try {
      await this.recordAudit(entry);
    } catch (err) {
      console.error(`audit: failed to record ${entry.action} on ${entry.target}:`, err);
    }
  }

  /** The most recent audit entries (highest seq first), capped at `limit`. */
  async listAudit(limit: number): Promise<AuditEntry[]> {
    return [...this.db.nodesByLabel('Audit')]
      .map((n) => {
        const e: AuditEntry = {
          seq: Number(n.props.seq),
          at: String(n.props.at),
          username: String(n.props.username),
          action: String(n.props.action),
          target: String(n.props.target),
        };
        if (n.props.detail !== undefined) e.detail = String(n.props.detail);
        return e;
      })
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit);
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
        for (const e of this.db.outEdges(user.id, edgeType))
          if (e.to === dbNode.id) tx.deleteEdge(e.id);
      tx.createEdge(ROLE_EDGE[role], user.id, dbNode.id);
    });
  }

  async revokeRole(username: string, dbName: string): Promise<void> {
    const user = this.userNode(username);
    const dbNode = this.dbNode(dbName);
    if (!user || !dbNode) return;
    await this.db.transact((tx) => {
      for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
        for (const e of this.db.outEdges(user.id, edgeType))
          if (e.to === dbNode.id) tx.deleteEdge(e.id);
    });
  }

  async roleOf(username: string, dbName: string): Promise<RoleName | null> {
    const user = this.userNode(username);
    const dbNode = this.dbNode(dbName);
    if (!user || !dbNode) return null;
    for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
      for (const e of this.db.outEdges(user.id, edgeType))
        if (e.to === dbNode.id) return EDGE_ROLE[edgeType]!;
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

  async listDatabasesFor(
    username: string,
  ): Promise<{ name: string; description: string; role: RoleName }[]> {
    const user = this.userNode(username);
    if (!user) return [];
    const out: { name: string; description: string; role: RoleName }[] = [];
    for (const edgeType of ['OWNER', 'EDITOR', 'VIEWER'])
      for (const e of this.db.outEdges(user.id, edgeType)) {
        const d = this.db.getNode(e.to);
        if (d)
          out.push({
            name: String(d.props.name),
            description: String(d.props.description ?? ''),
            role: EDGE_ROLE[edgeType]!,
          });
      }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** M5b seam: backs the server-admin "list all databases" view (no consumer in M5a). */
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

  /**
   * Revoke a token, but only if it is owned by `username`. Returns true when a
   * token was deleted, false when no token owned by the caller matched the id
   * (either it does not exist or it belongs to another user). Ownership is
   * enforced here — never trust the token id alone, since ids are returned in
   * API responses and are not secret (prevents cross-user IDOR revocation).
   */
  async revokeToken(username: string, tokenId: string): Promise<boolean> {
    const t = this.tokenNode(tokenId);
    if (!t) return false;
    let owner = '';
    for (const e of this.db.inEdges(t.id, 'HAS_TOKEN')) {
      const u = this.db.getNode(e.from);
      if (u) owner = String(u.props.username);
    }
    if (owner !== username) return false;
    await this.db.transact((tx) => tx.deleteNode(t.id, { detach: true }));
    return true;
  }

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

  // ---- private node lookups (use the unique index via the fluent API) ----
  private userNode(username: string) {
    return (
      this.db
        .graph()
        .nodes('User')
        .where((p) => p.username === username)
        .first() ?? null
    );
  }
  private dbNode(name: string) {
    return (
      this.db
        .graph()
        .nodes('Database')
        .where((p) => p.name === name)
        .first() ?? null
    );
  }
  private tokenNode(tokenId: string) {
    return (
      this.db
        .graph()
        .nodes('Token')
        .where((p) => p.tokenId === tokenId)
        .first() ?? null
    );
  }
  private sessionNode(sid: string) {
    return (
      this.db
        .graph()
        .nodes('Session')
        .where((p) => p.sid === sid)
        .first() ?? null
    );
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
