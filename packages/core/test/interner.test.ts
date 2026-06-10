import { describe, expect, it } from 'vitest';
import { Interner } from '../src/interner.js';

describe('Interner', () => {
  it('assigns stable sequential ids and resolves both directions', () => {
    const i = new Interner();
    expect(i.intern('KNOWS')).toBe(0);
    expect(i.intern('WROTE')).toBe(1);
    expect(i.intern('KNOWS')).toBe(0);
    expect(i.idOf('WROTE')).toBe(1);
    expect(i.idOf('MISSING')).toBeUndefined();
    expect(i.stringOf(0)).toBe('KNOWS');
  });
});
