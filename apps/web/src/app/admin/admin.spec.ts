import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasApi } from '../core/atlas-api';
import { Admin } from './admin';

describe('Admin page', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the Tokens, Roles, Users and Audit tabs', async () => {
    await TestBed.configureTestingModule({
      imports: [Admin],
      providers: [
        {
          provide: AtlasApi,
          useValue: {
            listTokens: vi.fn().mockResolvedValue([]),
            listDatabases: vi.fn().mockResolvedValue([]),
            listUsers: vi.fn().mockResolvedValue([]),
            listAudit: vi.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Admin);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Tokens');
    expect(text).toContain('Roles');
    expect(text).toContain('Users');
    expect(text).toContain('Audit');
  });

  it('switches to the Users tab', async () => {
    await TestBed.configureTestingModule({
      imports: [Admin],
      providers: [
        {
          provide: AtlasApi,
          useValue: {
            listTokens: vi.fn().mockResolvedValue([]),
            listDatabases: vi.fn().mockResolvedValue([]),
            listUsers: vi.fn().mockResolvedValue([]),
            listAudit: vi.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Admin);
    fixture.detectChanges();
    fixture.componentInstance.tab.set('users');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Users');
  });
});
