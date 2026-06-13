import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { CatalogService } from './catalog.js';
import { hashPassword } from './crypto.js';
import { DatabaseManager } from './db-manager.js';
import { toProblem } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDatabaseRoutes } from './routes/databases.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerTokenRoutes } from './routes/tokens.js';

export interface AppContext {
  catalog: CatalogService;
  manager: DatabaseManager;
  config: ServerConfig;
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { join } = await import('node:path');
  const catalog = await CatalogService.open(join(config.dataDir, '_catalog'));
  const manager = new DatabaseManager(config.dataDir);
  const ctx: AppContext = { catalog, manager, config };

  await app.register(fastifyCookie, { secret: config.secret });

  // Uniform problem-details for thrown errors and 404s.
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toProblem(err);
    void reply.status(status).type('application/problem+json').send(body);
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).type('application/problem+json').send({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, ctx);
  await registerDatabaseRoutes(app, ctx);
  await registerQueryRoutes(app, ctx);
  await registerTokenRoutes(app, ctx);

  // Bootstrap admin once, if configured and no users exist yet.
  if (config.admin && !(await catalog.anyUserExists()))
    await catalog.createUser(
      config.admin.username,
      await hashPassword(config.admin.password),
      true,
    );

  app.addHook('onClose', async () => {
    await manager.closeAll();
    await catalog.close();
  });

  return app;
}
