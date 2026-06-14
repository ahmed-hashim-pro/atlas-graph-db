import { Component, inject, input, OnInit, viewChild } from '@angular/core';
import { makeAqlCompletionSource } from './aql-completions';
import { AqlEditor } from './aql-editor';
import { ConsoleStore } from './console.store';
import { ResultsTable } from './results-table';

@Component({
  selector: 'app-console',
  imports: [AqlEditor, ResultsTable],
  templateUrl: './console.html',
})
export class Console implements OnInit {
  readonly database = input.required<string>();
  readonly store = inject(ConsoleStore);
  readonly completionSource = makeAqlCompletionSource(() => this.store.schema());
  private readonly editor = viewChild(AqlEditor);

  ngOnInit(): void {
    this.store.useDatabase(this.database());
  }

  run(text: string): void {
    void this.store.run(text);
  }
}
