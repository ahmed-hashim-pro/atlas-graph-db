import { describe, expect, it } from 'vitest';
import { AtlasError } from '../src/index.js';

describe('smoke', () => {
  it('exports AtlasError', () => {
    expect(typeof AtlasError).toBe('function');
  });
});
