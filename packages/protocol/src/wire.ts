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
