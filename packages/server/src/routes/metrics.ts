import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

export async function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    void reply.type('text/plain; version=0.0.4');
    return ctx.metrics.render();
  });
}
