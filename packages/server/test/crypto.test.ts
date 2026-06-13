import { describe, expect, it } from 'vitest';
import { generateToken, hashPassword, hashToken, verifyPassword, verifyToken } from '../src/crypto.js';

describe('password hashing (argon2id)', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces distinct salted hashes for the same password', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('API tokens', () => {
  it('generates a high-entropy token and verifies its hash', async () => {
    const { token, hash } = await generateToken();
    expect(token).toHaveLength(43); // 32 bytes base64url, no padding
    expect(token).not.toEqual(hash);
    expect(await verifyToken(hash, token)).toBe(true);
    expect(await verifyToken(hash, 'atlas_deadbeef')).toBe(false);
  });

  it('hashToken is deterministic enough to look up, verifyToken confirms', async () => {
    const { token, hash } = await generateToken();
    // hashToken is argon2id (salted) — NOT used as a lookup key; verifyToken does the check.
    const other = await hashToken(token);
    expect(await verifyToken(other, token)).toBe(true);
  });
});
