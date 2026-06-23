import { dbNameSchema, EdgeCreateReq, NodeCreateReq, NodePatchReq } from '@atlas/protocol';
import { type AtlasDatabase } from '@atlas/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability } from '../auth.js';
import { HttpError } from '../errors.js';

function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'VALIDATION', `invalid id "${raw}"`);
  return n;
}

async function dbFor(
  ctx: AppContext,
  req: FastifyRequest,
  cap: 'read' | 'write',
): Promise<AtlasDatabase> {
  const name = dbNameSchema.parse((req.params as { name: string }).name);
  await requireCapability(ctx.catalog, req.principal!, name, cap);
  return ctx.manager.get(name);
}

/** Record a data-write audit entry (db name as target, the affected id as detail). */
function auditWrite(
  ctx: AppContext,
  req: FastifyRequest,
  action: string,
  detail: string,
): Promise<void> {
  const target = (req.params as { name: string }).name;
  return ctx.catalog.recordAudit({ username: req.principal!.username, action, target, detail });
}

export async function registerDataRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.get('/api/db/:name/nodes/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'read');
    const node = db.getNode(parseId((req.params as { id: string }).id));
    if (!node) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    return { id: node.id, labels: node.labels, properties: node.props };
  });

  app.post('/api/db/:name/nodes', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const body = NodeCreateReq.parse(req.body);
    let id = 0;
    await db.transact((tx) => {
      id = tx.createNode(body.labels, body.properties);
    });
    await auditWrite(ctx, req, 'node:create', `#${id}`);
    void reply.status(201);
    return { id };
  });

  app.patch('/api/db/:name/nodes/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getNode(id)) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    const body = NodePatchReq.parse(req.body);
    await db.transact((tx) => tx.setNodeProps(id, body.set, body.remove));
    await auditWrite(ctx, req, 'node:patch', `#${id}`);
    const node = db.getNode(id)!;
    return { id: node.id, labels: node.labels, properties: node.props };
  });

  app.delete('/api/db/:name/nodes/:id', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getNode(id)) throw new HttpError(404, 'NOT_FOUND', 'node not found');
    const detach = (req.query as { detach?: string }).detach === 'true';
    await db.transact((tx) => tx.deleteNode(id, { detach }));
    await auditWrite(ctx, req, 'node:delete', `#${id}`);
    void reply.status(204);
  });

  app.get('/api/db/:name/edges/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'read');
    const e = db.getEdge(parseId((req.params as { id: string }).id));
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    return { id: e.id, type: e.type, from: e.from, to: e.to, properties: e.props };
  });

  app.post('/api/db/:name/edges', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const body = EdgeCreateReq.parse(req.body);
    if (!db.getNode(body.from) || !db.getNode(body.to))
      throw new HttpError(404, 'NOT_FOUND', 'edge endpoint node not found');
    let id = 0;
    await db.transact((tx) => {
      id = tx.createEdge(body.type, body.from, body.to, body.properties);
    });
    await auditWrite(ctx, req, 'edge:create', `#${id}`);
    void reply.status(201);
    return { id };
  });

  app.patch('/api/db/:name/edges/:id', auth, async (req) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getEdge(id)) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    const body = NodePatchReq.parse(req.body);
    await db.transact((tx) => tx.setEdgeProps(id, body.set, body.remove));
    await auditWrite(ctx, req, 'edge:patch', `#${id}`);
    const e = db.getEdge(id)!;
    return { id: e.id, type: e.type, from: e.from, to: e.to, properties: e.props };
  });

  app.delete('/api/db/:name/edges/:id', auth, async (req, reply) => {
    const db = await dbFor(ctx, req, 'write');
    const id = parseId((req.params as { id: string }).id);
    if (!db.getEdge(id)) throw new HttpError(404, 'NOT_FOUND', 'edge not found');
    await db.transact((tx) => tx.deleteEdge(id));
    await auditWrite(ctx, req, 'edge:delete', `#${id}`);
    void reply.status(204);
  });
}
