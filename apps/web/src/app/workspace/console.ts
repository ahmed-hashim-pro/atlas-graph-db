import { Component, computed, inject, input, OnInit, viewChild } from '@angular/core';
import { makeAqlCompletionSource } from './aql-completions';
import { AqlEditor, type AqlErrorRange } from './aql-editor';
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

  /**
   * The current error's 1-based position to underline in the editor, derived from
   * the console store's error signal. `null` when there is no error or no position,
   * which clears the squiggle.
   */
  readonly errorRange = computed<AqlErrorRange | null>(() => {
    const err = this.store.error();
    if (err?.line && err.column) return { line: err.line, column: err.column };
    return null;
  });

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
