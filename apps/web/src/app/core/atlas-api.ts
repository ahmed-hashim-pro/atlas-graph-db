import { Injectable } from '@angular/core';
import {
  connect,
  type AtlasClient,
  type Database,
  type DbSummary,
  type SeedResult,
} from '@atlas/client';
import type { UserInfo } from '@atlas/protocol';
import { environment } from '../../environments/environment';

/**
 * The app's single API surface. Wraps a cookie-mode `@atlas/client` so every request
 * carries the httpOnly `atlas_session` cookie (`credentials: 'include'`).
 */
@Injectable({ providedIn: 'root' })
export class AtlasApi {
  private readonly client: AtlasClient = connect(environment.apiBaseUrl, { mode: 'cookie' });

  register(username: string, password: string): Promise<UserInfo> {
    return this.client.register(username, password);
  }
  login(username: string, password: string): Promise<UserInfo> {
    return this.client.login(username, password);
  }
  logout(): Promise<void> {
    return this.client.logout();
  }
  whoami(): Promise<UserInfo | null> {
    return this.client.whoami();
  }
  listDatabases(): Promise<DbSummary[]> {
    return this.client.listDatabases();
  }
  createDatabase(name: string): Promise<{ name: string }> {
    return this.client.createDatabase(name);
  }
  seed(name: string, dataset: string): Promise<SeedResult> {
    return this.client.seed(name, dataset);
  }
  database(name: string): Database {
    return this.client.database(name);
  }
}
