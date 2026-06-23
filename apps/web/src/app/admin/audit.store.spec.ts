import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuditStore } from './audit.store';
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

function withApi(api: Partial<AtlasApi>): AuditStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(AuditStore);
}

describe('AuditStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the entries signal with the requested limit', async () => {
    const listAudit = vi.fn().mockResolvedValue(entries);
    const store = withApi({ listAudit });
    await store.load(50);
    expect(listAudit).toHaveBeenCalledWith(50);
    expect(store.entries()).toEqual(entries);
  });

  it('load() defaults to the current limit when none is given', async () => {
    const listAudit = vi.fn().mockResolvedValue(entries);
    const store = withApi({ listAudit });
    await store.load();
    expect(listAudit).toHaveBeenCalledWith(store.limit());
  });

  it('load() sets a friendly error on failure', async () => {
    const store = withApi({ listAudit: vi.fn().mockRejectedValue(new Error('boom')) });
    await store.load();
    expect(store.error()).toBe('Could not load the audit log.');
  });
});
