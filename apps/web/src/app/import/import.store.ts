import { inject, Injectable, signal } from '@angular/core';
import type { ImportResult } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';
import { parseJsonImport } from './import-request';

@Injectable({ providedIn: 'root' })
export class ImportStore {
  private readonly api = inject(AtlasApi);
  private readonly _result = signal<ImportResult | null>(null);
  private readonly _error = signal('');
  private readonly _busy = signal(false);

  readonly result = this._result.asReadonly();
  readonly error = this._error.asReadonly();
  readonly busy = this._busy.asReadonly();

  async runJson(name: string, text: string, atomic: boolean): Promise<void> {
    const parsed = parseJsonImport(text, atomic);
    if (!parsed.ok) {
      this._error.set(parsed.error);
      this._result.set(null);
      return;
    }
    await this.run(() => this.api.import(name, parsed.value));
  }

  async runCsv(name: string, nodesCsv: string, edgesCsv: string, atomic: boolean): Promise<void> {
    await this.run(() =>
      this.api.importCsv(name, {
        nodesCsv: nodesCsv.trim() ? nodesCsv : undefined,
        edgesCsv: edgesCsv.trim() ? edgesCsv : undefined,
        atomic,
      }),
    );
  }

  private async run(call: () => Promise<ImportResult>): Promise<void> {
    this._error.set('');
    this._busy.set(true);
    try {
      this._result.set(await call());
    } catch (err) {
      const status = (err as { status?: number }).status;
      this._error.set(
        status === 403
          ? 'You do not have permission to import into this database.'
          : status === 400
            ? 'The import was rejected — check the payload format.'
            : 'Import failed. Please try again.',
      );
      this._result.set(null);
    } finally {
      this._busy.set(false);
    }
  }
}
