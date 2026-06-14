import { Injectable, signal } from '@angular/core';

export interface HistoryEntry {
  query: string;
  /** Insertion counter (monotonic within the session) for stable ordering. */
  seq: number;
}

const MAX_ENTRIES = 50;
const KEY_PREFIX = 'atlas.history.';

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private dbName = '';
  private seq = 0;
  private readonly _entries = signal<HistoryEntry[]>([]);
  readonly entries = this._entries.asReadonly();

  use(dbName: string): void {
    this.dbName = dbName;
    this._entries.set(this.restore());
  }

  add(query: string): void {
    const text = query.trim();
    if (!text) return;
    const without = this._entries().filter((e) => e.query !== text);
    const next = [{ query: text, seq: ++this.seq }, ...without].slice(0, MAX_ENTRIES);
    this._entries.set(next);
    this.persist(next);
  }

  clear(): void {
    this._entries.set([]);
    this.persist([]);
  }

  private storageKey(): string {
    return `${KEY_PREFIX}${this.dbName}`;
  }

  private restore(): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as HistoryEntry[];
      return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
    } catch {
      return [];
    }
  }

  private persist(entries: HistoryEntry[]): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(entries));
    } catch {
      // localStorage unavailable (private mode) — history stays in-memory only.
    }
  }
}
