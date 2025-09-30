import { Component } from '@angular/core';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { retry } from 'rxjs';

@Component({
  selector: 'app-car-settings',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './car-settings.component.html',
  styleUrl: './car-settings.component.scss'
})
export class CarSettingsComponent {
  public carName: string = '';
  public carMass: number = 1000;
  public enginePower: number = 100;
  public dragCoeff: number = 0.3;
  public frontalArea: number = 2.2;
  public tireGrip: number = 0.8;
  public downforce: number = 0;
  public finalDrive: number = 3.5;
  public wheelbase: number = 2.5; // meters
  
  
  /**
   * Calculates acceleration (0-100 km/h) and top speed (km/h) based on car parameters.
   * Assumes air density ρ = 1.225 kg/m^3 and gravity g = 9.81 m/s^2.
   */
  public getPerformance(): { acceleration: number; topSpeed: number } {
    const ρ = 1.225; // air density (kg/m^3)
    const g = 9.81; // gravity (m/s^2)

    // Top speed: where engine force equals drag force
    // F_engine(v) = F_drag(ρ, v)
    // enginePower (W) = F_drag * v => F_drag = enginePower / v
    // F_drag = 0.5 * ρ * dragCoeff * frontalArea * v^2
    // enginePower / v = 0.5 * ρ * dragCoeff * frontalArea * v^2
    // enginePower = 0.5 * ρ * dragCoeff * frontalArea * v^3
    // v^3 = enginePower / (0.5 * ρ * dragCoeff * frontalArea)
    // v = Math.cbrt(enginePower / (0.5 * ρ * dragCoeff * frontalArea))
    const topSpeed_mps = Math.cbrt(
      this.enginePower * 1000 / (0.5 * ρ * this.dragCoeff * this.frontalArea)
    );
    const topSpeed_kmh = topSpeed_mps * 3.6;

    // Acceleration: 0-100 km/h (27.78 m/s)
    // Use average acceleration over this range
    const v0 = 0;
    const v1 = 27.78; // 100 km/h in m/s
    // a = (F_engine(v) - F_drag(ρ, v)) / carMass
    // Integrate dt = dv / a(v) from v0 to v1
    let dt = 0;
    const steps = 100;
    for (let i = 0; i < steps; i++) {
      const v = v0 + (v1 - v0) * (i / steps);
      const F_engine = this.enginePower * 1000 / Math.max(v, 1); // avoid div by zero
      const F_drag = 0.5 * ρ * this.dragCoeff * this.frontalArea * v * v;
      const a = (F_engine - F_drag) / this.carMass;
      if (a > 0) {
        dt += (v1 - v0) / steps / a;
      } else {
        dt += 1; // fallback if negative acceleration
      }
    }

    return {
      acceleration: dt, // seconds (0-100 km/h)
      topSpeed: topSpeed_kmh // km/h
    };
  }


  //LONGITUDINAL ACCELERATION// 
  //*************************/
  public F_engine(v: number): number {
    return this.enginePower / v
  }

  public F_drag(ρ: number, v: number): number {
    return 1 / 2 * ρ * this.dragCoeff * this.frontalArea * v ^ 2
  }

  public F_tire(g: number): number {
    return this.tireGrip * (this.carMass * g + this.downforce)
  }

  //
  //alpha:
  public a(v: number, ρ: number): number {
    return (this.F_engine(v) - this.F_drag(ρ, v)) / this.carMass
  }
  /*************************/

  //**LATERAL ACCELERATION**//
  //*************************/

  public a_lat_max(g: number): number {
    return this.tireGrip * (g + (this.downforce / this.carMass))
  }

  public v_max(g: number, Radius: number): number {
    return Math.sqrt(this.a_lat_max(g) * Radius)
  }
}

interface CarState {
  segmentIndex: number;
  distanceAlongSegment: number; // in pixels
  speed: number;               // pixels per second
  heading: number;             // radians
  position: { x: number; y: number };
}

