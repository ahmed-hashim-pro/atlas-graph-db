import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { aql } from './aql-language';

@Component({
  selector: 'app-aql-editor',
  template: `<div #host class="aql-editor-host"></div>`,
})
export class AqlEditor implements AfterViewInit, OnDestroy {
  readonly value = input<string>('');
  /** Optional schema-aware completion source (Task 2). */
  readonly completionSource = input<CompletionSource | null>(null);

  @Output() readonly valueChange = new EventEmitter<string>();
  @Output() readonly run = new EventEmitter<string>();

  @ViewChild('host', { static: true }) private readonly host!: ElementRef<HTMLDivElement>;
  private view: EditorView | null = null;

  ngAfterViewInit(): void {
    const source = this.completionSource();
    this.view = new EditorView({
      parent: this.host.nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          lineNumbers(),
          cmHistory(),
          aql(),
          ...(source ? [autocompletion({ override: [source] })] : [autocompletion()]),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                this.triggerRun();
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.valueChange.emit(u.state.doc.toString());
          }),
        ],
      }),
    });
  }

  /** Current document text. */
  doc(): string {
    return this.view?.state.doc.toString() ?? this.value();
  }

  /** Replace the whole document (used by History re-run). Emits valueChange. */
  setDoc(text: string): void {
    if (!this.view) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    this.valueChange.emit(text);
  }

  /** Emit run() with the current doc — bound to Mod-Enter and callable from tests. */
  triggerRun(): void {
    this.run.emit(this.doc());
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }
}
