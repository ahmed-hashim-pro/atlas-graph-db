import { describe, expect, it } from 'vitest';
import { AqlError } from '../src/errors.js';
import { parseQuery } from '../src/parser.js';

function write(src: string) {
  const p = parseQuery(src);
  if (p.statement.type !== 'write') throw new Error(`expected write, got ${p.statement.type}`);
  return p.statement.query;
}

describe('parseQuery — read still works through the new dispatcher', () => {
  it('classifies a MATCH...RETURN as a read statement', () => {
    const p = parseQuery('MATCH (n:Person) RETURN n');
    expect(p.statement.type).toBe('read');
  });
});

describe('parseQuery — CREATE', () => {
  it('parses standalone CREATE with multiple patterns', () => {
    const q = write("CREATE (a:Person {name: 'Ada'}), (a)-[:WROTE]->(d:Document {title: 'Notes'})");
    expect(q.clauses).toHaveLength(1);
    const c = q.clauses[0]!;
    expect(c.clause).toBe('create');
    if (c.clause === 'create') expect(c.patterns).toHaveLength(2);
    expect(q.readMatch).toBeUndefined();
  });

  it('parses MATCH ... CREATE ... RETURN', () => {
    const q = write('MATCH (a:Person) CREATE (a)-[:KNOWS]->(b:Person {name: $n}) RETURN b');
    expect(q.readMatch?.patterns).toHaveLength(1);
    expect(q.clauses[0]!.clause).toBe('create');
    expect(q.returnItems).toHaveLength(1);
  });
});

describe('parseQuery — MERGE/SET/REMOVE/DELETE', () => {
  it('parses MERGE with ON CREATE SET / ON MATCH SET', () => {
    const q = write(
      'MERGE (p:Person {email: $e}) ON CREATE SET p.created = $now ON MATCH SET p.seen = $now RETURN p',
    );
    const c = q.clauses[0]!;
    expect(c.clause).toBe('merge');
    if (c.clause === 'merge') {
      expect(c.onCreate).toHaveLength(1);
      expect(c.onMatch).toHaveLength(1);
      expect(c.onCreate[0]).toMatchObject({ target: 'p', property: 'created' });
    }
  });

  it('parses SET multiple items and REMOVE', () => {
    const q = write('MATCH (p:Person) SET p.born = 1815, p.field = $f REMOVE p.tmp RETURN p');
    expect(q.clauses[0]).toMatchObject({ clause: 'set' });
    expect(q.clauses[1]).toMatchObject({ clause: 'remove' });
    if (q.clauses[0]!.clause === 'set') expect(q.clauses[0]!.items).toHaveLength(2);
  });

  it('parses DELETE and DETACH DELETE with multiple targets', () => {
    const a = write('MATCH (p:Person) DELETE p');
    expect(a.clauses[0]).toMatchObject({ clause: 'delete', detach: false });
    const b = write('MATCH (p)-[r]->(q) DETACH DELETE p, q');
    const c = b.clauses[0]!;
    expect(c.clause).toBe('delete');
    if (c.clause === 'delete') {
      expect(c.detach).toBe(true);
      expect(c.targets).toHaveLength(2);
    }
  });

  it('chains multiple write clauses', () => {
    const q = write('CREATE (n:T {v: 1}) SET n.v = 2 RETURN n');
    expect(q.clauses.map((c) => c.clause)).toEqual(['create', 'set']);
  });
});

describe('parseQuery — write validation', () => {
  const err = (src: string): AqlError => {
    try {
      parseQuery(src);
    } catch (e) {
      return e as AqlError;
    }
    throw new Error('expected throw');
  };

  it('SET/REMOVE/DELETE on unknown variables fail', () => {
    expect(err('MATCH (p) SET q.x = 1 RETURN p').code).toBe('SEMANTIC_ERROR');
    expect(err('MATCH (p) DELETE q').code).toBe('SEMANTIC_ERROR');
  });

  it('DELETE target must be a plain variable', () => {
    expect(err('MATCH (p) DELETE p.name').code).toBe('SEMANTIC_ERROR');
  });

  it('CREATE cannot reintroduce a bound variable with labels/props', () => {
    expect(err('MATCH (a:Person) CREATE (a:Person) RETURN a').code).toBe('SEMANTIC_ERROR');
  });

  it('aggregates are not allowed in SET/MERGE values', () => {
    expect(err('MATCH (p) SET p.c = count(p) RETURN p').code).toBe('SEMANTIC_ERROR');
  });

  it('RETURN after write still validates variable references', () => {
    expect(err('CREATE (n:T) RETURN m').code).toBe('SEMANTIC_ERROR');
  });
});
