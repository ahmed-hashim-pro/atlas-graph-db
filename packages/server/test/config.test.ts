import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('reads required + defaulted values from an env map', () => {
    const c = loadConfig({
      ATLAS_DATA_DIR: '/tmp/atlas',
      ATLAS_SECRET: 'x'.repeat(32),
      ATLAS_ADMIN_USER: 'root',
      ATLAS_ADMIN_PASSWORD: 'rootpass1',
    });
    expect(c.dataDir).toBe('/tmp/atlas');
    expect(c.secret).toHaveLength(32);
    expect(c.admin).toEqual({ username: 'root', password: 'rootpass1' });
    expect(c.queryTimeoutMs).toBe(30_000); // default
    expect(c.maxRows).toBe(100_000); // default
  });

  it('throws when a required value is missing or the secret is too short', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ATLAS_DATA_DIR: '/tmp/a', ATLAS_SECRET: 'short' })).toThrow(
      /secret/i,
    );
  });

  it('admin bootstrap is optional (absent → no admin seeding)', () => {
    const c = loadConfig({ ATLAS_DATA_DIR: '/tmp/a', ATLAS_SECRET: 'y'.repeat(32) });
    expect(c.admin).toBeUndefined();
  });
});
