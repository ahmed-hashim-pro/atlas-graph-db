import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { AuthService } from '../core/auth.service';
import { Shell } from './shell';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('Shell component', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the username and logs out', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { whoami: vi.fn().mockResolvedValue(ada), logout } },
      ],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    await auth.refresh();
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ada');

    await fixture.componentInstance.logout();
    expect(logout).toHaveBeenCalled();
    expect(navSpy).toHaveBeenCalledWith('/login');
  });
});
