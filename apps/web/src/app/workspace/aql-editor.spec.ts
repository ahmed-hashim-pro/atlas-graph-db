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
});
