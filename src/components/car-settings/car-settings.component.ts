import { DecimalPipe } from '@angular/common';
import { Component, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { calculatePerformance } from '../../utils/car-physics';

@Component({
  selector: 'app-car-settings',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './car-settings.component.html',
  styleUrl: './car-settings.component.scss'
})
export class CarSettingsComponent implements OnDestroy {
  settings!: CarSettings;
  presets = this.settingsService.presets;
  performance = { acceleration: 0, topSpeed: 0 };
  private settingsSub!: Subscription;

  constructor(private settingsService: CarSettingsService) {
    this.settings = { ...this.settingsService.getSettings() };
    this.settingsSub = this.settingsService.settings$.subscribe(settings => {
      this.settings = { ...settings };
      this.performance = calculatePerformance(settings);
    });
    this.performance = calculatePerformance(this.settings);
  }

  ngOnDestroy() {
    this.settingsSub?.unsubscribe();
  }

  onPresetChange(presetId: string) {
    this.settingsService.loadPreset(presetId);
  }

  updateSetting(key: keyof CarSettings, value: number | string) {
    this.settingsService.updateSettings({ [key]: value });
  }
}
