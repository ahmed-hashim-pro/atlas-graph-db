import type { RenderTheme } from './graph-model';

const DEFAULTS: RenderTheme = {
  background: '#0b0f1d',
  surface: '#141a2e',
  border: '#2a3350',
  text: '#e6ebff',
  textMuted: '#9aa6c8',
  accent: '#6366f1',
  edge: '#2a3350',
  nodePalette: ['#6366f1', '#22d3ee', '#a855f7', '#f472b6', '#34d399', '#fbbf24'],
};

/** A CSS-var reader, e.g. `(p) => getComputedStyle(host).getPropertyValue(p).trim()`. */
export type CssVarReader = (prop: string) => string;

/** Resolve the active theme's tokens into a RenderTheme; missing tokens fall back to DEFAULTS. */
export function resolveRenderTheme(read: CssVarReader): RenderTheme {
  const pick = (prop: string, fallback: string): string => {
    const v = read(prop).trim();
    return v.length > 0 ? v : fallback;
  };
  const nodePalette = Array.from({ length: 6 }, (_, i) =>
    pick(`--node-${i + 1}`, DEFAULTS.nodePalette[i]),
  );
  return {
    background: pick('--bg', DEFAULTS.background),
    surface: pick('--surface', DEFAULTS.surface),
    border: pick('--border', DEFAULTS.border),
    text: pick('--text', DEFAULTS.text),
    textMuted: pick('--text-muted', DEFAULTS.textMuted),
    accent: pick('--accent', DEFAULTS.accent),
    edge: pick('--border', DEFAULTS.edge),
    nodePalette,
  };
}

/**
 * A stable label→color mapper: the first label is hashed into a palette bucket and the
 * assignment is memoized so a label keeps its color across frames and across legend renders.
 */
export function makeColorOf(palette: string[]): (labels: string[]) => string {
  const cache = new Map<string, string>();
  return (labels: string[]): string => {
    const key = labels[0] ?? '';
    const hit = cache.get(key);
    if (hit) return hit;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const color = palette[Math.abs(h) % palette.length] ?? palette[0];
    cache.set(key, color);
    return color;
  };
}
