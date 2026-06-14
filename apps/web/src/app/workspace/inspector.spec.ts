import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from './inspector';
import { GraphStore } from './graph.store';

describe('Inspector component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [Inspector], providers: [GraphStore] });
    const fixture = TestBed.createComponent(Inspector);
    return { fixture, cmp: fixture.componentInstance, store: TestBed.inject(GraphStore) };
  }

  it('shows an empty prompt when nothing is selected', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Select a node');
  });

  it('renders the selected node label, properties (read-only), and connections', async () => {
    const { fixture, store } = setup();
    store.addGraph({
      nodes: [
        { id: '1', labels: ['Person'], props: { name: 'Ada', born: 1815 } },
        { id: '2', labels: ['Doc'], props: { name: 'Notes' } },
      ],
      edges: [{ id: 'e', from: '1', to: '2', type: 'WROTE', props: {} }],
    });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Person');
    expect(text).toContain('Ada');
    expect(text).toContain('1815');
    expect(text).toContain('WROTE'); // connection list shows the edge type
    // No editable inputs in M6b — properties are read-only.
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('input').length).toBe(0);
  });

  it('the expand button emits the selected node id', async () => {
    const { fixture, cmp, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: { name: 'Ada' } }], edges: [] });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const expand = vi.fn();
    cmp.expand.subscribe(expand);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.expand-btn')!.click();
    expect(expand).toHaveBeenCalledWith('1');
  });

  it('clicking a connection selects the neighbor', async () => {
    const { fixture, store } = setup();
    store.addGraph({
      nodes: [
        { id: '1', labels: ['Person'], props: {} },
        { id: '2', labels: ['Doc'], props: {} },
      ],
      edges: [{ id: 'e', from: '1', to: '2', type: 'WROTE', props: {} }],
    });
    store.select({ kind: 'node', id: '1' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.conn-link')!.click();
    expect(store.selection()).toEqual({ kind: 'node', id: '2' });
  });
});
