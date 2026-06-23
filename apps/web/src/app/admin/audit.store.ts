import { inject, Injectable, signal } from '@angular/core';
import type { AuditEntry } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class AuditStore {
  private readonly api = inject(AtlasApi);
  private readonly _entries = signal<AuditEntry[]>([]);
  private readonly _error = signal('');
  private readonly _limit = signal(100);

  readonly entries = this._entries.asReadonly();
  readonly error = this._error.asReadonly();
  readonly limit = this._limit.asReadonly();

  async load(limit?: number): Promise<void> {
    if (limit !== undefined) this._limit.set(limit);
    this._error.set('');
    try {
      this._entries.set(await this.api.listAudit(this._limit()));
    } catch {
      this._error.set('Could not load the audit log.');
    }
  }
}
