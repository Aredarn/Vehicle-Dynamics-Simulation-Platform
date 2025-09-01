import { Component, NgModule } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CarSettingsComponent } from "../components/car-settings/car-settings.component";
import { ResultsPanelComponent } from '../components/results-panel/results-panel.component';
import { TrackViewComponent } from '../components/track-view/track-view.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CarSettingsComponent, ResultsPanelComponent, TrackViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'VDSP';
}
