import { ListAuditQuery } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAdmin } from '../auth.js';

export async function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = { preHandler: requireAdmin(ctx.catalog) };

  app.get('/api/audit', admin, async (req) => {
    const { limit } = ListAuditQuery.parse(req.query);
    return ctx.catalog.listAudit(limit);
  });
}
