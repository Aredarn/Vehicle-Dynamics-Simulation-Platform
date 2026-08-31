import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { CAR_PRESETS, getPresetById } from '../models/car-presets';

/** Which axle (or axles) the engine drives. */
export type Drivetrain = 'fwd' | 'rwd' | 'awd';

/**
 * How the driven axle shares torque between its two wheels. An open diff sends equal torque to
 * both, so the wheel with less grip sets the limit; a limited-slip diff ties them together.
 */
export type Differential = 'open' | 'lsd';

export interface CarSettings {
  name: string;
  presetId: string;
  mass: number;
  enginePower: number;
  dragCoeff: number;
  frontalArea: number;
  tireGrip: number;
  downforce: number;
  finalDrive: number;
  wheelbase: number;
  drivetrain: Drivetrain;
  differential: Differential;
}

export const DEFAULT_CAR_SETTINGS: CarSettings = {
  name: 'Sport Sedan',
  presetId: 'sport',
  mass: 1450,
  enginePower: 280,
  dragCoeff: 0.28,
  frontalArea: 2.0,
  tireGrip: 0.95,
  downforce: 150,
  finalDrive: 3.6,
  wheelbase: 2.7,
  drivetrain: 'rwd',
  differential: 'lsd',
};

@Injectable({ providedIn: 'root' })
export class CarSettingsService {
  private settingsSource = new BehaviorSubject<CarSettings>({ ...DEFAULT_CAR_SETTINGS });
  settings$ = this.settingsSource.asObservable();

  getSettings(): CarSettings {
    return this.settingsSource.value;
  }

  updateSettings(newSettings: Partial<CarSettings>) {
    const current = this.settingsSource.value;
    const normalizedSettings: Partial<CarSettings> = {};

    for (const [key, value] of Object.entries(newSettings) as Array<[keyof CarSettings, CarSettings[keyof CarSettings] | string | undefined]>) {
      if (key === 'presetId' || key === 'name' || key === 'drivetrain' || key === 'differential') {
        (normalizedSettings as Record<string, unknown>)[key] = value;
        continue;
      }

      if (typeof value === 'string' && value.trim() !== '') {
        const numericValue = Number(value);
        if (Number.isFinite(numericValue)) {
          (normalizedSettings as Record<string, unknown>)[key] = numericValue;
        }
        continue;
      }

      if (typeof value === 'number' && Number.isFinite(value)) {
        (normalizedSettings as Record<string, unknown>)[key] = value;
      }
    }

    this.settingsSource.next({
      ...current,
      ...normalizedSettings,
      presetId: newSettings.presetId ?? (this.isCustomChange(newSettings) ? 'custom' : current.presetId),
    });
  }

  loadPreset(presetId: string) {
    const preset = getPresetById(presetId);
    if (!preset) return;
    this.settingsSource.next({
      name: preset.name,
      presetId: preset.id,
      ...preset.settings,
    });
  } 

  get presets() {
    return CAR_PRESETS;
  }

  getActivePresetColor(): [string, string] {
    const preset = getPresetById(this.settingsSource.value.presetId);
    return preset?.color ?? ['#3b82f6', '#60a5fa'];
  }

  private isCustomChange(partial: Partial<CarSettings>): boolean {
    const keys = Object.keys(partial).filter(k => k !== 'presetId' && k !== 'name');
    return keys.length > 0 && partial.presetId === undefined;
  }
}
