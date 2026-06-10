export type AtlasErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONSTRAINT_VIOLATION'
  | 'TIMEOUT'
  | 'WAL_CORRUPT_TAIL'
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
