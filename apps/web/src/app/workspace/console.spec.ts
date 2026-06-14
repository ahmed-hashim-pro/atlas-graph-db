import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Console } from './console';

describe('Console host', () => {
  it('runs the editor query through the store and shows the results table', async () => {
    const query = vi.fn().mockResolvedValue({
      columns: ['name'],
      rows: [['Ada']],
      stats: { rowsExamined: 1, elapsedMs: 1 },
    });
    const schema = vi.fn().mockResolvedValue({ labels: [], edgeTypes: [] });
    await TestBed.configureTestingModule({
      imports: [Console],
      providers: [{ provide: AtlasApi, useValue: { database: () => ({ query, schema }) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Console);
    fixture.componentRef.setInput('database', 'kb');
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.store.run('MATCH (p:Person) RETURN p.name AS name');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Ada');
  });

  it('renders the structured error banner with the caret snippet', async () => {
    const query = vi.fn().mockRejectedValue(
      Object.assign(new Error('bad'), {
        problem: {
          code: 'PARSE_ERROR',
          detail: 'bad token',
          line: 1,
          column: 3,
          snippet: 'XY\n  ^',
        },
      }),
    );
    await TestBed.configureTestingModule({
      imports: [Console],
      providers: [
        {
          provide: AtlasApi,
          useValue: {
            database: () => ({
              query,
              schema: vi.fn().mockResolvedValue({ labels: [], edgeTypes: [] }),
            }),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Console);
    fixture.componentRef.setInput('database', 'kb');
    fixture.detectChanges();
    await fixture.componentInstance.store.run('XY');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('PARSE_ERROR');
    expect(text).toContain('line 1:3');
  });
});
