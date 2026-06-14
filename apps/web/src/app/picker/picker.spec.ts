import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Picker } from './picker';
import type { DbSummary } from '@atlas/client';

const dbs: DbSummary[] = [{ name: 'kb', description: '', role: 'owner' }];

describe('Picker component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the databases returned by the API with their role', async () => {
    await TestBed.configureTestingModule({
      imports: [Picker],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { listDatabases: vi.fn().mockResolvedValue(dbs) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Picker);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('kb');
    expect(text).toContain('owner');
  });
});
