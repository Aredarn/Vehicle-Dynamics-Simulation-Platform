import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { IconComponent } from '../components/icon/icon.component';
import { TrackViewComponent } from '../components/track-view/track-view.component';
import { ThemePreference, ThemeService } from '../services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, IconComponent, TrackViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'VDSP';

  readonly themeOptions: Array<{ value: ThemePreference; icon: string; label: string }> = [
    { value: 'light', icon: 'sun', label: 'Light' },
    { value: 'dark', icon: 'moon', label: 'Dark' },
    { value: 'system', icon: 'monitor', label: 'System' },
  ];

  constructor(private themeService: ThemeService) {}

  get themePreference(): ThemePreference {
    return this.themeService.preference;
  }

  setTheme(preference: ThemePreference) {
    this.themeService.setPreference(preference);
  }
}
