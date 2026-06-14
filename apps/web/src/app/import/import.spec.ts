import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Import } from './import';
import type { ImportResult } from '@atlas/protocol';

const result: ImportResult = { committed: { nodes: 2, edges: 1 }, idMap: { a: 0, b: 1 } };

describe('Import page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('imports pasted JSON and renders the committed counts + idMap size', async () => {
    const importFn = vi.fn().mockResolvedValue(result);
    await TestBed.configureTestingModule({
      imports: [Import],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { import: importFn } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => 'kb' } } } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Import);
    const cmp = fixture.componentInstance;
    cmp.jsonText.set(
      JSON.stringify({
        nodes: [
          { tempId: 'a', labels: ['X'] },
          { tempId: 'b', labels: ['X'] },
        ],
      }),
    );
    await cmp.submit();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(importFn).toHaveBeenCalled();
    expect(text).toContain('2'); // committed nodes
    expect(text).toContain('idMap');
  });
});
