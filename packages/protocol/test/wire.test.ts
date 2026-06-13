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
