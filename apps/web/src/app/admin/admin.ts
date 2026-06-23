import { Component, signal } from '@angular/core';
import { AuditPanel } from './audit-panel';
import { RolesPanel } from './roles-panel';
import { TokensPanel } from './tokens-panel';
import { UsersPanel } from './users-panel';

type AdminTab = 'tokens' | 'roles' | 'users' | 'audit';

@Component({
  selector: 'app-admin',
  imports: [TokensPanel, RolesPanel, UsersPanel, AuditPanel],
  templateUrl: './admin.html',
})
export class Admin {
  readonly tab = signal<AdminTab>('tokens');
}
