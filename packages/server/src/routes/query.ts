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
    // capabilityFor parses the query; a parse error here is a query failure, so it
    // is metered below. Compute the capability eagerly to gate authorization, but
    // re-throw inside the metered block if parsing failed.
    let cap: Capability;
    try {
      cap = capabilityFor(body.query);
    } catch (parseErr) {
      ctx.metrics.queriesTotal.inc();
      ctx.metrics.queryErrorsTotal.inc();
      throw parseErr; // AqlError → 400 via the error handler
    }
    await requireCapability(ctx.catalog, req.principal!, name, cap);
    const db = await ctx.manager.get(name);
    let ok = false;
    try {
      const result = await executeQuery(db, body.query, {
        params: body.params,
        timeoutMs: ctx.config.queryTimeoutMs,
        maxRows: ctx.config.maxRows,
      });
      ok = true;
      ctx.metrics.queryLatencyMs.observe(result.stats.elapsedMs);
      // Audit only successful write statements (never reads); after the mutation commits.
      if (cap === 'write')
        await ctx.catalog.recordAudit({
          username: req.principal!.username,
          action: 'query:write',
          target: name,
        });
      return result;
    } finally {
      ctx.metrics.queriesTotal.inc();
      if (!ok) ctx.metrics.queryErrorsTotal.inc();
    }
  });

  app.get('/api/db/:name/schema', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const db = await ctx.manager.get(name);
    return db.schema();
  });
}
