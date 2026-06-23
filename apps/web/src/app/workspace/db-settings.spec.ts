import { TestBed } from '@angular/core/testing';
import type { DbInfo } from '@atlas/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { DbSettings } from './db-settings';

const info: DbInfo = {
  name: 'kb',
  description: 'Knowledge base',
  role: 'owner',
  owners: ['ada', 'bob'],
};

function setup(api: Partial<AtlasApi>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DbSettings],
    providers: [{ provide: AtlasApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(DbSettings);
  fixture.componentRef.setInput('name', 'kb');
  return { fixture, cmp: fixture.componentInstance };
}

describe('DbSettings', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('loads the database and seeds the editable description', async () => {
    const getDatabase = vi.fn().mockResolvedValue(info);
    const { fixture, cmp } = setup({ getDatabase, patchDatabase: vi.fn() } as Partial<AtlasApi>);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getDatabase).toHaveBeenCalledWith('kb');
    expect(cmp.description()).toBe('Knowledge base');
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('ada');
    expect(host.textContent).toContain('bob');
    expect(host.textContent).toContain('owner');
  });

  it('saves the description via patchDatabase and surfaces success', async () => {
    const getDatabase = vi.fn().mockResolvedValue(info);
    const patchDatabase = vi.fn().mockResolvedValue(undefined);
    const { fixture, cmp } = setup({ getDatabase, patchDatabase } as Partial<AtlasApi>);
    fixture.detectChanges();
    await fixture.whenStable();

    cmp.description.set('Updated description');
    await cmp.save();
    fixture.detectChanges();

    expect(patchDatabase).toHaveBeenCalledWith('kb', { description: 'Updated description' });
    expect(cmp.saved()).toBe(true);
    expect(cmp.error()).toBe('');
  });

  it('surfaces a friendly error when the load fails', async () => {
    const getDatabase = vi.fn().mockRejectedValue(new Error('nope'));
    const { fixture, cmp } = setup({ getDatabase, patchDatabase: vi.fn() } as Partial<AtlasApi>);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(cmp.error()).toBeTruthy();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.error')).toBeTruthy();
  });

  it('surfaces a friendly error when the save fails', async () => {
    const getDatabase = vi.fn().mockResolvedValue(info);
    const patchDatabase = vi.fn().mockRejectedValue(new Error('boom'));
    const { fixture, cmp } = setup({ getDatabase, patchDatabase } as Partial<AtlasApi>);
    fixture.detectChanges();
    await fixture.whenStable();

    await cmp.save();
    expect(cmp.error()).toBeTruthy();
    expect(cmp.saved()).toBe(false);
  });
});
