import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import type { AtlasDatabase } from '../src/database.js';

type Action =
  | { kind: 'addNode' }
  | { kind: 'addEdge'; fromPick: number; toPick: number }
  | { kind: 'setProps'; pick: number }
  | { kind: 'delEdge'; pick: number }
  | { kind: 'delNode'; pick: number }
  | { kind: 'ddl'; which: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ kind: 'addNode' }),
  fc.record({ kind: fc.constant('addEdge' as const), fromPick: fc.nat(99), toPick: fc.nat(99) }),
  fc.record({ kind: fc.constant('setProps' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delEdge' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('delNode' as const), pick: fc.nat(99) }),
  fc.record({ kind: fc.constant('ddl' as const), which: fc.nat(5) }),
);

async function applyActions(db: AtlasDatabase, actions: Action[]): Promise<void> {
  const liveNodes: number[] = [];
  const liveEdges: number[] = [];
  for (const a of actions) {
    await db
      .transact((tx) => {
        switch (a.kind) {
          case 'addNode':
            liveNodes.push(tx.createNode(['N'], { v: liveNodes.length }));
            break;
          case 'addEdge': {
            if (liveNodes.length === 0) return;
            const from = liveNodes[a.fromPick % liveNodes.length]!;
            const to = liveNodes[a.toPick % liveNodes.length]!;
            liveEdges.push(tx.createEdge('T', from, to));
            break;
          }
          case 'setProps': {
            if (liveNodes.length === 0) return;
            tx.setNodeProps(liveNodes[a.pick % liveNodes.length]!, { v: a.pick });
            break;
          }
          case 'delEdge': {
            if (liveEdges.length === 0) return;
            const idx = a.pick % liveEdges.length;
            tx.deleteEdge(liveEdges[idx]!);
            liveEdges.splice(idx, 1);
            break;
          }
          case 'delNode': {
            if (liveNodes.length === 0) return;
            const idx = a.pick % liveNodes.length;
            const nodeId = liveNodes[idx]!;
            tx.deleteNode(nodeId, { detach: true });
            liveNodes.splice(idx, 1);
            for (let i = liveEdges.length - 1; i >= 0; i--) {
              const e = db.getEdge(liveEdges[i]!);
              if (!e || e.from === nodeId || e.to === nodeId) liveEdges.splice(i, 1);
            }
            break;
          }
          case 'ddl': {
            const defs = [
              { kind: 'property', label: 'N', property: 'v' },
              { kind: 'fulltext', label: 'N', property: 'v' },
              { kind: 'unique', label: 'N', property: 'v' },
            ] as const;
            const def = defs[a.which % 3]!;
            const exists = db
              .listIndexes()
              .some(
                (d) => d.kind === def.kind && d.label === def.label && d.property === def.property,
              );
            if (a.which < 3 && !exists) tx.createIndex(def);
            else if (a.which >= 3 && exists) tx.dropIndex(def);
            break;
          }
        }
      })
      .catch(() => undefined); // detach-race rejections are fine; invariants are what matter
  }
}

describe('storage property tests', () => {
  it('random op sequences keep invariants and survive reopen identically', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { maxLength: 60 }), async (actions) => {
        const dir = await mkdtemp(join(tmpdir(), 'atlas-prop-'));
        try {
          const db = await openDatabase(dir, { snapshotWalBytes: 2048 });
          await applyActions(db, actions);
          const before = db.stats();
          const defsBefore = db.listIndexes();
          db.checkInvariants();
          await db.close();

          const db2 = await openDatabase(dir);
          db2.checkInvariants();
          if (JSON.stringify(db2.stats()) !== JSON.stringify(before))
            throw new Error(
              `reopen mismatch: ${JSON.stringify(db2.stats())} vs ${JSON.stringify(before)}`,
            );
          if (JSON.stringify(db2.listIndexes()) !== JSON.stringify(defsBefore))
            throw new Error('reopen index defs mismatch');
          await db2.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 25 },
    );
  }, 120_000);
});
