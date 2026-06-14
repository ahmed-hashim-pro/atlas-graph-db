import { describe, expect, it } from 'vitest';
import { makeColorOf, resolveRenderTheme } from './theme-colors';

/** A fake CSS-var reader mapping `--token` → value. */
function reader(map: Record<string, string>): (prop: string) => string {
  return (prop) => map[prop] ?? '';
}

describe('resolveRenderTheme', () => {
  it('reads the token set into a RenderTheme', () => {
    const theme = resolveRenderTheme(
      reader({
        '--bg': '#0b0f1d',
        '--surface': '#141a2e',
        '--border': '#2a3350',
        '--text': '#e6ebff',
        '--text-muted': '#9aa6c8',
        '--accent': '#6366f1',
        '--node-1': '#6366f1',
        '--node-2': '#22d3ee',
        '--node-3': '#a855f7',
        '--node-4': '#f472b6',
        '--node-5': '#34d399',
        '--node-6': '#fbbf24',
      }),
    );
    expect(theme.background).toBe('#0b0f1d');
    expect(theme.accent).toBe('#6366f1');
    expect(theme.nodePalette).toHaveLength(6);
    expect(theme.nodePalette[1]).toBe('#22d3ee');
    expect(theme.edge).toBe('#2a3350'); // edges default to the border token
  });

  it('falls back to safe defaults when a token is missing', () => {
    const theme = resolveRenderTheme(reader({}));
    expect(theme.background.length).toBeGreaterThan(0);
    expect(theme.nodePalette.length).toBe(6);
  });
});

describe('makeColorOf', () => {
  it('assigns a stable palette color per first label', () => {
    const palette = ['#a', '#b', '#c', '#d', '#e', '#f'];
    const colorOf = makeColorOf(palette);
    const c1 = colorOf(['Person']);
    expect(colorOf(['Person'])).toBe(c1); // stable across calls
    expect(palette).toContain(colorOf(['Doc']));
    expect(colorOf([])).toBe(palette[0]); // unlabeled → first bucket
  });
});
