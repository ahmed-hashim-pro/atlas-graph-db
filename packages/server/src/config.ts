export interface ServerConfig {
  dataDir: string;
  secret: string;
  admin?: { username: string; password: string };
  port: number;
  queryTimeoutMs: number;
  maxRows: number;
  corsOrigins: string[];
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const dataDir = env.ATLAS_DATA_DIR;
  if (!dataDir) throw new Error('ATLAS_DATA_DIR is required');
  const secret = env.ATLAS_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('ATLAS_SECRET is required and must be >= 32 chars');
  const adminUser = env.ATLAS_ADMIN_USER;
  const adminPassword = env.ATLAS_ADMIN_PASSWORD;
  const admin =
    adminUser && adminPassword ? { username: adminUser, password: adminPassword } : undefined;
  return {
    dataDir,
    secret,
    admin,
    port: Number(env.ATLAS_PORT ?? '4848'),
    queryTimeoutMs: Number(env.ATLAS_QUERY_TIMEOUT_MS ?? '30000'),
    maxRows: Number(env.ATLAS_MAX_ROWS ?? '100000'),
    corsOrigins: (env.ATLAS_CORS_ORIGINS ?? '').split(',').filter((s) => s.length > 0),
  };
}
