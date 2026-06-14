import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-workspace-placeholder',
  imports: [RouterLink],
  template: `
    <main class="placeholder">
      <h1>Workspace: {{ name }}</h1>
      <p>The graph workspace (canvas, AQL console, schema, algorithms) arrives in M6b–M6c.</p>
      <a routerLink="/databases">Back to databases</a>
    </main>
  `,
})
export class WorkspacePlaceholder {
  readonly name = inject(ActivatedRoute).snapshot.paramMap.get('name') ?? '';
}
