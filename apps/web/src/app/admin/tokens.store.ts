import { inject, Injectable, signal } from '@angular/core';
import type { TokenSummary } from '@atlas/client';
import { AtlasApi } from '../core/atlas-api';

@Injectable({ providedIn: 'root' })
export class TokensStore {
  private readonly api = inject(AtlasApi);
  private readonly _tokens = signal<TokenSummary[]>([]);
  private readonly _error = signal('');
  /** The full secret of the most recently created token — shown once, then cleared. */
  private readonly _lastSecret = signal('');

  readonly tokens = this._tokens.asReadonly();
  readonly error = this._error.asReadonly();
  readonly lastSecret = this._lastSecret.asReadonly();

  async load(): Promise<void> {
    this._error.set('');
    try {
      this._tokens.set(await this.api.listTokens());
    } catch {
      this._error.set('Could not load tokens.');
    }
  }

  async create(name: string): Promise<void> {
    this._error.set('');
    try {
      const created = await this.api.createToken(name);
      this._lastSecret.set(created.token);
      await this.load();
    } catch {
      this._error.set('Could not create the token.');
    }
  }

  async revoke(tokenId: string): Promise<void> {
    this._error.set('');
    try {
      await this.api.revokeToken(tokenId);
      await this.load();
    } catch {
      this._error.set('Could not revoke the token.');
    }
  }

  clearSecret(): void {
    this._lastSecret.set('');
  }
}
