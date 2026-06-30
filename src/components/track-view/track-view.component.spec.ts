import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TrackViewComponent } from './track-view.component';

describe('TrackViewComponent', () => {
  let component: TrackViewComponent;
  let fixture: ComponentFixture<TrackViewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrackViewComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TrackViewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should create more realistic circuit-style presets with mixed corner types', () => {
    const monacoPreset = (component as any).createPresetTrack('monaco');

    expect(monacoPreset.length).toBeGreaterThan(8);
    expect(monacoPreset.filter((segment: any) => ['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(segment.type)).length).toBeGreaterThan(3);
    expect(monacoPreset.some((segment: any) => segment.type === 'curve120')).toBeTrue();
  });

  it('should treat 60° and 120° pieces as curved segments', () => {
    const start = {
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      heading: 0,
      length: 10
    };

    const curve60 = component['buildNextFrom'](start as any, { type: 'curve60', radius: 60, angle: 60 }, false);
    const curve120 = component['buildNextFrom'](start as any, { type: 'curve120', radius: 60, angle: 120 }, false);

    expect(curve60.type).toBe('curve60');
    expect(curve120.type).toBe('curve120');
    expect(component['computeEndOf'](curve60).heading).toBeCloseTo(Math.PI / 3);
    expect(component['computeEndOf'](curve120).heading).toBeCloseTo(2 * Math.PI / 3);
  });
});
