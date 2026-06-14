import { Component, inject } from '@angular/core';
import { GraphStore } from './graph.store';
import { makeColorOf, resolveRenderTheme } from './theme-colors';

@Component({
  selector: 'app-legend',
  templateUrl: './legend.html',
})
export class Legend {
  readonly store = inject(GraphStore);
  private readonly colorOf = makeColorOf(
    resolveRenderTheme((p) =>
      typeof getComputedStyle === 'function'
        ? getComputedStyle(document.documentElement).getPropertyValue(p)
        : '',
    ).nodePalette,
  );

  swatch(label: string): string {
    return this.colorOf([label]);
  }
}
