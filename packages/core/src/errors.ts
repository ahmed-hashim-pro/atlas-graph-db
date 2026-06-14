export type AtlasErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONSTRAINT_VIOLATION'
  /** A node still has incident edges; deletion needs { detach: true }. */
  | 'DETACH_REQUIRED'
  | 'TIMEOUT'
  /**
   * Reserved: torn tail of the final WAL segment. Recovery currently
   * auto-truncates with a warning instead of throwing; a strict-open mode in
   * a later milestone may raise this. No code path throws it today.
   */
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
