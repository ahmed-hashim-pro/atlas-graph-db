import { LoginReq, RegisterReq, type UserInfo } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth } from '../auth.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { HttpError } from '../errors.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const body = RegisterReq.parse(req.body);
    await ctx.catalog.createUser(body.username, await hashPassword(body.password), false);
    void reply.status(201);
    const info: UserInfo = { username: body.username, isAdmin: false };
    return info;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginReq.parse(req.body);
    const user = await ctx.catalog.findUser(body.username);
    if (!user || !(await verifyPassword(user.passwordHash, body.password)))
      throw new HttpError(401, 'UNAUTHENTICATED', 'invalid username or password');
    const sid = await ctx.catalog.createSession(user.username);
    void reply.setCookie('atlas_session', sid, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
    });
    const info: UserInfo = { username: user.username, isAdmin: user.isAdmin };
    return info;
  });

  app.get('/api/auth/whoami', { preHandler: requireAuth(ctx.catalog) }, async (req) => {
    const info: UserInfo = { username: req.principal!.username, isAdmin: req.principal!.isAdmin };
    return info;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies?.atlas_session;
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await ctx.catalog.deleteSession(unsigned.value);
    }
    void reply.clearCookie('atlas_session', { path: '/' });
    return { ok: true };
  });
}
