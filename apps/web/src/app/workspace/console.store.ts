import { computed, inject, Injectable, signal } from '@angular/core';
import type { SchemaSummary } from '@atlas/core';
import type { QueryResponse } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';

export type ConsoleTab = 'results' | 'plan' | 'history';

export interface ConsoleError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
}

interface ClientErrorLike {
  message: string;
  code?: string;
  problem?: { code?: string; detail?: string; line?: number; column?: number; snippet?: string };
}

@Injectable({ providedIn: 'root' })
export class ConsoleStore {
  private readonly api = inject(AtlasApi);
  private dbName = '';

  private readonly _columns = signal<string[]>([]);
  private readonly _rows = signal<unknown[][]>([]);
  private readonly _stats = signal<QueryResponse['stats'] | null>(null);
  private readonly _error = signal<ConsoleError | null>(null);
  private readonly _running = signal(false);
  private readonly _tab = signal<ConsoleTab>('results');
  private readonly _schema = signal<SchemaSummary | null>(null);

  readonly columns = this._columns.asReadonly();
  readonly rows = this._rows.asReadonly();
  readonly stats = this._stats.asReadonly();
  readonly error = this._error.asReadonly();
  readonly running = this._running.asReadonly();
  readonly tab = this._tab.asReadonly();
  readonly schema = this._schema.asReadonly();
  readonly hasResults = computed(() => this._columns().length > 0);

  useDatabase(name: string): void {
    this.dbName = name;
    void this.loadSchema();
  }

  setTab(tab: ConsoleTab): void {
    this._tab.set(tab);
  }

  async loadSchema(): Promise<void> {
    try {
      this._schema.set(await this.api.database(this.dbName).schema());
    } catch {
      this._schema.set(null); // autocomplete degrades to keywords only
    }
  }

  async run(query: string, params: Record<string, unknown> = {}): Promise<QueryResponse | null> {
    const text = query.trim();
    if (!text) return null;
    this._running.set(true);
    this._error.set(null);
    try {
      const res = await this.api.database(this.dbName).query(text, params);
      this._columns.set(res.columns);
      this._rows.set(res.rows);
      this._stats.set(res.stats);
      this._tab.set('results');
      return res;
    } catch (e) {
      this._error.set(toConsoleError(e));
      this._columns.set([]);
      this._rows.set([]);
      this._stats.set(null);
      return null;
    } finally {
      this._running.set(false);
    }
  }
}

function toConsoleError(e: unknown): ConsoleError {
  const err = e as ClientErrorLike;
  const p = err.problem;
  return {
    code: p?.code ?? err.code ?? 'ERROR',
    message: p?.detail ?? err.message ?? 'Query failed.',
    line: p?.line,
    column: p?.column,
    snippet: p?.snippet,
  };
}
