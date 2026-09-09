import { Component } from '@angular/core';
import { TrackViewComponent } from '../components/track-view/track-view.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [TrackViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'VDSP';
}
