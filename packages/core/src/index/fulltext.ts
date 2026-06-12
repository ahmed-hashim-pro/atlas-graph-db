import type { NodeId, PropertyValue } from '../types.js';

const WORD = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

function textOf(value: PropertyValue): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  return null;
}

/**
 * Inverted index over one (label, property) pair. Postings count token
 * occurrences per node so removing a value only drops a node when its last
 * occurrence of the token goes. A parallel sorted token array serves prefix
 * scans for search-as-you-type.
 */
export class FulltextIndex {
  private readonly postings = new Map<string, Map<NodeId, number>>();
  private sortedTokens: string[] = [];
  private sortedDirty = false;

  get tokenCount(): number {
    return this.postings.size;
  }

  /** Token -> per-node occurrence counts. Read-only introspection for invariant checks. */
  *postingEntries(): IterableIterator<[string, ReadonlyMap<NodeId, number>]> {
    yield* this.postings.entries();
  }

  add(value: PropertyValue, id: NodeId): void {
    const text = textOf(value);
    if (text === null) return;
    for (const token of tokenize(text)) {
      let nodes = this.postings.get(token);
      if (!nodes) {
        nodes = new Map();
        this.postings.set(token, nodes);
        this.sortedDirty = true;
      }
      nodes.set(id, (nodes.get(id) ?? 0) + 1);
    }
  }

  remove(value: PropertyValue, id: NodeId): void {
    const text = textOf(value);
    if (text === null) return;
    for (const token of tokenize(text)) {
      const nodes = this.postings.get(token);
      const count = nodes?.get(id);
      if (!nodes || count === undefined) continue;
      if (count <= 1) {
        nodes.delete(id);
        if (nodes.size === 0) {
          this.postings.delete(token);
          this.sortedDirty = true;
        }
      } else {
        nodes.set(id, count - 1);
      }
    }
  }

  /** AND-semantics over query tokens; `prefix` expands the final token. */
  search(query: string, opts: { prefix?: boolean } = {}): Set<NodeId> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return new Set();
    const last = tokens.length - 1;
    const idsFor = (i: number): Set<NodeId> =>
      opts.prefix && i === last
        ? this.idsForPrefix(tokens[i]!)
        : new Set(this.postings.get(tokens[i]!)?.keys() ?? []);
    let result = idsFor(0);
    for (let i = 1; i < tokens.length && result.size > 0; i++) {
      const ids = idsFor(i);
      result = new Set([...result].filter((id: NodeId) => ids.has(id)));
    }
    return result;
  }

  private idsForPrefix(prefix: string): Set<NodeId> {
    if (this.sortedDirty) {
      this.sortedTokens = [...this.postings.keys()].sort();
      this.sortedDirty = false;
    }
    const ids = new Set<NodeId>();
    let lo = 0;
    let hi = this.sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedTokens[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.sortedTokens.length; i++) {
      const token = this.sortedTokens[i]!;
      if (!token.startsWith(prefix)) break;
      for (const id of this.postings.get(token)?.keys() ?? []) ids.add(id);
    }
    return ids;
  }
}
