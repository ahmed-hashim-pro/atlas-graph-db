import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DbInfo } from '@atlas/protocol';
import { AtlasApi } from '../core/atlas-api';

/**
 * Editable database-settings form: loads `getDatabase(name)`, lets an admin edit
 * the description and save it via `patchDatabase`, and shows owners/role read-only.
 */
@Component({
  selector: 'app-db-settings',
  imports: [FormsModule],
  templateUrl: './db-settings.html',
})
export class DbSettings implements OnInit {
  readonly name = input.required<string>();
  private readonly api = inject(AtlasApi);

  readonly info = signal<DbInfo | null>(null);
  readonly description = signal('');
  readonly error = signal('');
  readonly saved = signal(false);
  readonly saving = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set('');
    this.saved.set(false);
    try {
      const info = await this.api.getDatabase(this.name());
      this.info.set(info);
      this.description.set(info.description ?? '');
    } catch {
      this.error.set('Could not load database settings.');
    }
  }

  async save(): Promise<void> {
    this.error.set('');
    this.saved.set(false);
    this.saving.set(true);
    try {
      await this.api.patchDatabase(this.name(), { description: this.description() });
      this.saved.set(true);
    } catch {
      this.error.set('Could not save the description.');
    } finally {
      this.saving.set(false);
    }
  }
}
