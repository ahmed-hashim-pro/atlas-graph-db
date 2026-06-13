import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Login } from './login';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Login component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('submits credentials and navigates to the picker on success', async () => {
    const login = vi.fn().mockResolvedValue(ada);
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } }],
    }).compileComponents();
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Login);
    const cmp = fixture.componentInstance;
    cmp.username.set('ada');
    cmp.password.set('secret12');
    await cmp.submit();
    expect(login).toHaveBeenCalledWith('ada', 'secret12');
    expect(navSpy).toHaveBeenCalledWith('/databases');
  });

  it('shows an error message when login fails', async () => {
    const login = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AtlasApi, useValue: { login, whoami: vi.fn().mockResolvedValue(null) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Login);
    const cmp = fixture.componentInstance;
    cmp.username.set('x');
    cmp.password.set('y');
    await cmp.submit();
    await fixture.whenStable();
    expect(cmp.error()).toContain('Invalid');
  });
});
