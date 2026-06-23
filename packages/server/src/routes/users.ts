import {
  CreateUserReq,
  ResetPasswordReq,
  UpdateUserReq,
  usernameSchema,
  type UserSummary,
} from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAdmin } from '../auth.js';
import { hashPassword } from '../crypto.js';
import { HttpError } from '../errors.js';

/** Number of users that currently hold the admin flag. */
function countAdmins(users: UserSummary[]): number {
  return users.filter((u) => u.isAdmin).length;
}

export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = { preHandler: requireAdmin(ctx.catalog) };

  app.get('/api/users', admin, async () => ctx.catalog.listUsers());

  app.post('/api/users', admin, async (req, reply) => {
    const body = CreateUserReq.parse(req.body);
    if (await ctx.catalog.findUser(body.username))
      throw new HttpError(409, 'CONSTRAINT_VIOLATION', `user "${body.username}" already exists`);
    await ctx.catalog.createUser(
      body.username,
      await hashPassword(body.password),
      body.isAdmin ?? false,
    );
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'user:create',
      target: body.username,
    });
    void reply.status(201);
    return { username: body.username };
  });

  app.patch('/api/users/:username', admin, async (req, reply) => {
    const username = usernameSchema.parse((req.params as { username: string }).username);
    const body = UpdateUserReq.parse(req.body);
    const user = await ctx.catalog.findUser(username);
    if (!user) throw new HttpError(404, 'NOT_FOUND', `user "${username}" not found`);
    // Guard: never demote the last remaining admin (would lock out admin access).
    if (user.isAdmin && !body.isAdmin && countAdmins(await ctx.catalog.listUsers()) <= 1)
      throw new HttpError(409, 'CONSTRAINT_VIOLATION', 'cannot demote the last admin');
    await ctx.catalog.setUserAdmin(username, body.isAdmin);
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'user:update',
      target: username,
    });
    void reply.status(204);
  });

  app.post('/api/users/:username/password', admin, async (req, reply) => {
    const username = usernameSchema.parse((req.params as { username: string }).username);
    const body = ResetPasswordReq.parse(req.body);
    if (!(await ctx.catalog.findUser(username)))
      throw new HttpError(404, 'NOT_FOUND', `user "${username}" not found`);
    await ctx.catalog.resetPassword(username, await hashPassword(body.password));
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'user:password-reset',
      target: username,
    });
    void reply.status(204);
  });

  app.delete('/api/users/:username', admin, async (req, reply) => {
    const username = usernameSchema.parse((req.params as { username: string }).username);
    const user = await ctx.catalog.findUser(username);
    if (!user) throw new HttpError(404, 'NOT_FOUND', `user "${username}" not found`);
    // Guard: never delete yourself or the last remaining admin.
    if (username === req.principal!.username)
      throw new HttpError(409, 'CONSTRAINT_VIOLATION', 'cannot delete your own account');
    if (user.isAdmin && countAdmins(await ctx.catalog.listUsers()) <= 1)
      throw new HttpError(409, 'CONSTRAINT_VIOLATION', 'cannot delete the last admin');
    await ctx.catalog.deleteUser(username);
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'user:delete',
      target: username,
    });
    void reply.status(204);
  });
}
