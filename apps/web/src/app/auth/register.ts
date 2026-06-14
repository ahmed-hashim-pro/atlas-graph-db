import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.html',
})
export class Register {
  private readonly api = inject(AtlasApi);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    if (this.password().length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    this.busy.set(true);
    try {
      await this.api.register(this.username(), this.password());
      await this.api.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(
        status === 409 ? 'That username is taken.' : 'Registration failed. Please try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
