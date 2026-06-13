import { AtlasError } from '@atlas/core';
import { AqlError } from '@atlas/query';
import type { ProblemDetails } from '@atlas/protocol';
import { ZodError } from 'zod';

const ENGINE_STATUS: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONSTRAINT_VIOLATION: 409,
  TIMEOUT: 504,
  WAL_CORRUPT: 500,
  WAL_CORRUPT_TAIL: 500,
  INTERNAL: 500,
};

const AQL_STATUS: Record<string, number> = {
  PARSE_ERROR: 400,
  SEMANTIC_ERROR: 400,
  RUNTIME_ERROR: 400,
  TIMEOUT: 504,
  ROW_LIMIT: 413,
};

/** HTTP-layer auth/permission errors carry an explicit status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function toProblem(err: unknown): { status: number; body: ProblemDetails } {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: err.message,
        code: 'VALIDATION',
      },
    };
  }
  if (err instanceof AqlError) {
    const status = AQL_STATUS[err.code] ?? 400;
    return {
      status,
      body: {
        type: 'about:blank',
        title: 'Query Error',
        status,
        detail: err.message,
        code: err.code,
        line: err.line,
        column: err.column,
        snippet: err.snippet,
      },
    };
  }
  if (err instanceof AtlasError) {
    const status = ENGINE_STATUS[err.code] ?? 500;
    return {
      status,
      body: {
        type: 'about:blank',
        title: 'Engine Error',
        status,
        detail: err.message,
        code: err.code,
      },
    };
  }
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: {
        type: 'about:blank',
        title: httpTitle(err.status),
        status: err.status,
        detail: err.message,
        code: err.code,
      },
    };
  }
  // Fastify-native client errors (malformed JSON, body too large, unsupported
  // media type) carry a numeric 4xx statusCode + a FST_ERR_* code. Honor them
  // so client faults are not mis-reported as 500s.
  const native = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (
    typeof native.statusCode === 'number' &&
    native.statusCode >= 400 &&
    native.statusCode < 500
  ) {
    const status = native.statusCode;
    return {
      status,
      body: {
        type: 'about:blank',
        title: httpTitle(status),
        status,
        detail: typeof native.message === 'string' ? native.message : undefined,
        code: typeof native.code === 'string' ? native.code : 'BAD_REQUEST',
      },
    };
  }
  return {
    status: 500,
    body: { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL' },
  };
}

function httpTitle(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  if (status === 429) return 'Too Many Requests';
  return 'Error';
}
