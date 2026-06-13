import { LoginReq, type UserInfo } from '@atlas/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { verifyPassword } from '../crypto.js';
import { HttpError } from '../errors.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginReq.parse(req.body);
    const user = await ctx.catalog.findUser(body.username);
    if (!user || !(await verifyPassword(user.passwordHash, body.password)))
      throw new HttpError(401, 'UNAUTHENTICATED', 'invalid username or password');
    void reply.setCookie('atlas_session', user.username, {
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      path: '/',
    });
    const info: UserInfo = { username: user.username, isAdmin: user.isAdmin };
    return info;
  });
}
