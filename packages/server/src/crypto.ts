import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false; // malformed hash → not a match, never throw into the auth path
  }
}

/** A fresh API token (shown once) plus its argon2id hash (stored). */
export async function generateToken(): Promise<{ token: string; hash: string }> {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: await hash(token, ARGON_OPTS) };
}

export function hashToken(token: string): Promise<string> {
  return hash(token, ARGON_OPTS);
}

export async function verifyToken(storedHash: string, token: string): Promise<boolean> {
  try {
    return await verify(storedHash, token);
  } catch {
    return false;
  }
}
