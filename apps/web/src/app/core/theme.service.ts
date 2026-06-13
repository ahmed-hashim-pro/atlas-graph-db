import { Injectable, signal } from '@angular/core';

export type ThemeId = 'midnight-observatory' | 'clean-laboratory' | 'neon-terminal';

export interface ThemeDescriptor {
  id: ThemeId;
  label: string;
  description: string;
}

export const THEMES: readonly ThemeDescriptor[] = [
  {
    id: 'midnight-observatory',
    label: 'Midnight Observatory',
    description: 'Dark, glowing nodes, violet and cyan accents.',
  },
  {
    id: 'clean-laboratory',
    label: 'Clean Laboratory',
    description: 'Light, crisp, white panels with indigo accents.',
  },
  {
    id: 'neon-terminal',
    label: 'Neon Terminal',
    description: 'Monospace, neon green on near-black.',
  },
] as const;

export const DEFAULT_THEME: ThemeId = 'midnight-observatory';
const STORAGE_KEY = 'atlas.theme';

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && THEMES.some((t) => t.id === value);
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _current = signal<ThemeId>(this.restore());
  /** The active theme id (signal). */
  readonly current = this._current.asReadonly();
  readonly themes = THEMES;

  constructor() {
    this.apply(this._current());
  }

  set(id: ThemeId): void {
    this._current.set(id);
    this.apply(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage may be unavailable (private mode); theme still applies in-memory.
    }
  }

  private restore(): ThemeId {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isThemeId(stored)) return stored;
    } catch {
      // ignore — fall back to the default
    }
    return DEFAULT_THEME;
  }

  private apply(id: ThemeId): void {
    document.documentElement.setAttribute('data-theme', id);
  }
}
