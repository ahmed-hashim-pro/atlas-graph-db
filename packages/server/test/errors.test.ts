import { AtlasError } from '@atlas/core';
import { AqlError } from '@atlas/query';
import { describe, expect, it } from 'vitest';
import { toProblem } from '../src/errors.js';

describe('toProblem', () => {
  it('maps AqlError to 400 with code + position', () => {
    const e = new AqlError('PARSE_ERROR', 'bad', { line: 2, column: 5 }, 'MATCH\nx');
    const { status, body } = toProblem(e);
    expect(status).toBe(400);
    expect(body.code).toBe('PARSE_ERROR');
    expect(body.line).toBe(2);
    expect(body.column).toBe(5);
    expect(body.snippet).toContain('^');
  });

  it('maps engine AtlasError codes to sensible HTTP statuses', () => {
    expect(toProblem(new AtlasError('CONSTRAINT_VIOLATION', 'dup')).status).toBe(409);
    expect(toProblem(new AtlasError('NOT_FOUND', 'x')).status).toBe(404);
    expect(toProblem(new AtlasError('VALIDATION', 'x')).status).toBe(400);
    expect(toProblem(new AtlasError('TIMEOUT', 'x')).status).toBe(504);
  });

  it('maps DETACH_REQUIRED to 409 Conflict', () => {
    const { status, body } = toProblem(new AtlasError('DETACH_REQUIRED', 'node 1 has 2 edge(s)'));
    expect(status).toBe(409);
    expect(body.code).toBe('DETACH_REQUIRED');
    expect(body.title).toBe('Conflict');
  });

  it('maps unknown errors to 500 without leaking the message as title', () => {
    const { status, body } = toProblem(new Error('boom internal detail'));
    expect(status).toBe(500);
    expect(body.title).toBe('Internal Server Error');
    expect(body.code).toBe('INTERNAL');
  });
});
