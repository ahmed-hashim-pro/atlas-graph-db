import { computed, inject, Injectable, signal } from '@angular/core';
import type { SchemaSummary } from '@atlas/core';
import type { QueryResponse } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';
import { planToTree, type PlanTreeRow } from './explain-plan';
import { resultToGraph, WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';

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
  // Optional so the console store works in unit tests / contexts without a
  // canvas store provider; the workspace binds the real GraphStore adapter.
  private readonly graphStore = inject(WORKSPACE_GRAPH_STORE, { optional: true });
  private dbName = '';

  private readonly _columns = signal<string[]>([]);
  private readonly _rows = signal<unknown[][]>([]);
  private readonly _stats = signal<QueryResponse['stats'] | null>(null);
  private readonly _error = signal<ConsoleError | null>(null);
  private readonly _running = signal(false);
  private readonly _tab = signal<ConsoleTab>('results');
  private readonly _schema = signal<SchemaSummary | null>(null);
  private readonly _plan = signal<PlanTreeRow[]>([]);
  private readonly _projectable = signal(false);

  readonly columns = this._columns.asReadonly();
  readonly rows = this._rows.asReadonly();
  readonly stats = this._stats.asReadonly();
  readonly error = this._error.asReadonly();
  readonly running = this._running.asReadonly();
  readonly tab = this._tab.asReadonly();
  readonly schema = this._schema.asReadonly();
  readonly plan = this._plan.asReadonly();
  readonly hasResults = computed(() => this._columns().length > 0);
  /** True when the last result contains node cells the canvas can display. */
  readonly projectable = this._projectable.asReadonly();

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
      this._projectable.set(resultToGraph(res.columns, res.rows).nodes.length > 0);
      this._tab.set('results');
      return res;
    } catch (e) {
      this._error.set(toConsoleError(e));
      this._columns.set([]);
      this._rows.set([]);
      this._stats.set(null);
      this._projectable.set(false);
      return null;
    } finally {
      this._running.set(false);
    }
  }

  /** Hand the current result's nodes/edges to the canvas store (console "project to canvas"). */
  projectToCanvas(): void {
    const graph = resultToGraph(this._columns(), this._rows());
    if (graph.nodes.length > 0) this.graphStore?.setGraph(graph);
  }

  async explain(query: string): Promise<void> {
    const text = query.trim();
    if (!text) return;
    this._running.set(true);
    this._error.set(null);
    try {
      const res = await this.api.database(this.dbName).query(`EXPLAIN ${text}`, {});
      const planCell = res.rows[0]?.[0];
      this._plan.set(planToTree(planCell));
      this._tab.set('plan');
    } catch (e) {
      this._error.set(toConsoleError(e));
      this._plan.set([]);
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
