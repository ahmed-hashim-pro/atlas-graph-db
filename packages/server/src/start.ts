import { buildServer } from './app.js';
import { loadConfig } from './config.js';

/** Production entrypoint: build the app and listen; drain on SIGTERM/SIGINT. */
export async function start(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const app = await buildServer(config);
  const shutdown = async (): Promise<void> => {
    await app.close(); // onClose drains the manager + catalog
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
