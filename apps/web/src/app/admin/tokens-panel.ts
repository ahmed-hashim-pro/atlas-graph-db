import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TokensStore } from './tokens.store';

@Component({
  selector: 'app-tokens-panel',
  imports: [FormsModule],
  templateUrl: './tokens-panel.html',
  providers: [TokensStore],
})
export class TokensPanel implements OnInit {
  readonly store = inject(TokensStore);
  readonly newName = signal('');

  ngOnInit(): void {
    void this.store.load();
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    await this.store.create(name);
    if (!this.store.error()) this.newName.set('');
  }
}
