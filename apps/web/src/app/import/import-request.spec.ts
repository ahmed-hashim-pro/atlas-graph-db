import { describe, expect, it } from 'vitest';
import { parseJsonImport, type JsonParse } from './import-request';

describe('parseJsonImport', () => {
  it('accepts a well-formed { nodes, edges } payload and carries the atomic flag', () => {
    const out = parseJsonImport(
      JSON.stringify({
        nodes: [{ tempId: 'a', labels: ['Person'], properties: { name: 'Ada' } }],
        edges: [{ from: 'a', to: 'a', type: 'SELF', properties: {} }],
      }),
      true,
    );
    expect(out.ok).toBe(true);
    const req = (out as Extract<JsonParse, { ok: true }>).value;
    expect(req.atomic).toBe(true);
    expect(req.nodes).toHaveLength(1);
    expect(req.edges).toHaveLength(1);
  });

  it('defaults missing nodes/edges to empty arrays and properties to {}', () => {
    const out = parseJsonImport(JSON.stringify({ nodes: [{ tempId: 'a', labels: ['X'] }] }), false);
    expect(out.ok).toBe(true);
    const req = (out as Extract<JsonParse, { ok: true }>).value;
    expect(req.edges).toEqual([]);
    expect(req.nodes[0].properties).toEqual({});
  });

  it('reports a friendly error for invalid JSON', () => {
    const out = parseJsonImport('{not json', false);
    expect(out.ok).toBe(false);
    expect((out as Extract<JsonParse, { ok: false }>).error).toContain('JSON');
  });

  it('rejects a node missing a tempId', () => {
    const out = parseJsonImport(JSON.stringify({ nodes: [{ labels: ['X'] }] }), false);
    expect(out.ok).toBe(false);
    expect((out as Extract<JsonParse, { ok: false }>).error).toMatch(/tempId/i);
  });

  it('rejects an edge missing from/to/type', () => {
    const out = parseJsonImport(JSON.stringify({ edges: [{ from: 'a' }] }), false);
    expect(out.ok).toBe(false);
  });

  it('rejects a top-level array (must be an object)', () => {
    const out = parseJsonImport('[]', false);
    expect(out.ok).toBe(false);
  });
});
