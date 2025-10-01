import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface CarSettings {
    mass: number;
    enginePower: number;
    dragCoeff: number;
    frontalArea: number;
    tireGrip: number;
    downforce: number;
    finalDrive: number;
    wheelbase: number; // meters
}

@Injectable({ providedIn: 'root' })
export class CarSettingsService {
    private settingsSource = new BehaviorSubject<CarSettings>({
        mass: 1000,
        enginePower: 100,
        dragCoeff: 0.3,
        frontalArea: 2.2,
        tireGrip: 0.8,
        downforce: 0,
        finalDrive: 3.5,
        wheelbase: 2.5 // meters
    });

    settings$ = this.settingsSource.asObservable();

    updateSettings(newSettings: Partial<CarSettings>) {
        console.log('Updating car settings inside Service:', newSettings);
        this.settingsSource.next({
            ...this.settingsSource.value,
            ...newSettings
        });
    }
}
