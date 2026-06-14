import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { RolesPanel } from './roles-panel';
import type { DbSummary } from '@atlas/client';
import type { DbInfo } from '@atlas/protocol';

const dbs: DbSummary[] = [{ name: 'kb', description: '', role: 'owner' }];
const kbInfo: DbInfo = { name: 'kb', role: 'owner', owners: ['ada'] };

describe('RolesPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders owned databases and their owners', async () => {
    await TestBed.configureTestingModule({
      imports: [RolesPanel],
      providers: [
        {
          provide: AtlasApi,
          useValue: {
            listDatabases: vi.fn().mockResolvedValue(dbs),
            getDatabase: vi.fn().mockResolvedValue(kbInfo),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(RolesPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('kb');
  });
});
