import {
  AfterViewInit,
  Component,
  effect,
  ElementRef,
  EventEmitter,
  input,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { aql } from './aql-language';

/** 1-based line/column of an AQL error, mirroring `ConsoleError`. */
export interface AqlErrorRange {
  line: number;
  column: number;
}

/**
 * Carries an already-resolved decoration set into the error field. The component
 * resolves the 1-based line/column against the live document (so it can clamp
 * out-of-range positions) and dispatches this effect.
 */
const setErrorDeco = StateEffect.define<DecorationSet>();

/** Wavy red underline for the offending range — scoped to the editor, no global CSS needed. */
const errorTheme = EditorView.baseTheme({
  '.cm-aql-error': {
    textDecoration: 'underline wavy #d33',
    textDecorationSkipInk: 'none',
  },
});

const errorMark = Decoration.mark({ class: 'cm-aql-error' });

/**
 * Translate a 1-based line/column into a `[from, to]` document range, clamping to
 * the line/doc bounds so an out-of-range error never throws. Returns `null` when
 * the line does not exist (e.g. a stale error after the doc shrank).
 */
function rangeFor(view: EditorView, range: AqlErrorRange): { from: number; to: number } | null {
  const { doc } = view.state;
  if (range.line < 1 || range.line > doc.lines) return null;
  const line = doc.line(range.line);
  const from = Math.min(line.from + Math.max(range.column - 1, 0), line.to);
  // Mark to the end of the line; if the caret sits at the line end, mark the
  // preceding character so there is something to underline (when possible).
  const to = line.to;
  if (from >= to) {
    if (from > line.from) return { from: from - 1, to: from };
    return null;
  }
  return { from, to };
}

/** A field holding the current squiggle decoration set; cleared on doc edits. */
const errorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    // A document edit clears the stale squiggle.
    let next = tr.docChanged ? Decoration.none : deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorDeco)) next = e.value;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

@Component({
  selector: 'app-aql-editor',
  template: `<div #host class="aql-editor-host"></div>`,
})
export class AqlEditor implements AfterViewInit, OnDestroy {
  readonly value = input<string>('');
  /** Optional schema-aware completion source (Task 2). */
  readonly completionSource = input<CompletionSource | null>(null);
  /** 1-based error position to underline; `null`/`undefined` clears the squiggle. */
  readonly errorRange = input<AqlErrorRange | null>(null);

  @Output() readonly valueChange = new EventEmitter<string>();
  @Output() readonly run = new EventEmitter<string>();

  @ViewChild('host', { static: true }) private readonly host!: ElementRef<HTMLDivElement>;
  private view: EditorView | null = null;

  constructor() {
    // React to error-range changes after the view exists.
    effect(() => {
      const range = this.errorRange();
      if (this.view) this.applyErrorRange(range);
    });
  }

  ngAfterViewInit(): void {
    const source = this.completionSource();
    this.view = new EditorView({
      parent: this.host.nativeElement,
      doc: this.value(),
      extensions: [
        lineNumbers(),
        cmHistory(),
        aql(),
        ...(source ? [autocompletion({ override: [source] })] : [autocompletion()]),
        errorField,
        errorTheme,
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
    });
    // Apply any error range that arrived before the view was ready.
    this.applyErrorRange(this.errorRange());
  }

  /** Resolve the 1-based range against the live doc and push it into the field. */
  private applyErrorRange(range: AqlErrorRange | null): void {
    if (!this.view) return;
    if (!range) {
      this.view.dispatch({ effects: setErrorDeco.of(Decoration.none) });
      return;
    }
    const span = rangeFor(this.view, range);
    const deco = span ? Decoration.set([errorMark.range(span.from, span.to)]) : Decoration.none;
    this.view.dispatch({ effects: setErrorDeco.of(deco) });
  }

  /** Test helper: the offsets currently underlined as errors. */
  errorDecorationOffsets(): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    const set = this.view?.state.field(errorField);
    if (!set) return out;
    const iter = set.iter();
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to });
      iter.next();
    }
    return out;
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
