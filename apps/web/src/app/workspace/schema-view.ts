import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';
import { buildSchemaDiagram, type SchemaDiagram } from './schema-diagram';

@Component({
  selector: 'app-schema-view',
  templateUrl: './schema-view.html',
})
export class SchemaView implements OnInit {
  private readonly api = inject(AtlasApi);
  private readonly route = inject(ActivatedRoute);
  readonly diagram = signal<SchemaDiagram>({ nodes: [], edges: [] });
  readonly loading = signal(true);
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    const name = this.route.snapshot.paramMap.get('name') ?? '';
    try {
      const schema = await this.api.database(name).schema();
      this.diagram.set(buildSchemaDiagram(schema, { width: 900, height: 600 }));
    } catch {
      this.error.set('Could not load the schema.');
    } finally {
      this.loading.set(false);
    }
  }
}
