import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { PickerStore } from './picker.store';

@Component({
  selector: 'app-picker',
  imports: [FormsModule, RouterLink],
  templateUrl: './picker.html',
})
export class Picker implements OnInit {
  readonly store = inject(PickerStore);
  private readonly router = inject(Router);
  readonly newName = signal('');
  readonly creating = signal(false);

  ngOnInit(): void {
    void this.store.load();
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    await this.store.create(name);
    this.creating.set(false);
    if (!this.store.error()) this.newName.set('');
  }

  async seed(name: string): Promise<void> {
    await this.store.seed(name);
  }

  open(name: string): void {
    void this.router.navigateByUrl(`/db/${name}`);
  }
}
