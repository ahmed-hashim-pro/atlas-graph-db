import { inject, Injectable, signal } from '@angular/core';
import type { UserSummary } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class UsersStore {
  private readonly api = inject(AtlasApi);
  private readonly _users = signal<UserSummary[]>([]);
  private readonly _error = signal('');

  readonly users = this._users.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._error.set('');
    try {
      this._users.set(await this.api.listUsers());
    } catch {
      this._error.set('Could not load users.');
    }
  }

  async create(username: string, password: string, isAdmin: boolean): Promise<void> {
    this._error.set('');
    try {
      await this.api.createUser(username, password, isAdmin);
      await this.load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 409
          ? `A user named "${username}" already exists.`
          : 'Could not create the user.',
      );
    }
  }

  async setAdmin(username: string, isAdmin: boolean): Promise<void> {
    this._error.set('');
    try {
      await this.api.updateUser(username, { isAdmin });
      await this.load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 409 ? 'Cannot demote the last admin.' : 'Could not update the user.',
      );
    }
  }

  async resetPassword(username: string, password: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.resetUserPassword(username, password);
    } catch {
      this._error.set('Could not reset the password.');
    }
  }

  async remove(username: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.deleteUser(username);
      await this.load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(status === 409 ? 'Cannot delete this user.' : 'Could not delete the user.');
    }
  }
}
