import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThemeService, type ThemeId } from '../core/theme.service';

@Component({
  selector: 'app-theme-switcher',
  imports: [FormsModule],
  templateUrl: './theme-switcher.html',
})
export class ThemeSwitcher {
  readonly theme = inject(ThemeService);

  change(id: string): void {
    this.theme.set(id as ThemeId);
  }
}
