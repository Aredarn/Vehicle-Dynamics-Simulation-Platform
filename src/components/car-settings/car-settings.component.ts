import { Component } from '@angular/core';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-car-settings',
  standalone: true,
  imports: [ FormsModule],
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

}
