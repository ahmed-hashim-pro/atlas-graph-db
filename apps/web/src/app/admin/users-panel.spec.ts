import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { UsersPanel } from './users-panel';
import type { UserSummary } from '@atlas/client';

const list: UserSummary[] = [
  { username: 'admin', isAdmin: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { username: 'bob', isAdmin: false, createdAt: '2026-01-02T00:00:00.000Z' },
];

describe('UsersPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists users with an admin badge and creates a new user', async () => {
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce(list)
      .mockResolvedValueOnce([...list, { username: 'cara', isAdmin: false, createdAt: 'x' }]);
    const createUser = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [UsersPanel],
      providers: [{ provide: AtlasApi, useValue: { listUsers, createUser } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(UsersPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('admin');
    expect(el.textContent).toContain('bob');

    fixture.componentInstance.newUsername.set('cara');
    fixture.componentInstance.newPassword.set('password1');
    await fixture.componentInstance.create();
    fixture.detectChanges();
    expect(createUser).toHaveBeenCalledWith('cara', 'password1', false);
  });

  it('delete prompts a confirm and only removes when confirmed', async () => {
    const listUsers = vi.fn().mockResolvedValue(list);
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await TestBed.configureTestingModule({
      imports: [UsersPanel],
      providers: [{ provide: AtlasApi, useValue: { listUsers, deleteUser } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(UsersPanel);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.remove('bob');
    expect(deleteUser).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await fixture.componentInstance.remove('bob');
    expect(deleteUser).toHaveBeenCalledWith('bob');
    confirmSpy.mockRestore();
  });
});
