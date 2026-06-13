import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AtlasApi } from '../core/atlas-api';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
})
export class Login {
  private readonly api = inject(AtlasApi);
  private readonly router = inject(Router);

  readonly username = signal('');
  readonly password = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.login(this.username(), this.password());
      await this.router.navigateByUrl('/databases');
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(status === 401 ? 'Invalid username or password.' : 'Login failed. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
