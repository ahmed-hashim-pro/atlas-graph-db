import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuthService } from '../core/auth.service';
import { Register } from './register';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Register component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('registers then logs in through AuthService and sets the user signal', async () => {
    const register = vi.fn().mockResolvedValue(ada);
    const login = vi.fn().mockResolvedValue(ada);
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        {
          provide: AtlasApi,
          useValue: { register, login, whoami: vi.fn().mockResolvedValue(null) },
        },
      ],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Register);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('secret12');
    await cmp.submit();

    expect(register).toHaveBeenCalledWith('ada', 'secret12');
    expect(login).toHaveBeenCalledWith('ada', 'secret12');
    expect(auth.user()).toEqual(ada);
    expect(navSpy).toHaveBeenCalledWith('/databases');
  });

  it('rejects a short password before calling the API', async () => {
    const register = vi.fn();
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { register, whoami: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Register);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('short');
    await cmp.submit();
    expect(register).not.toHaveBeenCalled();
    expect(cmp.error()).toContain('at least 8');
  });
});
