import { z } from 'zod';

/** DB names are filesystem path segments — keep them a strict safe slug. */
export const dbNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'must be alphanumeric with - or _, not starting with - or _',
  );

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
  stats: {
    rowsExamined: number;
    elapsedMs: number;
    created?: number;
    deleted?: number;
    propsSet?: number;
  };
}

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
