import type { ImportReq } from '@atlas/protocol';

/** A discriminated parse result so callers branch on `ok` without throwing. */
export type JsonParse = { ok: true; value: ImportReq } | { ok: false; error: string };

interface RawNode {
  tempId?: unknown;
  labels?: unknown;
  properties?: unknown;
}
interface RawEdge {
  from?: unknown;
  to?: unknown;
  type?: unknown;
  properties?: unknown;
}

/** The protocol's constrained property bag (scalars + scalar arrays). */
type ImportProps = ImportReq['nodes'][number]['properties'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function asProps(v: unknown): ImportProps {
  // Pass-through at the trust boundary; the server (zod) is the authoritative validator.
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as ImportProps) : {};
}

/**
 * Validate a pasted/loaded JSON string into an `ImportReq` (spec §6.4: object with
 * `nodes:[{tempId,labels,properties}]` and `edges:[{from,to,type,properties}]`).
 * Missing arrays default to empty; missing `properties` default to `{}`; the
 * `atomic` flag is supplied by the caller (the UI toggle), not read from the JSON.
 */
export function parseJsonImport(text: string, atomic: boolean): JsonParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Invalid JSON — could not parse the payload.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: 'Import payload must be an object with "nodes" and "edges".' };

  const body = raw as { nodes?: unknown; edges?: unknown };
  const rawNodes = body.nodes ?? [];
  const rawEdges = body.edges ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges))
    return { ok: false, error: '"nodes" and "edges" must be arrays.' };

  const nodes: ImportReq['nodes'] = [];
  for (const [i, n] of (rawNodes as RawNode[]).entries()) {
    if (typeof n?.tempId !== 'string' || n.tempId.length === 0)
      return { ok: false, error: `Node ${i} is missing a string "tempId".` };
    if (!isStringArray(n.labels) || n.labels.length === 0)
      return { ok: false, error: `Node ${i} ("${n.tempId}") needs a non-empty "labels" array.` };
    nodes.push({ tempId: n.tempId, labels: n.labels, properties: asProps(n.properties) });
  }

  const edges: ImportReq['edges'] = [];
  for (const [i, e] of (rawEdges as RawEdge[]).entries()) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string' || typeof e?.type !== 'string')
      return { ok: false, error: `Edge ${i} needs string "from", "to", and "type".` };
    edges.push({ from: e.from, to: e.to, type: e.type, properties: asProps(e.properties) });
  }

  return { ok: true, value: { nodes, edges, atomic } };
}
