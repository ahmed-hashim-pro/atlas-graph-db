import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from './core/atlas-api';
import { AuthService } from './core/auth.service';
import { provideSessionRehydration } from './app.config';
import type { UserInfo } from '@atlas/protocol';

const ada: UserInfo = { username: 'ada', isAdmin: false };

describe('session rehydration initializer', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('calls AuthService.refresh() during app initialization and populates the user', async () => {
    const whoami = vi.fn().mockResolvedValue(ada);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AtlasApi, useValue: { whoami } },
        provideSessionRehydration(),
      ],
    });
    // Forces the APP_INITIALIZER promises to resolve.
    await TestBed.inject(ApplicationInitStatus).donePromise;
    expect(whoami).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(AuthService).user()).toEqual(ada);
  });
});
