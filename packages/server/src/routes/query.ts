import { dbNameSchema, QueryReq } from '@atlas/protocol';
import { executeQuery, parseQuery } from '@atlas/query';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability, type Capability } from '../auth.js';

/** Map a parsed statement to the capability it requires (EXPLAIN never executes → read). */
function capabilityFor(text: string): Capability {
  const parsed = parseQuery(text); // throws AqlError → 400 via the error handler
  if (parsed.explain) return 'read';
  switch (parsed.statement.type) {
    case 'read':
    case 'call':
      return 'read';
    case 'write':
      return 'write';
    case 'ddl':
      return 'ddl';
  }
}

export async function registerQueryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/db/:name/query', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    const body = QueryReq.parse(req.body);
    const cap = capabilityFor(body.query);
    await requireCapability(ctx.catalog, req.principal!, name, cap);
    const db = await ctx.manager.get(name);
    const result = await executeQuery(db, body.query, {
      params: body.params,
      timeoutMs: ctx.config.queryTimeoutMs,
      maxRows: ctx.config.maxRows,
    });
    return result;
  });

  app.get('/api/db/:name/schema', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const db = await ctx.manager.get(name);
    return db.schema();
  });
}
