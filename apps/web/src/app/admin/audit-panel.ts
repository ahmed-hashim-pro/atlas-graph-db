import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuditStore } from './audit.store';

@Component({
  selector: 'app-audit-panel',
  imports: [FormsModule],
  templateUrl: './audit-panel.html',
  providers: [AuditStore],
})
export class AuditPanel implements OnInit {
  readonly store = inject(AuditStore);
  readonly limitInput = signal(this.store.limit());

  ngOnInit(): void {
    void this.store.load();
  }

  async refresh(): Promise<void> {
    await this.store.load(this.limitInput());
  }
}
