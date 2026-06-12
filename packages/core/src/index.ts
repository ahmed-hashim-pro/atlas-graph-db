export { ChangeFeed, type ChangeEvent } from './change-feed.js';
export { AtlasDatabase, openDatabase, type OpenOptions, type ReadLease } from './database.js';
export { AtlasError, type AtlasErrorCode } from './errors.js';
export { type RangeQuery } from './index/btree.js';
export { type ScalarValue } from './index/keys.js';
export { type SchemaSummary } from './schema.js';
export { GraphStore } from './store.js';
export {
  EdgeTraversal,
  GraphView,
  NodeTraversal,
  type TraversalPath,
} from './traversal/traversal.js';
export { TxBuilder } from './tx.js';
export {
  validateIndexDef,
  validateProps,
  type CommittedBatch,
  type EdgeId,
  type EdgeRecord,
  type IndexDef,
  type IndexKind,
  type NodeId,
  type NodeRecord,
  type Op,
  type Primitive,
  type Props,
  type PropertyValue,
} from './types.js';
