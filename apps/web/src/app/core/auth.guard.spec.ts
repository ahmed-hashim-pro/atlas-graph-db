import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './atlas-api';
import { authGuard } from './auth.guard';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

function run(api: Partial<AtlasApi>): Promise<boolean | ReturnType<Router['parseUrl']>> {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.runInInjectionContext(() => authGuard());
}

describe('authGuard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('allows an authenticated caller', async () => {
    const result = await run({ whoami: vi.fn().mockResolvedValue(ada) });
    expect(result).toBe(true);
  });

  it('redirects an anonymous caller to /login', async () => {
    const result = await run({ whoami: vi.fn().mockResolvedValue(null) });
    expect(String(result)).toBe('/login');
  });
});
