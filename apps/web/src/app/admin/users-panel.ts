import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UsersStore } from './users.store';

@Component({
  selector: 'app-users-panel',
  imports: [FormsModule],
  templateUrl: './users-panel.html',
  providers: [UsersStore],
})
export class UsersPanel implements OnInit {
  readonly store = inject(UsersStore);
  readonly newUsername = signal('');
  readonly newPassword = signal('');
  readonly newIsAdmin = signal(false);

  ngOnInit(): void {
    void this.store.load();
  }

  async create(): Promise<void> {
    const username = this.newUsername().trim();
    const password = this.newPassword();
    if (!username || password.length < 8) return;
    await this.store.create(username, password, this.newIsAdmin());
    if (!this.store.error()) {
      this.newUsername.set('');
      this.newPassword.set('');
      this.newIsAdmin.set(false);
    }
  }

  async resetPassword(username: string): Promise<void> {
    const password = window.prompt(`New password for "${username}" (min 8 characters):`);
    if (!password || password.length < 8) return;
    await this.store.resetPassword(username, password);
  }

  async remove(username: string): Promise<void> {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    await this.store.remove(username);
  }
}
