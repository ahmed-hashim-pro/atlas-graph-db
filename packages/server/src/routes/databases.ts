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
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'db:create',
      target: body.name,
    });
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
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'db:patch',
      target: name,
    });
    void reply.status(204);
  });

  app.delete('/api/db/:name', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'delete-db');
    await ctx.manager.evict(name);
    await ctx.catalog.deleteDatabase(name);
    await rm(join(ctx.config.dataDir, 'db', name), { recursive: true, force: true });
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'db:delete',
      target: name,
    });
    void reply.status(204);
  });

  app.post('/api/db/:name/roles', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'admin-db');
    const body = GrantRoleReq.parse(req.body);
    if (!(await ctx.catalog.findUser(body.username)))
      throw new HttpError(404, 'NOT_FOUND', `user "${body.username}" not found`);
    await ctx.catalog.grantRole(body.username, name, body.role);
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'role:grant',
      target: name,
      detail: `${body.username}:${body.role}`,
    });
    void reply.status(204);
  });

  app.delete('/api/db/:name/roles/:user', auth, async (req, reply) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'admin-db');
    const user = (req.params as { user: string }).user;
    await ctx.catalog.revokeRole(user, name);
    await ctx.catalog.recordAudit({
      username: req.principal!.username,
      action: 'role:revoke',
      target: name,
      detail: user,
    });
    void reply.status(204);
  });
}
