import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { Legend } from './legend';
import { GraphStore } from './graph.store';

describe('Legend component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setup() {
    TestBed.configureTestingModule({ imports: [Legend], providers: [GraphStore] });
    const fixture = TestBed.createComponent(Legend);
    return { fixture, store: TestBed.inject(GraphStore) };
  }

  it('lists labels with counts and a color swatch', async () => {
    const { fixture, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: {} }], edges: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Person');
    expect(text).toContain('1');
    expect((fixture.nativeElement as HTMLElement).querySelector('.swatch')).toBeTruthy();
  });

  it('toggling a label checkbox flips its visibility in the store', async () => {
    const { fixture, store } = setup();
    store.addGraph({ nodes: [{ id: '1', labels: ['Person'], props: {} }], edges: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();
    expect(store.labels().find((l) => l.label === 'Person')?.visible).toBe(false);
  });
});
