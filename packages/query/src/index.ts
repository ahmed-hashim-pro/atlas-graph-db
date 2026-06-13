export { executeQuery, explainQuery, type QueryOptions, type QueryResult } from './api.js';
export {
  AGGREGATES,
  SCALAR_FUNCS,
  walkExpr,
  type EdgePattern,
  type Expr,
  type NodePattern,
  type ParsedQuery,
  type PathPattern,
  type ReadQuery,
  type ReturnItem,
} from './ast.js';
export { AqlError, renderSnippet, type AqlErrorCode } from './errors.js';
export { runRead, type ExecOptions, type ReadResult } from './exec.js';
export { evalExpr, type Binding, type RuntimeValue } from './eval.js';
export { lex, type Token, type TokenType } from './lexer.js';
export { parseExpression, parseQuery, TokenStream } from './parser.js';
export { renderExpr, serializePlan, type PlanNode } from './plan.js';
export { planQuery } from './planner.js';
export { runWrite, type WriteResult } from './write.js';
export { runDdl, type DdlResult } from './ddl.js';
export { runCall, type CallResult } from './call.js';
export { describeCallPlan, describeDdlPlan, describeWritePlan } from './plan.js';
export type {
  CallStatement,
  DdlStatement,
  SetItem,
  RemoveItem,
  Statement,
  WriteClause,
  WriteQuery,
} from './ast.js';
