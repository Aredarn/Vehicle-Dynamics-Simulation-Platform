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

