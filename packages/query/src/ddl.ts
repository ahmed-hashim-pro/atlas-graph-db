import type { AtlasDatabase, IndexDef } from '@atlas/core';
import type { DdlStatement } from './ast.js';

export interface DdlResult {
  columns: string[];
  rows: unknown[][];
}

export async function runDdl(stmt: DdlStatement, db: AtlasDatabase): Promise<DdlResult> {
  switch (stmt.stmt) {
    case 'createIndex': {
      const def: IndexDef = { kind: stmt.kind, label: stmt.label, property: stmt.property };
      await db.createIndex(def);
      return { columns: [], rows: [] };
    }
    case 'dropIndex': {
      const def: IndexDef = { kind: stmt.kind, label: stmt.label, property: stmt.property };
      await db.dropIndex(def);
      return { columns: [], rows: [] };
    }
    case 'showIndexes': {
      const rows = db
        .listIndexes()
        .map((d) => [d.kind, d.label, d.property])
        .sort((a, b) => a.join().localeCompare(b.join()));
      return { columns: ['kind', 'label', 'property'], rows };
    }
    case 'showConstraints': {
      const rows = db
        .listIndexes()
        .filter((d) => d.kind === 'unique')
        .map((d) => [d.kind, d.label, d.property]);
      return { columns: ['kind', 'label', 'property'], rows };
    }
  }
}
