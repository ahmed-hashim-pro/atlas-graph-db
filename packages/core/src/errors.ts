export type AtlasErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONSTRAINT_VIOLATION'
  | 'TIMEOUT'
  /** Auto-recoverable: a torn write at the tail of the final WAL segment. */
  | 'WAL_CORRUPT_TAIL'
  /** Not auto-recoverable: corruption anywhere else (non-final segment, mid-stream txId gap). */
  | 'WAL_CORRUPT'
  | 'INTERNAL';

export class AtlasError extends Error {
  constructor(
    public readonly code: AtlasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AtlasError';
  }
}
