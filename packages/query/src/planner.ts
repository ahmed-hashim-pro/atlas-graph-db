import type { GraphStore } from '@atlas/core';
import { AGGREGATES, walkExpr, type Expr, type PathPattern, type ReadQuery } from './ast.js';
import { renderExpr, type PlanNode } from './plan.js';

interface SeekCandidate {
  property: string;
  value: Expr;
}

/** var.prop = literal/param equalities from inline props plus top-level AND conjuncts of WHERE. */
function equalitiesFor(
  pattern: PathPattern,
  nodeIdx: number,
  where: Expr | undefined,
): SeekCandidate[] {
  const node = pattern.nodes[nodeIdx]!;
  const out: SeekCandidate[] = node.props.map((p) => ({ property: p.property, value: p.value }));
  if (node.variable !== undefined && where) {
    const conjuncts: Expr[] = [];
    const flatten = (e: Expr): void => {
      if (e.kind === 'and') {
        flatten(e.left);
        flatten(e.right);
      } else {
        conjuncts.push(e);
      }
    };
    flatten(where);
    for (const c of conjuncts) {
      if (
        c.kind === 'cmp' &&
        c.op === '=' &&
        c.left.kind === 'prop' &&
        c.left.target === node.variable &&
        (c.right.kind === 'literal' || c.right.kind === 'param')
      )
        out.push({ property: c.left.property, value: c.right });
    }
  }
  return out;
}

function hasScalarIndex(store: GraphStore, label: string, property: string): boolean {
  return (
    store.indexes.has({ kind: 'property', label, property }) ||
    store.indexes.has({ kind: 'unique', label, property })
  );
}

interface StartChoice {
  nodeIdx: number;
  scan: PlanNode;
  consumedLabel?: string;
  consumedProperty?: string;
}

let anonCounter = 0;

/** Stable synthetic variable for anonymous pattern elements (per-plan counter). */
function varName(explicit: string | undefined, role: string): string {
  return explicit ?? `__${role}${anonCounter++}`;
}

function chooseStart(
  pattern: PathPattern,
  where: Expr | undefined,
  store: GraphStore,
  bound: Set<string>,
): StartChoice {
  let best: StartChoice | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pattern.nodes.length; i++) {
    const node = pattern.nodes[i]!;
    if (node.variable !== undefined && bound.has(node.variable)) {
      return { nodeIdx: i, scan: { op: 'FromBound', variable: node.variable } };
    }
    let choice: StartChoice | undefined;
    let cost = store.nodes.size;
    for (const label of node.labels) {
      for (const eq of equalitiesFor(pattern, i, where)) {
        if (hasScalarIndex(store, label, eq.property)) {
          choice = {
            nodeIdx: i,
            scan: {
              op: 'IndexSeek',
              variable: varName(node.variable, 'n'),
              label,
              property: eq.property,
              value: renderExpr(eq.value),
              valueAst: eq.value,
              estCost: 1,
            },
            consumedLabel: label,
            consumedProperty: eq.property,
          };
          cost = 1;
          break;
        }
      }
      if (choice) break;
    }
    if (!choice && node.labels.length > 0) {
      let cheapest = node.labels[0]!;
      for (const label of node.labels)
        if (store.labelCount(label) < store.labelCount(cheapest)) cheapest = label;
      cost = store.labelCount(cheapest);
      choice = {
        nodeIdx: i,
        scan: { op: 'LabelScan', variable: varName(node.variable, 'n'), label: cheapest, estCost: cost },
        consumedLabel: cheapest,
      };
    }
    if (!choice) {
      choice = {
        nodeIdx: i,
        scan: { op: 'AllNodesScan', variable: varName(node.variable, 'n'), estCost: cost },
      };
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = choice;
    }
  }
  return best!;
}

const FLIP = { out: 'in', in: 'out', both: 'both' } as const;

export function planQuery(query: ReadQuery, store: GraphStore): PlanNode {
  anonCounter = 0;
  const bound = new Set<string>();
  const varOf = new Map<object, string>(); // pattern element -> assigned variable
  let root: PlanNode | undefined;

  for (const pattern of query.patterns) {
    const start = chooseStart(pattern, query.where, store, bound);
    // Assign variables to every element up front so expands agree on names.
    const nodeVars = pattern.nodes.map((n) => varName(n.variable, 'n'));
    const startNode = pattern.nodes[start.nodeIdx]!;
    if (start.scan.op !== 'FromBound') {
      nodeVars[start.nodeIdx] = (start.scan as { variable: string }).variable;
    } else {
      nodeVars[start.nodeIdx] = startNode.variable!;
    }
    let chain: PlanNode = start.scan;
    // Residual start-node checks not consumed by the scan:
    const residLabels = startNode.labels.filter((l) => l !== start.consumedLabel);
    if (start.scan.op !== 'FromBound' && residLabels.length === 0 && startNode.labels.length === 0) {
      // AllNodesScan with no labels: nothing to check
    }
    chain = withNodeChecks(chain, nodeVars[start.nodeIdx]!, residLabels, startNode, start.consumedProperty);
    // Expand left (toward index 0) then right (toward the end).
    for (let i = start.nodeIdx - 1; i >= 0; i--) {
      const edge = pattern.edges[i]!;
      chain = expandStep(chain, nodeVars[i + 1]!, nodeVars[i]!, edge, FLIP[edge.direction], pattern.nodes[i]!);
    }
    for (let i = start.nodeIdx; i < pattern.edges.length; i++) {
      const edge = pattern.edges[i]!;
      chain = expandStep(chain, nodeVars[i]!, nodeVars[i + 1]!, edge, edge.direction, pattern.nodes[i + 1]!);
    }
    for (const [i, n] of pattern.nodes.entries()) {
      if (n.variable !== undefined) bound.add(n.variable);
      varOf.set(n, nodeVars[i]!);
    }
    for (const e of pattern.edges) if (e.variable !== undefined) bound.add(e.variable);
    root = root === undefined ? chain : joinPlans(root, chain);
  }

  let plan = root!;
  if (query.where)
    plan = { op: 'Filter', expr: renderExpr(query.where), exprAst: query.where, child: plan };

  const hasAggregate = query.items.some((item) => {
    let agg = false;
    walkExpr(item.expr, (e) => {
      if (e.kind === 'call' && AGGREGATES.has(e.func)) agg = true;
    });
    return agg;
  });
  const columns = query.items.map((item, i) => item.alias ?? renderExpr(item.expr) ?? `col${i}`);
  if (hasAggregate) {
    plan = {
      op: 'Aggregate',
      groupBy: query.items.filter((it) => !isAggregateItem(it.expr)).map((it) => it.alias ?? renderExpr(it.expr)),
      aggregates: query.items.filter((it) => isAggregateItem(it.expr)).map((it) => renderExpr(it.expr)),
      child: plan,
    };
  } else {
    plan = { op: 'Project', columns, child: plan };
  }
  if (query.distinct) plan = { op: 'Distinct', child: plan };
  if (query.orderBy.length > 0)
    plan = { op: 'Sort', keys: query.orderBy.map((o) => `${renderExpr(o.expr)}${o.desc ? ' DESC' : ''}`), child: plan };
  if (query.skip !== undefined || query.limit !== undefined)
    plan = {
      op: 'SkipLimit',
      skip: query.skip ? renderCount(query.skip) : undefined,
      limit: query.limit ? renderCount(query.limit) : undefined,
      child: plan,
    };
  return plan;
}

export function isAggregateItem(e: Expr): boolean {
  let agg = false;
  walkExpr(e, (x) => {
    if (x.kind === 'call' && AGGREGATES.has(x.func)) agg = true;
  });
  return agg;
}

function renderCount(e: Expr): number | string {
  return e.kind === 'literal' ? (e.value as number) : `$${(e as { name: string }).name}`;
}

function expandStep(
  child: PlanNode,
  from: string,
  to: string,
  edge: { variable?: string; types: string[]; varLength?: { min: number; max: number } },
  direction: 'out' | 'in' | 'both',
  toNode: { labels: string[]; props: { property: string; value: Expr }[]; variable?: string; pos: { line: number; column: number } },
): PlanNode {
  const base: PlanNode = edge.varLength
    ? {
        op: 'VarLengthExpand',
        from,
        to,
        types: edge.types,
        direction,
        min: edge.varLength.min,
        max: edge.varLength.max,
        toLabels: toNode.labels,
        child,
      }
    : {
        op: 'Expand',
        from,
        to,
        edgeVariable: edge.variable,
        types: edge.types,
        direction,
        toLabels: toNode.labels,
        child,
      };
  return withNodeChecks(base, to, [], toNode, undefined);
}

/** Inline property equalities (and residual labels for starts) become Filter nodes. */
function withNodeChecks(
  child: PlanNode,
  variable: string,
  residualLabels: string[],
  node: { props: { property: string; value: Expr }[]; pos: { line: number; column: number } },
  consumedProperty: string | undefined,
): PlanNode {
  let plan = child;
  for (const label of residualLabels) {
    const expr: Expr = {
      kind: 'in',
      needle: { kind: 'literal', value: label, pos: node.pos },
      haystack: { kind: 'call', func: 'labels', arg: { kind: 'variable', name: variable, pos: node.pos }, distinct: false, pos: node.pos },
      pos: node.pos,
    };
    plan = { op: 'Filter', expr: renderExpr(expr), exprAst: expr, child: plan };
  }
  for (const p of node.props) {
    if (p.property === consumedProperty) continue;
    const expr: Expr = {
      kind: 'cmp',
      op: '=',
      left: { kind: 'prop', target: variable, property: p.property, pos: node.pos },
      right: p.value,
      pos: node.pos,
    };
    plan = { op: 'Filter', expr: renderExpr(expr), exprAst: expr, child: plan };
  }
  return plan;
}

function joinPlans(left: PlanNode, right: PlanNode): PlanNode {
  // If the right chain starts FromBound it continues the left stream directly.
  let leaf: PlanNode = right;
  while ('child' in leaf && leaf.child) leaf = leaf.child;
  if (leaf.op === 'FromBound') {
    // splice: replace the FromBound leaf's position by chaining right on top of left
    return spliceChild(right, left, leaf);
  }
  return { op: 'CartesianProduct', left, right };
}

function spliceChild(tree: PlanNode, replacement: PlanNode, leaf: PlanNode): PlanNode {
  if (tree === leaf) return replacement;
  if ('child' in tree && tree.child)
    return { ...tree, child: spliceChild(tree.child, replacement, leaf) } as PlanNode;
  return tree;
}
