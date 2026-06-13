import { CreateTokenReq } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';
import { generateToken } from '../crypto.js';
import { HttpError } from '../errors.js';

// Token ids are random base64url strings; bound length to keep the validation
// pattern uniform with the db-name routes and reject empty/oversized input.
const tokenIdSchema = z.string().min(1).max(64);

export async function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/tokens', auth, async (req, reply) => {
    const body = CreateTokenReq.parse(req.body);
    const { token, hash } = await generateToken();
    const row = await ctx.catalog.createToken(req.principal!.username, body.name, hash);
    void reply.status(201);
    // The full token is `tokenId.secret`, shown exactly once.
    return { tokenId: row.tokenId, name: row.name, token: `${row.tokenId}.${token}` };
  });

  app.get('/api/tokens', auth, async (req) => ctx.catalog.listTokens(req.principal!.username));

  app.delete('/api/tokens/:id', auth, async (req, reply) => {
    const id = tokenIdSchema.parse((req.params as { id: string }).id);
    // revokeToken enforces ownership: it only deletes a token belonging to the
    // caller. A 404 (not 403) for an unowned/missing id avoids confirming
    // whether some other user's token id exists.
    const revoked = await ctx.catalog.revokeToken(req.principal!.username, id);
    if (!revoked) throw new HttpError(404, 'NOT_FOUND', `token "${id}" not found`);
    void reply.status(204);
  });
}
