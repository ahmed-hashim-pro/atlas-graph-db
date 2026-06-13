import type { Op } from '@atlas/core';
import { dbNameSchema, type WsFrame } from '@atlas/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { AppContext } from '../app.js';
import { authenticate, requireCapability } from '../auth.js';
import { HttpError } from '../errors.js';

/** Does this batch touch any node carrying a wanted label or any wanted edge type? */
function batchMatches(ops: Op[], labels: Set<string> | null, types: Set<string> | null): boolean {
  if (!labels && !types) return true;
  for (const op of ops) {
    if (labels && op.op === 'createNode' && op.labels.some((l) => labels.has(l))) return true;
    if (types && op.op === 'createEdge' && types.has(op.type)) return true;
    // setNodeProps/deleteNode/deleteEdge carry no label/type; conservatively included only
    // when no filter is set (handled above) — filtered subscriptions see create-shaped ops.
  }
  return false;
}

export async function registerWsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Authenticate before the WS upgrade so unauthenticated connections are rejected at the
  // handshake (the client never sees `open`). Errors thrown in preValidation use Fastify's
  // normal error handling, which aborts the upgrade.
  const preValidation = async (req: FastifyRequest): Promise<void> => {
    // Token may arrive via ?token= (browsers can't set WS headers) or Authorization.
    const tokenQ = (req.query as { token?: string }).token;
    if (tokenQ) req.headers.authorization = `Bearer ${tokenQ}`;
    const principal = await authenticate(req, ctx.catalog);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
    req.principal = principal;
  };

  app.get('/ws/db/:name', { websocket: true, preValidation }, async (socket: WebSocket, req) => {
    const send = (frame: WsFrame): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    const principal = req.principal!;
    let name: string;
    try {
      name = dbNameSchema.parse((req.params as { name: string }).name);
      await requireCapability(ctx.catalog, principal, name, 'read');
    } catch (err) {
      send({ type: 'error', code: 'FORBIDDEN', message: (err as Error).message });
      socket.close();
      return;
    }
    const q = req.query as { labels?: string; types?: string };
    const labels = q.labels ? new Set(q.labels.split(',').filter(Boolean)) : null;
    const types = q.types ? new Set(q.types.split(',').filter(Boolean)) : null;

    const db = await ctx.manager.get(name);
    ctx.metrics.wsSubscribers.inc();
    const unsubscribe = db.subscribe((e) => {
      if (e.type === 'resync_required') {
        send({ type: 'resync_required' });
        socket.close();
        return;
      }
      if (batchMatches(e.ops, labels, types)) send({ type: 'batch', txId: e.txId, ops: e.ops });
    });
    send({ type: 'ready' });
    socket.on('close', () => {
      unsubscribe();
      ctx.metrics.wsSubscribers.dec();
    });
  });
}
