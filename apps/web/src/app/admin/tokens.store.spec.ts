import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { TokensStore } from './tokens.store';
import type { CreatedToken, TokenSummary } from '@atlas/client';

const list: TokenSummary[] = [{ tokenId: 't1', name: 'ci' }];
const created: CreatedToken = { tokenId: 't2', name: 'cli', token: 't2.secretsecret' };

function withApi(api: Partial<AtlasApi>): TokensStore {
  TestBed.configureTestingModule({ providers: [{ provide: AtlasApi, useValue: api }] });
  return TestBed.inject(TokensStore);
}

describe('TokensStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates the tokens signal', async () => {
    const store = withApi({ listTokens: vi.fn().mockResolvedValue(list) });
    await store.load();
    expect(store.tokens()).toEqual(list);
  });

  it('create() shows the full secret once and reloads the list', async () => {
    const listTokens = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce([...list, { tokenId: 't2', name: 'cli' }]);
    const createToken = vi.fn().mockResolvedValue(created);
    const store = withApi({ listTokens, createToken });
    await store.load();
    await store.create('cli');
    expect(createToken).toHaveBeenCalledWith('cli');
    expect(store.lastSecret()).toBe('t2.secretsecret');
    expect(store.tokens().map((t) => t.tokenId)).toContain('t2');
  });

  it('revoke() removes the token and reloads', async () => {
    const listTokens = vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce([]);
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const store = withApi({ listTokens, revokeToken });
    await store.load();
    await store.revoke('t1');
    expect(revokeToken).toHaveBeenCalledWith('t1');
    expect(store.tokens()).toEqual([]);
  });

  it('clearSecret() hides the one-time secret', async () => {
    const store = withApi({
      listTokens: vi.fn().mockResolvedValue(list),
      createToken: vi.fn().mockResolvedValue(created),
    });
    await store.create('cli');
    expect(store.lastSecret()).not.toBe('');
    store.clearSecret();
    expect(store.lastSecret()).toBe('');
  });
});
