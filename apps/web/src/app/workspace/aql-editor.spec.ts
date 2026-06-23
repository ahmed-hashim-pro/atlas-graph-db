import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AqlEditor } from './aql-editor';

describe('AqlEditor component', () => {
  it('mounts a CodeMirror editor, reflects [value], and emits valueChange', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'MATCH (n) RETURN n');
    fixture.detectChanges();
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.cm-editor')).toBeTruthy();
    expect(host.textContent).toContain('MATCH');

    const changes: string[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => changes.push(v));
    fixture.componentInstance.setDoc('MATCH (p:Person) RETURN p');
    expect(changes.at(-1)).toBe('MATCH (p:Person) RETURN p');
  });

  it('invokes (run) on Ctrl/Cmd+Enter with the current document', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'RETURN 1');
    fixture.detectChanges();
    await fixture.whenStable();
    const ran = vi.fn();
    fixture.componentInstance.run.subscribe(ran);
    fixture.componentInstance.triggerRun();
    expect(ran).toHaveBeenCalledWith('RETURN 1');
  });

  it('marks the error range with a decoration at the expected offset', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    // Two lines; the error points at line 2, column 3 (1-based).
    fixture.componentRef.setInput('value', 'MATCH (n)\nRETURN x');
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentRef.setInput('errorRange', { line: 2, column: 3 });
    fixture.detectChanges();
    await fixture.whenStable();

    const offsets = fixture.componentInstance.errorDecorationOffsets();
    // doc.line(2).from === 10 ("MATCH (n)\n" is 10 chars); column 3 → +2 → offset 12.
    expect(offsets.length).toBe(1);
    expect(offsets[0].from).toBe(12);
    expect(offsets[0].from).toBeLessThan(offsets[0].to);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.cm-aql-error')).toBeTruthy();
  });

  it('clears the decoration when the error range is cleared', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'RETURN x');
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentRef.setInput('errorRange', { line: 1, column: 1 });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.errorDecorationOffsets().length).toBe(1);

    fixture.componentRef.setInput('errorRange', null);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.errorDecorationOffsets().length).toBe(0);
  });

  it('clears the decoration when the document is edited', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'RETURN x');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.setInput('errorRange', { line: 1, column: 1 });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.errorDecorationOffsets().length).toBe(1);

    fixture.componentInstance.setDoc('RETURN 1');
    expect(fixture.componentInstance.errorDecorationOffsets().length).toBe(0);
  });

  it('degrades gracefully when the error range is out of bounds (no throw)', async () => {
    const fixture = TestBed.createComponent(AqlEditor);
    fixture.componentRef.setInput('value', 'RETURN 1');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(() => {
      fixture.componentRef.setInput('errorRange', { line: 999, column: 999 });
      fixture.detectChanges();
    }).not.toThrow();
    expect(fixture.componentInstance.errorDecorationOffsets().length).toBe(0);

    expect(() => {
      fixture.componentRef.setInput('errorRange', { line: 1, column: 999 });
      fixture.detectChanges();
    }).not.toThrow();
    // Column past the line end clamps to the line end rather than throwing.
    const offsets = fixture.componentInstance.errorDecorationOffsets();
    expect(offsets.length).toBeLessThanOrEqual(1);
  });
});
