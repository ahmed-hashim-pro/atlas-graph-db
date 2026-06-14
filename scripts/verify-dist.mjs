// Verifies the COMPILED server boots from packages/server/dist/cli.js:
//  (a) dist/cli.js exists after `pnpm build`;
//  (b) with a bad env (no ATLAS_SECRET) the process exits non-zero, cleanly;
//  (c) with good env it serves GET /healthz → {status:'ok'}, then is terminated.
// Run AFTER `pnpm build`. Usage: node scripts/verify-dist.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'packages/server/dist/cli.js';
const SECRET = 's'.repeat(32);

function run(env) {
  return spawn(process.execPath, [CLI], { env: { ...process.env, ...env }, stdio: 'pipe' });
}
function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}
async function poll(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never answered ${url}`);
}

async function main() {
  await access(CLI); // (a) throws if `pnpm build` did not emit dist/cli.js

  // (b) bad env: missing ATLAS_SECRET → loadConfig throws → cli.ts exits 1.
  const bad = run({ ATLAS_DATA_DIR: '/tmp/atlas-verify-bad', ATLAS_SECRET: '' });
  const badCode = await waitExit(bad);
  if (badCode === 0) throw new Error('expected non-zero exit with a bad env, got 0');

  // (c) good env: serves /healthz, then SIGTERM drains it.
  const dir = await mkdtemp(join(tmpdir(), 'atlas-verify-'));
  const good = run({ ATLAS_DATA_DIR: dir, ATLAS_SECRET: SECRET, ATLAS_PORT: '4900' });
  try {
    const res = await poll('http://127.0.0.1:4900/healthz');
    const body = await res.json();
    if (body.status !== 'ok') throw new Error(`/healthz returned ${JSON.stringify(body)}`);
    good.kill('SIGTERM');
    await waitExit(good);
  } finally {
    good.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
  console.log('verify-dist: OK (dist/cli.js boots, bad env fails, /healthz serves)');
}

main().catch((err) => {
  console.error('verify-dist: FAIL —', err.message);
  process.exit(1);
});
