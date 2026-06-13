import { start } from './start.js';

start().catch((err: unknown) => {
  console.error('[atlas] failed to start:', err);
  process.exit(1);
});
