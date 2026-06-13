# AQL — Atlas Query Language Reference

AQL is Atlas's Cypher-like query language. Every statement runs through
`executeQuery(db, text, { params, timeoutMs, maxRows })`. Prefix any statement
with `EXPLAIN` to get its plan as JSON instead of executing it.

## Reads

    MATCH (p:Person)-[:WROTE]->(d:Document)
    WHERE d.year > 1840 AND p.name CONTAINS 'lovelace'
    RETURN p.name, count(d) AS works
    ORDER BY works DESC SKIP 0 LIMIT 10

- **Patterns:** node `(v:Label {prop: value})`, edges `-[:TYPE]->`, `<-[:TYPE]-`,
  `-[:A|B]-` (multi-type, undirected), variable-length `-[:TYPE*1..3]->`
  (default `*` = 1..8, max 15; no edge variable).
- **WHERE:** `= <> < <= > >=`, `AND OR NOT`, `CONTAINS`, `STARTS WITH`,
  `ENDS WITH`, `IN [..]`, `EXISTS(v.prop)`.
- **RETURN:** projections, `AS` aliases, `DISTINCT`, aggregates `count`,
  `collect`, `sum`, `avg`, `min`, `max` (implicit grouping by the non-aggregate
  items), scalar `id(v)`, `labels(n)`, `type(e)`.
- **Tail:** `ORDER BY ... [ASC|DESC]`, `SKIP n`, `LIMIT n` (integer or `$param`).

## Null & equality semantics (v1)

Comparisons involving a missing/`NULL` value are `false` (not three-valued).
Equality is type-strict: `1 = '1'` is false. Use `EXISTS(v.prop)` to test
presence.

## Writes

    CREATE (a:Person {name: 'Ada'})-[:WROTE]->(d:Document {title: 'Notes'})
    MATCH (p:Person) SET p.active = true REMOVE p.tmp
    MATCH (p:Person {name: 'Ada'}) DETACH DELETE p

- **CREATE** builds nodes/edges; edges need exactly one type and a direction.
- **SET** `v.prop = expr` (multiple comma-separated); setting `NULL` removes the
  property. **REMOVE** `v.prop` deletes a property.
- **DELETE v** removes an edgeless node or an edge; **DETACH DELETE v** removes a
  node and all its edges.
- A leading `MATCH` runs the write once per matched row. A trailing `RETURN`
  projects the post-write bindings.
- Every statement is atomic: any error rolls back the whole statement.

## MERGE

    MERGE (p:Person {email: $e})
      ON CREATE SET p.created = $now
      ON MATCH  SET p.seen = $now

MERGE matches the **whole pattern**; if no complete match exists it creates the
entire pattern (matching some elements and creating others is never partial).
`ON CREATE SET` runs only when created, `ON MATCH SET` only when matched. A
create that violates a unique constraint raises `CONSTRAINT_VIOLATION`.

*v1 limitation:* MERGE matches against committed state; chained MERGEs in one
statement do not see each other's just-created nodes.

## Schema DDL

    CREATE INDEX ON :Person(born)
    CREATE FULLTEXT INDEX ON :Document(title)
    CREATE UNIQUE CONSTRAINT ON :User(email)
    DROP INDEX ON :Person(born)
    SHOW INDEXES
    SHOW CONSTRAINTS

## Algorithms

    CALL algo.pagerank({damping: 0.85, iterations: 20}) YIELD node, score
    CALL algo.shortestPath({from: $a, to: $b, weightProp: 'w'}) YIELD path, cost
    CALL algo.components({mode: 'strong'}) YIELD node, component

Available: `pagerank`, `louvain`, `components`, `degree`, `betweenness`,
`shortestPath`, `allShortestPaths`, `bfs`, `dfs`, `topoSort`, `cycles`. `YIELD`
selects and optionally renames result columns. See the §5.2 signature table for
each procedure's options and yielded columns.

## Errors

Parse, semantic, and runtime errors are `AqlError` with `code`, `message`,
`line`, `column`, and a caret `snippet`. Runtime guards raise `TIMEOUT`
(per-query budget) and `ROW_LIMIT` (max rows) rather than truncating.
