import { Component, inject, input, OnInit, viewChild } from '@angular/core';
import { makeAqlCompletionSource } from './aql-completions';
import { AqlEditor } from './aql-editor';
import { ConsoleStore } from './console.store';
import { ExplainPlanView } from './explain-plan-view';
import { HistoryStore } from './history.store';
import { ResultsTable } from './results-table';

@Component({
  selector: 'app-console',
  imports: [AqlEditor, ResultsTable, ExplainPlanView],
  templateUrl: './console.html',
})
export class Console implements OnInit {
  readonly database = input.required<string>();
  readonly store = inject(ConsoleStore);
  readonly history = inject(HistoryStore);
  readonly completionSource = makeAqlCompletionSource(() => this.store.schema());
  private readonly editor = viewChild(AqlEditor);

  ngOnInit(): void {
    this.store.useDatabase(this.database());
    this.history.use(this.database());
  }

  run(text: string): void {
    this.history.add(text);
    void this.store.run(text);
  }

  explain(): void {
    void this.store.explain(this.editor()?.doc() ?? '');
  }

  rerun(query: string): void {
    this.editor()?.setDoc(query);
    this.run(query);
  }
}
