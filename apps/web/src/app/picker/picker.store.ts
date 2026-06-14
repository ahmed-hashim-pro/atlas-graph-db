import { inject, Injectable, signal } from '@angular/core';
import type { DbSummary } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class PickerStore {
  private readonly api = inject(AtlasApi);
  private readonly _databases = signal<DbSummary[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal('');

  readonly databases = this._databases.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._loading.set(true);
    this._error.set('');
    try {
      this._databases.set(await this.api.listDatabases());
    } catch {
      this._error.set('Could not load databases.');
    } finally {
      this._loading.set(false);
    }
  }

  async create(name: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.createDatabase(name);
      await this.load();
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 409
          ? `A database named "${name}" already exists.`
          : status === 400
            ? 'Invalid database name (letters, digits, - and _ only).'
            : 'Could not create the database.',
      );
    }
  }

  async seed(name: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.seed(name, 'science-history');
    } catch {
      this._error.set('Could not seed the database.');
    }
  }
}
