import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { TokensPanel } from './tokens-panel';
import type { CreatedToken, TokenSummary } from '@atlas/client';

const list: TokenSummary[] = [{ tokenId: 't1', name: 'ci' }];
const created: CreatedToken = { tokenId: 't2', name: 'cli', token: 't2.secret' };

describe('TokensPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists tokens and shows the one-time secret after create', async () => {
    const listTokens = vi.fn().mockResolvedValue(list);
    const createToken = vi.fn().mockResolvedValue(created);
    await TestBed.configureTestingModule({
      imports: [TokensPanel],
      providers: [{ provide: AtlasApi, useValue: { listTokens, createToken } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(TokensPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('ci');

    fixture.componentInstance.newName.set('cli');
    await fixture.componentInstance.create();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('t2.secret');
  });
});
