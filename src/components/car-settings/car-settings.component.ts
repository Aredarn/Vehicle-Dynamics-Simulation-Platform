import { CommonModule, DecimalPipe } from '@angular/common';
import { Component, Input, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService, Drivetrain, Differential } from '../../services/car-settings.service';
import { calculatePerformance } from '../../utils/car-physics';

/** Numeric vehicle parameters, described once and rendered in a loop. */
type NumericSettingKey = Extract<
  keyof CarSettings,
  'mass' | 'enginePower' | 'dragCoeff' | 'frontalArea' | 'tireGrip' | 'downforce' | 'finalDrive'
  | 'wheelbase' | 'steeringLockDeg'
>;

interface SettingField {
  key: NumericSettingKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

@Component({
  selector: 'app-car-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, DecimalPipe],
  templateUrl: './car-settings.component.html',
  styleUrl: './car-settings.component.scss'
})
export class CarSettingsComponent implements OnDestroy {
  /** Drift mode fixes the drivetrain, so the pickers are shown but not editable. */
  @Input() locked = false;

  settings!: CarSettings;
  presets = this.settingsService.presets;
  performance = { acceleration: 0, topSpeed: 0 };

  readonly fields: SettingField[] = [
    { key: 'mass', label: 'Mass', unit: 'kg', min: 200, max: 2200, step: 1 },
    { key: 'enginePower', label: 'Engine power', unit: 'kW', min: 40, max: 800, step: 1 },
    { key: 'dragCoeff', label: 'Drag coefficient', unit: 'Cd', min: 0.1, max: 1, step: 0.01 },
    { key: 'frontalArea', label: 'Frontal area', unit: 'm²', min: 0.8, max: 3, step: 0.1 },
    { key: 'tireGrip', label: 'Tyre grip', unit: 'μ', min: 0.5, max: 2.5, step: 0.01 },
    { key: 'downforce', label: 'Downforce', unit: 'N', min: 0, max: 3000, step: 10 },
    { key: 'finalDrive', label: 'Final drive', unit: '', min: 2, max: 5, step: 0.01 },
    { key: 'wheelbase', label: 'Wheelbase', unit: 'm', min: 1.5, max: 3.5, step: 0.01 },
    { key: 'steeringLockDeg', label: 'Steering lock', unit: '°', min: 15, max: 70, step: 1 },
  ];

  readonly drivetrains: Array<{ value: Drivetrain; label: string; hint: string }> = [
    { value: 'fwd', label: 'FWD', hint: 'Front axle drives and steers, so power pushes the nose wide' },
    { value: 'rwd', label: 'RWD', hint: 'Rear axle drives; power rotates the car and can step the back out' },
    { value: 'awd', label: 'AWD', hint: 'Both axles share the load — most traction, least drama' },
  ];

  readonly differentials: Array<{ value: Differential; label: string; hint: string }> = [
    { value: 'open', label: 'Open', hint: 'Equal torque both sides, so the unloaded inside wheel spins first' },
    { value: 'lsd', label: 'LSD', hint: 'Ties the driven wheels together: more exit traction, more stability' },
  ];

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
