import { dbNameSchema, ImportReq, type ImportResult } from '@atlas/protocol';
import { AtlasError, type AtlasDatabase, type Props } from '@atlas/core';
import { loadDataset, scienceHistory } from '@atlas/datasets';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireAuth, requireCapability } from '../auth.js';
import { parseEdgesCsv, parseNodesCsv } from '../csv.js';
import { HttpError } from '../errors.js';

const BATCH = 10_000;

interface NormalizedNode {
  tempId: string;
  labels: string[];
  properties: Props;
}
interface NormalizedEdge {
  from: string;
  to: string;
  type: string;
  properties: Props;
}

interface NormalizedImport {
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  atomic: boolean;
}

/** Resolve a tempId-or-engine-id reference to a concrete engine id. */
function resolveRef(ref: string, idMap: Map<string, number>, db: AtlasDatabase): number | null {
  const mapped = idMap.get(ref);
  if (mapped !== undefined) return mapped;
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && asNum >= 0 && db.getNode(asNum)) return asNum;
  return null;
}

async function runImport(db: AtlasDatabase, imp: NormalizedImport): Promise<ImportResult> {
  const idMap = new Map<string, number>();
  let committedNodes = 0;
  let committedEdges = 0;

  if (imp.atomic) {
    // Single transaction: all-or-nothing. (Engine batches commit atomically.)
    try {
      await db.transact((tx) => {
        for (const n of imp.nodes) idMap.set(n.tempId, tx.createNode(n.labels, n.properties));
        for (const [i, e] of imp.edges.entries()) {
          const from =
            idMap.get(e.from) ?? (Number.isInteger(Number(e.from)) ? Number(e.from) : undefined);
          const to = idMap.get(e.to) ?? (Number.isInteger(Number(e.to)) ? Number(e.to) : undefined);
          if (from === undefined || to === undefined)
            throw new AtlasError('VALIDATION', `edge ${i}: unresolved endpoint`);
          tx.createEdge(e.type, from, to, e.properties);
        }
      });
      committedNodes = imp.nodes.length;
      committedEdges = imp.edges.length;
    } catch (err) {
      if (err instanceof AtlasError) throw err;
      throw new AtlasError('VALIDATION', (err as Error).message);
    }
    return {
      committed: { nodes: committedNodes, edges: committedEdges },
      idMap: Object.fromEntries(idMap),
    };
  }

  // Non-atomic: batched; on first error, stop and report what committed.
  for (let i = 0; i < imp.nodes.length; i += BATCH) {
    const slice = imp.nodes.slice(i, i + BATCH);
    await db.transact((tx) => {
      for (const n of slice) idMap.set(n.tempId, tx.createNode(n.labels, n.properties));
    });
    committedNodes += slice.length;
  }
  for (let i = 0; i < imp.edges.length; i += BATCH) {
    const slice = imp.edges.slice(i, i + BATCH);
    try {
      const localRefs: {
        from: number;
        to: number;
        type: string;
        props: (typeof slice)[number]['properties'];
      }[] = [];
      for (const [j, e] of slice.entries()) {
        const from = resolveRef(e.from, idMap, db);
        const to = resolveRef(e.to, idMap, db);
        if (from === null || to === null)
          return {
            committed: { nodes: committedNodes, edges: committedEdges },
            idMap: Object.fromEntries(idMap),
            error: { message: `edge references unknown node`, at: { kind: 'edge', index: i + j } },
          };
        localRefs.push({ from, to, type: e.type, props: e.properties });
      }
      await db.transact((tx) => {
        for (const r of localRefs) tx.createEdge(r.type, r.from, r.to, r.props);
      });
      committedEdges += slice.length;
    } catch (err) {
      return {
        committed: { nodes: committedNodes, edges: committedEdges },
        idMap: Object.fromEntries(idMap),
        error: { message: (err as Error).message, at: { kind: 'edge', index: i } },
      };
    }
  }
  return {
    committed: { nodes: committedNodes, edges: committedEdges },
    idMap: Object.fromEntries(idMap),
  };
}

export async function registerIoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: requireAuth(ctx.catalog) };

  app.post('/api/db/:name/import', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'write');
    const db = await ctx.manager.get(name);
    const format = (req.query as { format?: string }).format;
    let imp: NormalizedImport;
    if (format === 'csv') {
      const body = req.body as { nodesCsv?: string; edgesCsv?: string; atomic?: boolean };
      imp = {
        nodes: body.nodesCsv ? parseNodesCsv(body.nodesCsv) : [],
        edges: body.edgesCsv ? parseEdgesCsv(body.edgesCsv) : [],
        atomic: body.atomic ?? false,
      };
    } else {
      const parsed = ImportReq.parse(req.body);
      imp = { nodes: parsed.nodes, edges: parsed.edges, atomic: parsed.atomic };
    }
    return runImport(db, imp);
  });

  app.get('/api/db/:name/export', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'read');
    const db = await ctx.manager.get(name);
    const store = db.graphStore;
    const nodes = [...store.nodes.values()].map((n) => ({
      tempId: String(n.id),
      labels: n.labels,
      properties: n.props,
    }));
    const edges = [...store.edges.values()].map((e) => ({
      from: String(e.from),
      to: String(e.to),
      type: e.type,
      properties: e.props,
    }));
    return { nodes, edges };
  });

  app.post('/api/db/:name/seed/:dataset', auth, async (req) => {
    const name = dbNameSchema.parse((req.params as { name: string }).name);
    await requireCapability(ctx.catalog, req.principal!, name, 'write');
    const dataset = (req.params as { dataset: string }).dataset;
    if (dataset !== 'science-history')
      throw new HttpError(404, 'NOT_FOUND', `unknown dataset "${dataset}"`);
    const db = await ctx.manager.get(name);
    await loadDataset(db, scienceHistory());
    return { committed: { nodes: db.stats().nodeCount, edges: db.stats().edgeCount } };
  });
}
