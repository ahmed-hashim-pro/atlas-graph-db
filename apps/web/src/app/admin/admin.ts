import { Component, signal } from '@angular/core';
import { RolesPanel } from './roles-panel';
import { TokensPanel } from './tokens-panel';

type AdminTab = 'tokens' | 'roles';

@Component({
  selector: 'app-admin',
  imports: [TokensPanel, RolesPanel],
  templateUrl: './admin.html',
})
export class Admin {
  readonly tab = signal<AdminTab>('tokens');
}
