import { Component, inject, output } from '@angular/core';
import { GraphStore } from './graph.store';

@Component({
  selector: 'app-inspector',
  templateUrl: './inspector.html',
})
export class Inspector {
  readonly store = inject(GraphStore);

  /** Expand-neighbors action for the selected node (handled by the Workspace page). */
  readonly expand = output<string>();
  /** Find-paths action (UI present in M6b; the paths view itself lands in M6c). */
  readonly findPaths = output<string>();

  /** Selected node's properties as [key, value] entries for read-only display. */
  entries(props: Record<string, unknown>): [string, string][] {
    return Object.entries(props).map(([k, v]) => [k, String(v)]);
  }

  selectNeighbor(id: string): void {
    this.store.select({ kind: 'node', id });
  }
}
