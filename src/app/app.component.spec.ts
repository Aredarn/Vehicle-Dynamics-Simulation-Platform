import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it(`should have the 'VDSP' title`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.title).toEqual('VDSP');
  });

  it('renders the workspace and nothing else', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-shell > app-track-view')).toBeTruthy();
  });

  it('carries the product identity on the rail', () => {
    // The shell is a bezel now: identity moved inside the workspace onto the
    // rail, so the canvas can run edge to edge with no header above it.
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const mark = compiled.querySelector('.rail__mark');
    expect(mark?.textContent?.trim()).toBe('VD');
    expect(mark?.getAttribute('title')).toContain('VDSP');
  });
});
