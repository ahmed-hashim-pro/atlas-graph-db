import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './atlas-api';
import { AuthService } from './auth.service';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

function withApi(api: Partial<AtlasApi>): AuthService {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(AuthService);
}

describe('AuthService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts unauthenticated', () => {
    const svc = withApi({ whoami: vi.fn().mockResolvedValue(null) });
    expect(svc.user()).toBeNull();
    expect(svc.isAuthenticated()).toBe(false);
  });

  it('login sets the user signal', async () => {
    const svc = withApi({ login: vi.fn().mockResolvedValue(ada) });
    await svc.login('ada', 'secret12');
    expect(svc.user()).toEqual(ada);
    expect(svc.isAuthenticated()).toBe(true);
  });

  it('register then login', async () => {
    const register = vi.fn().mockResolvedValue(ada);
    const login = vi.fn().mockResolvedValue(ada);
    const svc = withApi({ register, login });
    await svc.register('ada', 'secret12');
    expect(register).toHaveBeenCalledWith('ada', 'secret12');
    await svc.login('ada', 'secret12');
    expect(svc.user()).toEqual(ada);
  });

  it('logout clears the user signal', async () => {
    const svc = withApi({
      login: vi.fn().mockResolvedValue(ada),
      logout: vi.fn().mockResolvedValue(undefined),
    });
    await svc.login('ada', 'secret12');
    await svc.logout();
    expect(svc.user()).toBeNull();
  });

  it('refresh() rehydrates the user from whoami (session restore)', async () => {
    const svc = withApi({ whoami: vi.fn().mockResolvedValue(ada) });
    await svc.refresh();
    expect(svc.user()).toEqual(ada);
  });
});
