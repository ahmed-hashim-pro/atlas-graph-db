import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';

export async function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/db', { preHandler: requireAuth(ctx.catalog) }, async (req) => {
    return ctx.catalog.listDatabasesFor(req.principal!.username);
  });
}
