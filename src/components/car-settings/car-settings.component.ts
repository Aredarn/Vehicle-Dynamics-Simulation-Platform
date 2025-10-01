import { DecimalPipe } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CarSettingsService } from '../../services/car-settings.service';
import { Car } from '../../models/Car';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-car-settings',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  templateUrl: './car-settings.component.html',
  styleUrl: './car-settings.component.scss'
})

export class CarSettingsComponent  {

  // Car parameters with default values
  car!: Car;
  settingsSub!: Subscription;

  public performance: { acceleration: number; topSpeed: number } = { acceleration: 0, topSpeed: 0 };

  constructor(private settingsService: CarSettingsService) {
    this.settingsSub = this.settingsService.settings$.subscribe(settings => {
      if (!this.car) {
        this.car = new Car(settings);   // first time
      } else {
        this.car.updateSpecs(settings); // update live
      }
    });
    this.updatePerformance();
  }

  private updatePerformance(): void {
    this.performance = this.getPerformance();
  }


  // Use setters to update performance when a variable changes
  setCarMass(value: number) {
    this.updatePerformance();
    console.log('Car mass set to:', value);
    this.settingsService.updateSettings({ mass: value });
  }
  setEnginePower(value: number) {
    this.updatePerformance();
    console.log('Engine power set to:', value);
    this.settingsService.updateSettings({ enginePower: value });
  }
  setDragCoeff(value: number) {
    this.updatePerformance();
    console.log('Drag coefficient set to:', value);
    this.settingsService.updateSettings({ dragCoeff: value });
  }
  setFrontalArea(value: number) {
    this.updatePerformance();
    console.log('Frontal area set to:', value);
    this.settingsService.updateSettings({ frontalArea: value });
  }
  setTireGrip(value: number) {
    this.updatePerformance();
    console.log('Tire grip set to:', value);
    this.settingsService.updateSettings({ tireGrip: value });
  }
  setDownforce(value: number) {
    this.updatePerformance();
    console.log('Downforce set to:', value);
    this.settingsService.updateSettings({ downforce: value });
  }
  setFinalDrive(value: number) {
    this.updatePerformance();
    console.log('Final drive set to:', value);
    this.settingsService.updateSettings({ finalDrive: value });
  }
  setWheelbase(value: number) {
    this.updatePerformance();
    console.log('Wheelbase set to:', value);
    this.settingsService.updateSettings({ wheelbase: value });
  }
  setCarName(value: string) {
    // No need to update performance for name change
  }

  /**
   * Calculates acceleration (0-100 km/h) and top speed (km/h) based on car parameters.
   * Assumes air density ρ = 1.225 kg/m^3 and gravity g = 9.81 m/s^2.
   */
  getPerformance(): { acceleration: number; topSpeed: number } {
  const mass = this.car.mass;
  const powerW = this.car.enginePower * 1000; // kW → W
  const rho = 1.225; // air density
  const Cd = this.car.dragCoeff;
  const A = this.car.frontalArea;
  const mu = this.car.tireGrip;
  const downforce = this.car.downforce;
  const g = 9.81;

  const dragConst = 0.5 * rho * Cd * A;
  const rollingRes = 0.015 * mass * g;

  // --------- Top Speed ---------
  let vTop = 0;
  for (let v = 0; v < 200; v += 0.5) { // m/s, up to ~720 km/h
    const dragForce = dragConst * v * v;
    const resistForce = dragForce + rollingRes;
    const requiredPower = resistForce * v;
    if (requiredPower > powerW) break;
    vTop = v;
  }
  const topSpeed = vTop * 3.6; // m/s → km/h

  // --------- 0–100 km/h ---------
  const targetSpeed = 100 / 3.6; // m/s
  let v = 0;
  let t = 0;
  const dt = 0.05; // time step (s)

  while (v < targetSpeed) {
    // forces at current speed
    const dragForce = dragConst * v * v;
    const tractionLimit = mu * mass * g + downforce;
    const maxPowerForce = v > 1 ? powerW / v : powerW / 1;
    const driveForce = Math.min(tractionLimit, maxPowerForce);

    const netForce = driveForce - dragForce - rollingRes;
    const accel = netForce > 0 ? netForce / mass : 0;

    v += accel * dt;
    t += dt;

    if (t > 60) break; // failsafe (if car can’t reach 100)
  }

  return {
    acceleration: t,
    topSpeed: topSpeed
  };
}




  //LONGITUDINAL ACCELERATION// 
  //*************************/
  public F_engine(v: number): number {
    return this.car.enginePower / v
  }

  public F_drag(ρ: number, v: number): number {
    return 1 / 2 * ρ * this.car.dragCoeff * this.car.frontalArea * v ^ 2
  }

  public F_tire(g: number): number {
    return this.car.tireGrip * (this.car.mass * g + this.car.downforce)
  }

  //
  //alpha:
  public a(v: number, ρ: number): number {
    return (this.F_engine(v) - this.F_drag(ρ, v)) / this.car.mass
  }
  /*************************/

  //**LATERAL ACCELERATION**//
  //*************************/

  public a_lat_max(g: number): number {
    return this.car.tireGrip * (g + (this.car.downforce / this.car.mass))
  }

  public v_max(g: number, Radius: number): number {
    return Math.sqrt(this.a_lat_max(g) * Radius)
  }
}