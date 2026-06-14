import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RoleName } from '@atlas/protocol';
import { RolesStore } from './roles.store';

@Component({
  selector: 'app-roles-panel',
  imports: [FormsModule],
  templateUrl: './roles-panel.html',
  providers: [RolesStore],
})
export class RolesPanel implements OnInit {
  readonly store = inject(RolesStore);
  readonly grantUser = signal('');
  readonly grantRole = signal<RoleName>('viewer');
  readonly roles: RoleName[] = ['viewer', 'editor', 'owner'];

  ngOnInit(): void {
    void this.store.load();
  }

  async grant(): Promise<void> {
    const user = this.grantUser().trim();
    if (!user) return;
    await this.store.grant(user, this.grantRole());
    if (!this.store.error()) this.grantUser.set('');
  }
}
