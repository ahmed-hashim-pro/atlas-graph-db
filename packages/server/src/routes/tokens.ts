import { CreateTokenReq } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';
import { generateToken } from '../crypto.js';

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
    const id = (req.params as { id: string }).id;
    await ctx.catalog.revokeToken(req.principal!.username, id);
    void reply.status(204);
  });
}
