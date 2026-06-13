import { computed, inject, Injectable, signal } from '@angular/core';
import type { UserInfo } from '@atlas/protocol';
import { AtlasApi } from './atlas-api';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(AtlasApi);
  private readonly _user = signal<UserInfo | null>(null);
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  async login(username: string, password: string): Promise<UserInfo> {
    const user = await this.api.login(username, password);
    this._user.set(user);
    return user;
  }

  async register(username: string, password: string): Promise<UserInfo> {
    return this.api.register(username, password);
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this._user.set(null);
  }

  /** Rehydrate from the session cookie (e.g. on app start or guard activation). */
  async refresh(): Promise<UserInfo | null> {
    const user = await this.api.whoami();
    this._user.set(user);
    return user;
  }
}
