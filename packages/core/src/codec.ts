import { decode, encode } from '@msgpack/msgpack';
import type { CommittedBatch } from './types.js';

export function encodeBatch(batch: CommittedBatch): Uint8Array {
  return encode(batch);
}

export function decodeBatch(payload: Uint8Array): CommittedBatch {
  return decode(payload) as CommittedBatch;
}
