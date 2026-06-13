import { openDatabase, type AtlasDatabase, type NodeId } from '@atlas/core';
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
      const have = db
        .listIndexes()
        .some((d) => d.kind === kind && d.label === label && d.property === property);
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
