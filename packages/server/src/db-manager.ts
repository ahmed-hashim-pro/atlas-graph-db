import { openDatabase, type AtlasDatabase } from '@atlas/core';
import { join } from 'node:path';

/** Lazily opens user databases into per-name data dirs; drains them on shutdown. */
export class DatabaseManager {
  private readonly open = new Map<string, Promise<AtlasDatabase>>();

  constructor(private readonly baseDir: string) {}

  /** Path for a db's data dir. Name is validated upstream (dbNameSchema) — no traversal. */
  private dirFor(name: string): string {
    return join(this.baseDir, 'db', name);
  }

  get(name: string): Promise<AtlasDatabase> {
    let p = this.open.get(name);
    if (!p) {
      p = openDatabase(this.dirFor(name));
      this.open.set(name, p);
    }
    return p;
  }

  /** Close + forget one db (after deletion the caller also removes the data dir). */
  async evict(name: string): Promise<void> {
    const p = this.open.get(name);
    this.open.delete(name);
    if (p) await (await p).close();
  }

  async closeAll(): Promise<void> {
    const dbs = [...this.open.values()];
    this.open.clear();
    for (const p of dbs) await (await p).close();
  }
}
