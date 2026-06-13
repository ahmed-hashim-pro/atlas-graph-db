import type { FastifyRequest } from 'fastify';
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
  // Reuse a principal already resolved earlier in the request lifecycle (e.g. by the
  // rate-limit onRequest hook) so each request authenticates at most once — avoiding a
  // redundant findUser/findToken lookup and, for bearer tokens, a second argon2 verify.
  if (req.principal) return req.principal;
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
  return async (req: FastifyRequest): Promise<void> => {
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
