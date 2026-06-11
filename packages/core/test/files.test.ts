import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsyncDir } from '../src/files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-files-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fsyncDir', () => {
  it('resolves on an existing directory', async () => {
    await expect(fsyncDir(dir)).resolves.toBeUndefined();
  });

  it('rejects on a missing directory', async () => {
    await expect(fsyncDir(join(dir, 'missing'))).rejects.toThrow();
  });
});
