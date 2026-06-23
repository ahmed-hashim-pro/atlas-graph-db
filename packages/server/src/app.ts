import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { CatalogService } from './catalog.js';
import { hashPassword } from './crypto.js';
import { DatabaseManager } from './db-manager.js';
import { toProblem } from './errors.js';
import { MetricsRegistry } from './metrics.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDatabaseRoutes } from './routes/databases.js';
import { registerDataRoutes } from './routes/data.js';
import { registerIoRoutes } from './routes/io.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerUserRoutes } from './routes/users.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerRateLimit, registerSecurityHeaders } from './security.js';

export interface AppContext {
  catalog: CatalogService;
  manager: DatabaseManager;
  config: ServerConfig;
  metrics: MetricsRegistry;
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { join } = await import('node:path');
  const catalog = await CatalogService.open(join(config.dataDir, '_catalog'));
  const manager = new DatabaseManager(config.dataDir);
  const metrics = new MetricsRegistry();
  const ctx: AppContext = { catalog, manager, config, metrics };

  await app.register(fastifyCookie, { secret: config.secret });
  const fastifyWebsocket = (await import('@fastify/websocket')).default;
  await app.register(fastifyWebsocket);

  const cors = (await import('@fastify/cors')).default;
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  });
  registerSecurityHeaders(app);
  registerRateLimit(app, config, catalog);

  // Uniform problem-details for thrown errors and 404s.
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toProblem(err);
    void reply.status(status).type('application/problem+json').send(body);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app, ctx);
  await registerDatabaseRoutes(app, ctx);
  await registerDataRoutes(app, ctx);
  await registerIoRoutes(app, ctx);
  await registerMetricsRoutes(app, ctx);
  await registerQueryRoutes(app, ctx);
  await registerTokenRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAuditRoutes(app, ctx);
  await registerWsRoutes(app, ctx);

  // Not-found handling: when a static SPA dir is configured, serve it with an
  // index.html fallback for client-side routes; otherwise a plain JSON 404.
  if (config.staticDir) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: config.staticDir, wildcard: false });
    // SPA fallback: any non-API, non-WS GET that didn't match a file returns index.html.
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api') &&
        !req.url.startsWith('/ws') &&
        !req.url.startsWith('/metrics') &&
        !req.url.startsWith('/healthz')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => {
      void reply.status(404).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  }

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
