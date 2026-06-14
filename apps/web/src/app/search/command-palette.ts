import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AtlasApi } from '../core/atlas-api';
import { searchQuery, toHits, type NodeHit } from './node-search';

/** Max hits surfaced per search — keeps the overlay scannable and the query capped. */
const SEARCH_LIMIT = 25;

@Component({
  selector: 'app-command-palette',
  imports: [FormsModule],
  templateUrl: './command-palette.html',
})
export class CommandPalette {
  private readonly api = inject(AtlasApi);
  /** Current database name (workspace passes it in). */
  readonly database = input.required<string>();

  /** Emits the picked node hit; the workspace brings it onto the canvas. */
  readonly pick = output<NodeHit>();
  /** Emits when the palette should close (Escape / backdrop). */
  readonly closed = output<void>();

  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('box');

  readonly term = signal('');
  readonly hits = signal<NodeHit[]>([]);
  readonly active = signal(0);
  readonly busy = signal(false);

  /** Focus the search box on open (called by the workspace after it mounts). */
  focusInput(): void {
    this.searchBox()?.nativeElement.focus();
  }

  async search(): Promise<void> {
    const term = this.term().trim();
    if (!term) {
      this.hits.set([]);
      return;
    }
    this.busy.set(true);
    try {
      const { query, params } = searchQuery(term, SEARCH_LIMIT);
      const res = await this.api.database(this.database()).query(query, params);
      this.hits.set(toHits(res));
      this.active.set(0);
    } catch {
      this.hits.set([]);
    } finally {
      this.busy.set(false);
    }
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.closed.emit();
      return;
    }
    const hits = this.hits();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (hits.length) this.active.set((this.active() + 1) % hits.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (hits.length) this.active.set((this.active() - 1 + hits.length) % hits.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const hit = hits[this.active()];
      if (hit) this.pick.emit(hit);
    }
  }

  choose(hit: NodeHit): void {
    this.pick.emit(hit);
  }
}
