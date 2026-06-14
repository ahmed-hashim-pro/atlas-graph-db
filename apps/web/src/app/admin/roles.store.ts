import { computed, inject, Injectable, signal } from '@angular/core';
import type { DbSummary } from '@atlas/client';
import type { RoleName } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class RolesStore {
  private readonly api = inject(AtlasApi);
  private readonly _databases = signal<DbSummary[]>([]);
  private readonly _selected = signal('');
  private readonly _owners = signal<string[]>([]);
  private readonly _error = signal('');

  /** Only databases the caller owns can have their roles managed (spec §6.2). */
  readonly ownedDatabases = computed(() => this._databases().filter((d) => d.role === 'owner'));
  readonly selected = this._selected.asReadonly();
  readonly owners = this._owners.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._error.set('');
    try {
      this._databases.set(await this.api.listDatabases());
    } catch {
      this._error.set('Could not load databases.');
    }
  }

  async select(name: string): Promise<void> {
    this._selected.set(name);
    this._owners.set([]);
    this._error.set('');
    try {
      const info = await this.api.getDatabase(name);
      this._owners.set(info.owners);
    } catch {
      this._error.set('Could not load database owners.');
    }
  }

  async grant(username: string, role: RoleName): Promise<void> {
    if (!this._selected()) return;
    this._error.set('');
    try {
      await this.api.grantRole(this._selected(), username, role);
      await this.select(this._selected());
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 404 ? `No user named "${username}".` : 'Could not grant the role.',
      );
    }
  }

  async revoke(username: string): Promise<void> {
    if (!this._selected()) return;
    this._error.set('');
    try {
      await this.api.revokeRole(this._selected(), username);
      await this.select(this._selected());
    } catch {
      this._error.set('Could not revoke the role.');
    }
  }
}
