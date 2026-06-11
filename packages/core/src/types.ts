import { AtlasError } from './errors.js';

export type NodeId = number;
export type EdgeId = number;

export type Primitive = string | number | boolean | Date;
export type PropertyValue = Primitive | string[] | number[] | boolean[] | Date[];
export type Props = Record<string, PropertyValue>;

export interface NodeRecord {
  id: NodeId;
  labels: string[];
  props: Props;
}

export interface EdgeRecord {
  id: EdgeId;
  type: string;
  from: NodeId;
  to: NodeId;
  props: Props;
}

export type Op =
  | { op: 'createNode'; id: NodeId; labels: string[]; props: Props }
  | { op: 'createEdge'; id: EdgeId; type: string; from: NodeId; to: NodeId; props: Props }
  | { op: 'setNodeProps'; id: NodeId; set: Props; remove: string[] }
  | { op: 'setEdgeProps'; id: EdgeId; set: Props; remove: string[] }
  | { op: 'deleteEdge'; id: EdgeId }
  | { op: 'deleteNode'; id: NodeId };

export interface CommittedBatch {
  txId: number;
  ops: Op[];
}

function isPrimitive(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (v instanceof Date && !Number.isNaN(v.getTime()))
  );
}

export function validateProps(props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (key.length === 0) throw new AtlasError('VALIDATION', 'property name must not be empty');
    if (Array.isArray(value)) {
      if (value.length > 0) {
        const kind = typeof value[0] === 'object' ? 'date' : typeof value[0];
        for (const item of value) {
          const itemKind = typeof item === 'object' ? 'date' : typeof item;
          if (!isPrimitive(item) || itemKind !== kind)
            throw new AtlasError(
              'VALIDATION',
              `property "${key}": arrays must be homogeneous primitives`,
            );
        }
      }
    } else if (!isPrimitive(value)) {
      throw new AtlasError('VALIDATION', `property "${key}": unsupported value`);
    }
  }
}
