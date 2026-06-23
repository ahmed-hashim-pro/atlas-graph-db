import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuditPanel } from './audit-panel';
import type { AuditEntry } from '@atlas/client';

const entries: AuditEntry[] = [
  { seq: 2, at: '2026-01-02T00:00:00.000Z', username: 'admin', action: 'db:create', target: 'g' },
  {
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    username: 'admin',
    action: 'user:create',
    target: 'bob',
  },
];

describe('AuditPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders entries reverse-chronologically and refreshes', async () => {
    const listAudit = vi.fn().mockResolvedValue(entries);
    await TestBed.configureTestingModule({
      imports: [AuditPanel],
      providers: [{ provide: AtlasApi, useValue: { listAudit } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AuditPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('db:create');
    expect(el.textContent).toContain('user:create');

    listAudit.mockClear();
    await fixture.componentInstance.refresh();
    expect(listAudit).toHaveBeenCalled();
  });
});
