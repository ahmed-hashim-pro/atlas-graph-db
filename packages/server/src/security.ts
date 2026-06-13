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

  // Periodically evict expired buckets so the map can't grow without bound on a long-lived
  // server: every distinct principal/IP that ever made a request would otherwise leave a
  // permanent entry. The sweep interval is `.unref()`'d so it never keeps the process (or a
  // test runner) alive, and it is torn down on app close.
  const sweepEveryMs = Math.max(config.rateWindowMs, 1000);
  const sweep = setInterval(() => {
    const nowMs = nowMillis();
    for (const [key, entry] of hits) if (nowMs >= entry.resetAt) hits.delete(key);
  }, sweepEveryMs);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (SKIP.has(req.url.split('?')[0]!)) return;
    // Authenticate once per request and cache the principal so the route's `requireAuth`
    // preHandler (and `authenticate` generally) can reuse it instead of repeating the
    // findUser/findToken lookups and argon2 verifyToken on the hot path.
    const principal = await authenticate(req, catalog).catch(() => null);
    if (principal) req.principal = principal;
    // NOTE: for unauthenticated traffic the bucket is keyed by `req.ip`, which is the socket
    // peer unless Fastify `trustProxy` is enabled. Behind a reverse proxy that doesn't set a
    // trusted forwarded address, all anonymous clients collapse into the proxy's single
    // bucket. This is acceptable only when the server sits behind a proxy that itself
    // rate-limits, or when `trustProxy` is configured so `req.ip` is the real client IP.
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

// Monotonic clock; isolated so tests can reason about windows.
function nowMillis(): number {
  return Math.floor(performance.now());
}
