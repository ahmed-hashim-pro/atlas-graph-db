import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { authenticate } from './auth.js';
import { HttpError } from './errors.js';
import type { CatalogService } from './catalog.js';

const SKIP = new Set(['/healthz', '/metrics']);

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
}

/** Fixed-window per-principal (or per-IP) rate limit. */
export function registerRateLimit(
  app: FastifyInstance,
  config: ServerConfig,
  catalog: CatalogService,
): void {
  const hits = new Map<string, { count: number; resetAt: number }>();
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (SKIP.has(req.url.split('?')[0]!)) return;
    const principal = await authenticate(req, catalog).catch(() => null);
    const key = principal?.username ?? req.ip;
    const nowMs = nowMillis();
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + config.rateWindowMs });
      return;
    }
    entry.count++;
    if (entry.count > config.rateLimit)
      throw new HttpError(429, 'RATE_LIMITED', 'rate limit exceeded; retry later');
  });
}

// Monotonic-ish clock; isolated so tests can reason about windows.
function nowMillis(): number {
  return Math.floor(performance.now());
}
