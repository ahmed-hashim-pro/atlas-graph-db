import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AtlasApi } from './atlas-api';

describe('AtlasApi', () => {
  it('is injectable and exposes the auth + database methods', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    expect(typeof api.register).toBe('function');
    expect(typeof api.login).toBe('function');
    expect(typeof api.logout).toBe('function');
    expect(typeof api.whoami).toBe('function');
    expect(typeof api.listDatabases).toBe('function');
    expect(typeof api.createDatabase).toBe('function');
    expect(typeof api.seed).toBe('function');
    expect(typeof api.database).toBe('function');
  });

  it('delegates a database handle through the client', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    const db = api.database('kb');
    expect(typeof db.query).toBe('function');
    expect(typeof db.schema).toBe('function');
  });

  it('exposes the admin + import methods', () => {
    const api = TestBed.runInInjectionContext(() => new AtlasApi());
    expect(typeof api.createToken).toBe('function');
    expect(typeof api.listTokens).toBe('function');
    expect(typeof api.revokeToken).toBe('function');
    expect(typeof api.grantRole).toBe('function');
    expect(typeof api.revokeRole).toBe('function');
    expect(typeof api.getDatabase).toBe('function');
    expect(typeof api.import).toBe('function');
    expect(typeof api.importCsv).toBe('function');
  });
});
