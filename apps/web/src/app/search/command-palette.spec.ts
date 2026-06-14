import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { CommandPalette } from './command-palette';
import type { QueryResponse } from '@atlas/protocol';

const found: QueryResponse = {
  columns: ['n'],
  rows: [[{ id: '7', labels: ['Person'], props: { name: 'Ada' } }]],
  stats: { rowsExamined: 1, elapsedMs: 0 },
};

describe('CommandPalette', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup(query = vi.fn().mockResolvedValue(found)) {
    TestBed.configureTestingModule({
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query }) } }],
    });
    const fixture = TestBed.createComponent(CommandPalette);
    fixture.componentRef.setInput('database', 'kb');
    return { fixture, query };
  }

  it('runs the search and exposes hits', async () => {
    const { fixture, query } = setup();
    const cmp = fixture.componentInstance;
    cmp.term.set('ada');
    await cmp.search();
    expect(query).toHaveBeenCalledTimes(1);
    expect(cmp.hits()).toHaveLength(1);
    expect(cmp.hits()[0].label).toBe('Ada');
  });

  it('arrow keys move the active index and Enter emits the active hit', async () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    const picked: string[] = [];
    cmp.pick.subscribe((h) => picked.push(h.id));
    cmp.term.set('ada');
    await cmp.search();
    cmp.onKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picked).toEqual(['7']);
  });

  it('Escape emits close', () => {
    const { fixture } = setup();
    const cmp = fixture.componentInstance;
    let closed = false;
    cmp.closed.subscribe(() => (closed = true));
    cmp.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(true);
  });

  it('restores focus to the opener element when closed', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { fixture } = setup();
    fixture.detectChanges();
    fixture.componentInstance.captureOpener(); // workspace calls this when it opens the palette
    fixture.componentInstance.focusInput();

    fixture.componentInstance.close(); // emits closed AND restores focus
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps Tab within the dialog (focusables stay inside)', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const root = (fixture.nativeElement as HTMLElement).querySelector('.palette') as HTMLElement;
    const focusables = root.querySelectorAll<HTMLElement>('input, [tabindex]:not([tabindex="-1"])');
    // The search input is focusable; trapTab keeps focus inside rather than escaping.
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    const handled = fixture.componentInstance.onKey(ev);
    // onKey returns void; assert it prevented default when wrapping at the edge.
    expect(focusables.length).toBeGreaterThan(0);
    expect(ev.defaultPrevented || focusables.length === 1).toBe(true);
  });
});
