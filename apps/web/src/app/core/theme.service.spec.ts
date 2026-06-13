import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeService, THEMES, type ThemeId } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  function make(): ThemeService {
    return TestBed.runInInjectionContext(() => new ThemeService());
  }

  it('defaults to Midnight Observatory and applies data-theme on <html>', () => {
    const svc = make();
    expect(svc.current()).toBe<ThemeId>('midnight-observatory');
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight-observatory');
  });

  it('switches theme, updates the signal, and writes the attribute', () => {
    const svc = make();
    svc.set('neon-terminal');
    expect(svc.current()).toBe<ThemeId>('neon-terminal');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon-terminal');
  });

  it('persists the choice to localStorage and restores it on a new instance', () => {
    const a = make();
    a.set('clean-laboratory');
    expect(localStorage.getItem('atlas.theme')).toBe('clean-laboratory');
    const b = make();
    expect(b.current()).toBe<ThemeId>('clean-laboratory');
    expect(document.documentElement.getAttribute('data-theme')).toBe('clean-laboratory');
  });

  it('ignores an invalid persisted value and falls back to the default', () => {
    localStorage.setItem('atlas.theme', 'bogus');
    const svc = make();
    expect(svc.current()).toBe<ThemeId>('midnight-observatory');
  });

  it('exposes the three theme descriptors for a switcher UI', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'midnight-observatory',
      'clean-laboratory',
      'neon-terminal',
    ]);
    expect(THEMES.every((t) => t.label.length > 0)).toBe(true);
  });
});
