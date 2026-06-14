import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';
import { ALGORITHMS, buildAlgorithmCall, paintFromRows, type AlgorithmSpec } from './algorithms';
import { WORKSPACE_GRAPH_STORE } from './workspace-graph-store.contract';

@Component({
  selector: 'app-algorithms-view',
  imports: [FormsModule],
  templateUrl: './algorithms-view.html',
})
export class AlgorithmsView {
  private readonly api = inject(AtlasApi);
  private readonly route = inject(ActivatedRoute);
  private readonly graphStore = inject(WORKSPACE_GRAPH_STORE, { optional: true });

  readonly algorithms = ALGORITHMS;
  readonly selected = signal<AlgorithmSpec>(ALGORITHMS[0]!);
  readonly values = signal<Record<string, number | string>>(defaults(ALGORITHMS[0]!));
  readonly running = signal(false);
  readonly error = signal('');
  readonly painted = signal(0);

  select(spec: AlgorithmSpec): void {
    this.selected.set(spec);
    this.values.set(defaults(spec));
    this.error.set('');
    this.painted.set(0);
  }

  setValue(key: string, raw: string, isNumber: boolean): void {
    this.values.update((v) => ({ ...v, [key]: isNumber ? Number(raw) : raw }));
  }

  async run(): Promise<void> {
    const name = this.route.snapshot.paramMap.get('name') ?? '';
    const spec = this.selected();
    const { query, params } = buildAlgorithmCall(spec, this.values());
    this.running.set(true);
    this.error.set('');
    try {
      const res = await this.api.database(name).query(query, params);
      const paint = paintFromRows(spec, res.columns, res.rows);
      this.graphStore?.paintAlgorithmResult(paint);
      this.painted.set(paint.scores.size + paint.communities.size + paint.paths.length);
    } catch (e) {
      this.error.set((e as { message?: string }).message ?? 'Algorithm failed.');
    } finally {
      this.running.set(false);
    }
  }
}

function defaults(spec: AlgorithmSpec): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of spec.params) if (p.default !== undefined) out[p.key] = p.default;
  return out;
}
