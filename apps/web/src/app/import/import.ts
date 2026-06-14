import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ImportStore } from './import.store';

type Mode = 'json' | 'csv';

@Component({
  selector: 'app-import',
  imports: [FormsModule, RouterLink],
  templateUrl: './import.html',
  providers: [ImportStore],
})
export class Import {
  readonly store = inject(ImportStore);
  /** Target db comes from `?db=` (picker/workspace link); blank disables submit. */
  readonly name = inject(ActivatedRoute).snapshot.queryParamMap.get('db') ?? '';

  readonly mode = signal<Mode>('json');
  readonly atomic = signal(false);
  readonly jsonText = signal('');
  readonly nodesCsv = signal('');
  readonly edgesCsv = signal('');

  readonly idMapSize = computed(() => Object.keys(this.store.result()?.idMap ?? {}).length);

  async readFile(target: 'json' | 'nodes' | 'edges', input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (target === 'json') this.jsonText.set(text);
    else if (target === 'nodes') this.nodesCsv.set(text);
    else this.edgesCsv.set(text);
  }

  async submit(): Promise<void> {
    if (!this.name) return;
    if (this.mode() === 'json') await this.store.runJson(this.name, this.jsonText(), this.atomic());
    else await this.store.runCsv(this.name, this.nodesCsv(), this.edgesCsv(), this.atomic());
  }
}
