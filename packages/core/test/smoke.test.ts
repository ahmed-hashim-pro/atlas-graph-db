import { describe, expect, it } from 'vitest';
import { ATLAS_CORE_VERSION } from '../src/index.js';

describe('smoke', () => {
  it('exports a version', () => {
    expect(ATLAS_CORE_VERSION).toBe('0.0.0');
  });
});
