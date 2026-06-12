import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';

describe('parseQuery — patterns', () => {
  it('parses the spec example end to end', () => {
    const { explain, query } = parseQuery(
      "MATCH (p:Person)-[:WROTE]->(d:Document)\nWHERE d.year > 1840 AND p.name CONTAINS 'lovelace'\nRETURN p.name, count(d) AS works\nORDER BY works DESC LIMIT 10",
    );
    expect(explain).toBe(false);
    expect(query.patterns).toHaveLength(1);
    const pat = query.patterns[0]!;
    expect(pat.nodes.map((n) => n.labels[0])).toEqual(['Person', 'Document']);
    expect(pat.edges[0]).toMatchObject({ types: ['WROTE'], direction: 'out' });
    expect(query.where?.kind).toBe('and');
    expect(query.items).toHaveLength(2);
    expect(query.items[1]).toMatchObject({ alias: 'works' });
    expect(query.orderBy[0]).toMatchObject({ desc: true });
    expect(query.limit).toMatchObject({ kind: 'literal', value: 10 });
  });

  it('parses directions, multi-types, inline props, and anonymous elements', () => {
    const { query } = parseQuery(
      'MATCH (a {name: $n})<-[:CITES|MENTIONS]-(b), (b)-[e]-(c:Doc:Old) RETURN a',
    );
    const [p1, p2] = query.patterns;
    expect(p1!.edges[0]).toMatchObject({ types: ['CITES', 'MENTIONS'], direction: 'in' });
    expect(p1!.nodes[0]!.props[0]).toMatchObject({ property: 'name' });
    expect(p2!.edges[0]).toMatchObject({ direction: 'both', variable: 'e', types: [] });
    expect(p2!.nodes[1]!.labels).toEqual(['Doc', 'Old']);
  });

  it('parses variable-length forms with defaults and caps', () => {
    const q = (src: string) => parseQuery(src).query.patterns[0]!.edges[0]!.varLength;
    expect(q('MATCH (a)-[:R*]->(b) RETURN a')).toEqual({ min: 1, max: 8 });
    expect(q('MATCH (a)-[:R*3]->(b) RETURN a')).toEqual({ min: 3, max: 3 });
    expect(q('MATCH (a)-[:R*1..3]->(b) RETURN a')).toEqual({ min: 1, max: 3 });
    expect(() => parseQuery('MATCH (a)-[:R*1..20]->(b) RETURN a')).toThrowError(AqlError);
  });

  it('parses EXPLAIN prefix and DISTINCT/SKIP', () => {
    const { explain, query } = parseQuery('EXPLAIN MATCH (n) RETURN DISTINCT n SKIP $s LIMIT 5');
    expect(explain).toBe(true);
    expect(query.distinct).toBe(true);
    expect(query.skip).toMatchObject({ kind: 'param', name: 's' });
  });
});

describe('parseQuery — semantic validation', () => {
  const err = (src: string): AqlError => {
    try {
      parseQuery(src);
    } catch (e) {
      return e as AqlError;
    }
    throw new Error('expected parseQuery to throw');
  };

  it('rejects unknown variables with position', () => {
    const e = err('MATCH (p:Person) RETURN q.name');
    expect(e.code).toBe('SEMANTIC_ERROR');
    expect(e.message).toContain('q');
    expect(e.snippet).toContain('^');
  });

  it('rejects aggregates in WHERE and unknown functions', () => {
    expect(err('MATCH (p) WHERE count(p) > 1 RETURN p').code).toBe('SEMANTIC_ERROR');
    expect(err('MATCH (p) RETURN frobnicate(p)').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects a variable bound as both node and edge', () => {
    expect(err('MATCH (x)-[x]->(y) RETURN x').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects variables on variable-length edges (v1)', () => {
    expect(err('MATCH (a)-[e:R*1..2]->(b) RETURN a').code).toBe('SEMANTIC_ERROR');
  });

  it('rejects writes (M4b scope) as parse errors', () => {
    expect(err("CREATE (n:X) RETURN n").code).toBe('PARSE_ERROR');
  });
});
