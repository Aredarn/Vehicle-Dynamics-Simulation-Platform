import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { RacingLineOptimizerService } from '../../services/racing-line-optimizer.service';
import { AIDrivingService, AIGenerationStats } from '../../services/ai-driving.service';
import { ThemeService } from '../../services/theme.service';
import { Car } from '../../models/Car';
import { CarAgent } from '../../models/CarAgent';
import { PieceType, Segment } from '../../models/Track';
import { CarState, RacingLinePoint } from '../../interfaces/car-state';
import { IconComponent } from '../icon/icon.component';
import { CarSettingsComponent } from '../car-settings/car-settings.component';
import { ResultsPanelComponent } from '../results-panel/results-panel.component';

const roadWidth = 30;
const PX_PER_M = 3;

interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

type SidebarTab = 'car' | 'track' | 'training';

/** Canvas colours resolved from CSS custom properties so the track follows the theme. */
interface CanvasTheme {
  grid: string;
  gridMajor: string;
  road: string;
  roadEdge: string;
  centerline: string;
  kerbA: string;
  kerbB: string;
  line: string;
  lineAlt: string;
  agent: string;
  agentDead: string;
  text: string;
}

@Component({
  selector: 'app-track-view',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CarSettingsComponent, ResultsPanelComponent],
  templateUrl: './track-view.component.html',
  styleUrls: ['./track-view.component.scss']
})
export class TrackViewComponent implements AfterViewInit, OnDestroy {
  private settingsSub!: Subscription;
  private aiStatsSub!: Subscription;
  private aiAgentsSub!: Subscription;
  private historyEntrySub!: Subscription;
  private car!: Car;
  private carColor: [string, string] = ['#3b82f6', '#60a5fa'];
  private trainingAgents: CarAgent[] = [];
  aiStats: AIGenerationStats = {
    generation: 0,
    bestFitness: 0,
    bestLapTime: 0,
    bestProgress: 0,
    aliveCount: 0,
    averageFitness: 0,
    active: false,
    carModel: '',
  };
  aiConfig = {
    populationSize: 25,
    generations: 20,
    mutationRate: 0.2,
  };

  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  constructor(
    private settingsService: CarSettingsService,
    private lineOptimizer: RacingLineOptimizerService,
    private aiDrivingService: AIDrivingService,
    private themeService: ThemeService,
  ) {}

  activeTab: SidebarTab = 'track';
  telemetryOpen = true;

  readonly tabs: Array<{ id: SidebarTab; label: string; icon: string }> = [
    { id: 'car', label: 'Car', icon: 'car' },
    { id: 'track', label: 'Track', icon: 'track' },
    { id: 'training', label: 'Training', icon: 'cpu' },
  ];

  palette = [
    { label: 'Start', type: 'start' as PieceType, length: 50, icon: 'pieceStart', meta: 'Launch zone' },
    { label: 'Short Straight', type: 'straight' as PieceType, length: 20, icon: 'pieceStraight', meta: '20 m' },
    { label: 'Medium Straight', type: 'straight' as PieceType, length: 50, icon: 'pieceStraight', meta: '50 m' },
    { label: 'Long Straight', type: 'straight' as PieceType, length: 100, icon: 'pieceStraight', meta: '100 m' },
    { label: 'Fast Sweep', type: 'curve30' as PieceType, radius: 80, angle: 30, icon: 'pieceCurveL', meta: '30°' },
    { label: 'Medium Corner', type: 'curve45' as PieceType, radius: 70, angle: 45, icon: 'pieceCurveL', meta: '45°' },
    { label: 'Technical Corner', type: 'curve60' as PieceType, radius: 65, angle: 60, icon: 'pieceCurveR', meta: '60°' },
    { label: 'Hairpin', type: 'curve90' as PieceType, radius: 55, angle: 90, icon: 'pieceCurveR', meta: '90°' },
    { label: 'Chicane', type: 'curve120' as PieceType, radius: 60, angle: 120, icon: 'pieceChicane', meta: '120°' },
  ];

  trackPresets = [
    { key: 'monaco', label: 'Monaco GP', description: 'Street circuit with tight braking zones and slow corners' },
    { key: 'silverstone', label: 'Silverstone GP', description: 'High-speed mix of straights and fast flowing corners' },
    { key: 'monza', label: 'Monza GP', description: 'Long straights and heavy braking for a classic F1 layout' },
  ];

  private lastTime = 0;
  private needsRedraw = true;
  private animationFrameId: number | null = null;

  segments: Segment[] = [];
  private dragPreview: any = null;
  previewTurnRight = false;
  private ctx!: CanvasRenderingContext2D;
  private racingLine: RacingLinePoint[] = [];
  showRacingLine = true;
  useOptimizedLine = true;
  estimatedLapTime = 0;

  camera: Camera = { scale: 1, offsetX: 0, offsetY: 0 };
  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private cameraStart = { offsetX: 0, offsetY: 0 };
  zoomLevel = 100;

  private themeSub!: Subscription;
  private colors!: CanvasTheme;
  private resizeObserver?: ResizeObserver;
  private dpr = 1;
  /** Canvas size in CSS pixels — the space camera and pointer coordinates live in. */
  private viewWidth = 0;
  private viewHeight = 0;
  private dprQueryCleanup?: () => void;

  ngAfterViewInit(): void {
    const ctx = this.canvasRef.nativeElement.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.readCanvasTheme();
    this.themeSub = this.themeService.resolved$.subscribe(() => {
      // Custom properties have already been swapped on <html> by the service;
      // re-read them so the next paint uses the new palette.
      this.readCanvasTheme();
      this.requestRedraw();
    });

    this.car = new Car(this.settingsService.getSettings());
    this.carColor = this.settingsService.getActivePresetColor();

    // The element has no layout yet during ngAfterViewInit, so observe it instead of
    // measuring once — this also covers the sidebar and telemetry drawer resizing it.
    let sized = false;
    this.resizeObserver = new ResizeObserver(() => {
      const changed = this.resizeCanvasToContainer();
      if (!changed) return;
      if (!sized) {
        sized = true;
        this.fitTrackToView();
      }
      this.requestRedraw();
    });
    this.resizeObserver.observe(this.canvasRef.nativeElement);
    this.watchDevicePixelRatio();

    this.resizeCanvasToContainer();
    this.fitTrackToView();
    this.requestRedraw();

    this.settingsSub = this.settingsService.settings$.subscribe(settings => {
      this.car.updateSpecs(settings);
      this.carColor = this.settingsService.getActivePresetColor();
      this.updateRacingLine();
      this.requestRedraw();
    });

    this.aiStatsSub = this.aiDrivingService.stats$.subscribe(stats => {
      this.aiStats = stats;
      this.requestRedraw();
    });

    this.aiAgentsSub = this.aiDrivingService.agents$.subscribe(agents => {
      this.trainingAgents = agents;
      this.requestRedraw();
    });

    this.historyEntrySub = this.aiDrivingService.selectedHistoryEntry$.subscribe(entry => {
      if (!entry) return;
      this.racingLine = entry.trajectory;
      this.estimatedLapTime = entry.bestLapTime;
      this.useOptimizedLine = false;
      this.requestRedraw();
    });

    this.lastTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  ngOnDestroy() {
    this.settingsSub?.unsubscribe();
    this.aiStatsSub?.unsubscribe();
    this.aiAgentsSub?.unsubscribe();
    this.historyEntrySub?.unsubscribe();
    this.themeSub?.unsubscribe();
    this.resizeObserver?.disconnect();
    this.dprQueryCleanup?.();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
  }

  // ---------- Layout ----------
  selectTab(tab: SidebarTab) {
    this.activeTab = tab;
  }

  toggleTelemetry() {
    this.telemetryOpen = !this.telemetryOpen;
    // The canvas box changes size, so re-fit the camera on the next frame.
    requestAnimationFrame(() => {
      this.resizeCanvasToContainer();
      this.requestRedraw();
    });
  }

  // ---------- Theme ----------
  private readCanvasTheme() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;

    this.colors = {
      grid: read('--canvas-grid', '#151b24'),
      gridMajor: read('--canvas-grid-major', '#1d2530'),
      road: read('--canvas-road', '#232c38'),
      roadEdge: read('--canvas-road-edge', '#46536a'),
      centerline: read('--canvas-centerline', 'rgba(226,232,240,0.28)'),
      kerbA: read('--canvas-kerb-a', '#cbd5e1'),
      kerbB: read('--canvas-kerb-b', '#64748b'),
      line: read('--canvas-line', '#22c55e'),
      lineAlt: read('--canvas-line-alt', '#38bdf8'),
      agent: read('--canvas-agent', '#f4c14e'),
      agentDead: read('--canvas-agent-dead', '#7f3f45'),
      text: read('--canvas-text', '#e2e8f0'),
    };
  }

  /**
   * Browser zoom and moving between displays change devicePixelRatio without changing the
   * element's CSS box, so the ResizeObserver never fires and the canvas would keep rendering at
   * the old density. A resolution media query is the only way to be notified; it has to be
   * re-registered each time because the query itself is pinned to a specific ratio.
   */
  private watchDevicePixelRatio() {
    if (!window.matchMedia) return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      this.forceCanvasResize();
      this.watchDevicePixelRatio();
    };
    query.addEventListener('change', onChange, { once: true });
    this.dprQueryCleanup = () => query.removeEventListener('change', onChange);
  }

  private forceCanvasResize() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    // Zero it so resizeCanvasToContainer's "unchanged" check can't short-circuit.
    canvas.width = 0;
    this.resizeCanvasToContainer();
    this.requestRedraw();
  }

  /**
   * Keeps the backing store matched to the element's CSS box (times DPR) so the track is drawn
   * at native resolution instead of being stretched from the 300x150 canvas default.
   * All camera and pointer maths stay in CSS pixels — drawAll applies the DPR scale itself.
   */
  private resizeCanvasToContainer(): boolean {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewWidth = rect.width;
    this.viewHeight = rect.height;

    const width = Math.round(rect.width * this.dpr);
    const height = Math.round(rect.height * this.dpr);
    if (canvas.width === width && canvas.height === height) return false;

    canvas.width = width;
    canvas.height = height;
    return true;
  }

  // ---------- Camera ----------
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.camera.offsetX) / this.camera.scale / PX_PER_M,
      y: (screenY - this.camera.offsetY) / this.camera.scale / PX_PER_M,
    };
  }

  onWheel(event: WheelEvent) {
    event.preventDefault();
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    this.zoomAt(mx, my, factor);
  }

  zoomAt(screenX: number, screenY: number, factor: number) {
    const wx = (screenX - this.camera.offsetX) / this.camera.scale;
    const wy = (screenY - this.camera.offsetY) / this.camera.scale;
    this.camera.scale = Math.max(0.05, Math.min(8, this.camera.scale * factor));
    this.camera.offsetX = screenX - wx * this.camera.scale;
    this.camera.offsetY = screenY - wy * this.camera.scale;
    this.zoomLevel = Math.round(this.camera.scale * 100);
    this.requestRedraw();
  }

  zoomIn() {
    this.zoomAt(this.viewWidth / 2, this.viewHeight / 2, 1.25);
  }

  zoomOut() {
    this.zoomAt(this.viewWidth / 2, this.viewHeight / 2, 0.8);
  }

  resetZoom() {
    this.camera = { scale: 1, offsetX: 0, offsetY: 0 };
    this.zoomLevel = 100;
    this.requestRedraw();
  }

  fitTrackToView() {
    const bbox = this.getTrackBoundingBox();

    if (!bbox) {
      this.camera = { scale: 1, offsetX: 40, offsetY: 40 };
      this.zoomLevel = 100;
      return;
    }

    const padding = 60;
    const bboxWidthPx = (bbox.maxX - bbox.minX) * PX_PER_M;
    const bboxHeightPx = (bbox.maxY - bbox.minY) * PX_PER_M;

    if (bboxWidthPx < 1 && bboxHeightPx < 1) return;

    const scaleX = (this.viewWidth - padding * 2) / Math.max(bboxWidthPx, 100);
    const scaleY = (this.viewHeight - padding * 2) / Math.max(bboxHeightPx, 100);
    const scale = Math.min(scaleX, scaleY, 2);

    const centerX = (bbox.minX + bbox.maxX) / 2 * PX_PER_M;
    const centerY = (bbox.minY + bbox.maxY) / 2 * PX_PER_M;

    this.camera.scale = scale;
    this.camera.offsetX = this.viewWidth / 2 - centerX * scale;
    this.camera.offsetY = this.viewHeight / 2 - centerY * scale;
    this.zoomLevel = Math.round(scale * 100);
  }

  private getTrackBoundingBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.segments.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const seg of this.segments) {
      const end = this.computeEndOf(seg);
      minX = Math.min(minX, seg.position.x, end.x);
      minY = Math.min(minY, seg.position.y, end.y);
      maxX = Math.max(maxX, seg.position.x, end.x);
      maxY = Math.max(maxY, seg.position.y, end.y);
    }

    return { minX, minY, maxX, maxY };
  }

  onCanvasMouseDown(event: MouseEvent) {
    if (event.button === 1 || event.button === 2 || event.altKey) {
      event.preventDefault();
      this.isPanning = true;
      this.panStart = { x: event.clientX, y: event.clientY };
      this.cameraStart = { offsetX: this.camera.offsetX, offsetY: this.camera.offsetY };
    }
  }

  onCanvasMouseMove(event: MouseEvent) {
    if (!this.isPanning) return;
    const dx = event.clientX - this.panStart.x;
    const dy = event.clientY - this.panStart.y;
    this.camera.offsetX = this.cameraStart.offsetX + dx;
    this.camera.offsetY = this.cameraStart.offsetY + dy;
    this.requestRedraw();
  }

  onCanvasMouseUp() {
    this.isPanning = false;
  }

  @HostListener('window:mouseup')
  onWindowMouseUp() {
    this.isPanning = false;
  }

  // ---------- Presets ----------
  loadTrackPreset(presetKey: string) {
    const segments = this.createPresetTrack(presetKey);
    if (!segments.length) return;

    this.segments = segments;
    this.previewTurnRight = false;
    this.car.resetCar();
    this.onTrackChanged();
    this.fitTrackToView();
  }

  private createPresetTrack(presetKey: string): Segment[] {
    const definitions: Array<{ type: PieceType; length?: number; radius?: number; angle?: number; turnRight?: boolean }> = [];

    switch (presetKey) {
      case 'monaco':
        definitions.push(
          { type: 'straight', length: 35 },
          { type: 'curve45', angle: 45, turnRight: true },
          { type: 'straight', length: 18 },
          { type: 'curve90', angle: 90, turnRight: false },
          { type: 'straight', length: 12 },
          { type: 'curve60', angle: 60, turnRight: true },
          { type: 'straight', length: 14 },
          { type: 'curve120', angle: 120, turnRight: false },
          { type: 'straight', length: 20 },
          { type: 'curve60', angle: 60, turnRight: true },
          { type: 'straight', length: 16 },
          { type: 'curve90', angle: 90, turnRight: false },
          { type: 'straight', length: 15 },
          { type: 'curve45', angle: 45, turnRight: true },
          { type: 'straight', length: 22 },
        );
        break;
      case 'silverstone':
        definitions.push(
          { type: 'straight', length: 70 },
          { type: 'curve60', angle: 60, turnRight: false },
          { type: 'straight', length: 52 },
          { type: 'curve90', angle: 90, turnRight: true },
          { type: 'straight', length: 60 },
          { type: 'curve45', angle: 45, turnRight: false },
          { type: 'straight', length: 40 },
          { type: 'curve60', angle: 60, turnRight: true },
          { type: 'straight', length: 58 },
          { type: 'curve90', angle: 90, turnRight: false },
          { type: 'straight', length: 50 },
          { type: 'curve30', angle: 30, turnRight: true },
          { type: 'straight', length: 28 },
          { type: 'curve120', angle: 120, turnRight: false },
          { type: 'straight', length: 38 },
          { type: 'curve60', angle: 60, turnRight: true },
          { type: 'straight', length: 34 },
        );
        break;
      case 'monza':
        definitions.push(
          { type: 'straight', length: 95 },
          { type: 'curve45', angle: 45, turnRight: true },
          { type: 'straight', length: 70 },
          { type: 'curve90', angle: 90, turnRight: false },
          { type: 'straight', length: 82 },
          { type: 'curve60', angle: 60, turnRight: true },
          { type: 'straight', length: 54 },
          { type: 'curve45', angle: 45, turnRight: false },
          { type: 'straight', length: 44 },
          { type: 'curve120', angle: 120, turnRight: true },
          { type: 'straight', length: 78 },
          { type: 'curve90', angle: 90, turnRight: false },
          { type: 'straight', length: 62 },
          { type: 'curve30', angle: 30, turnRight: true },
          { type: 'straight', length: 58 },
        );
        break;
      default:
        return [];
    }

    const segments: Segment[] = [{
      id: crypto.randomUUID(),
      type: 'start',
      position: { x: 0, y: 0 },
      heading: 0,
      length: 50 / PX_PER_M,
    }];

    let last = segments[0];
    for (const definition of definitions) {
      const next = this.buildPresetSegment(last, definition);
      segments.push(next);
      last = next;
    }

    return segments;
  }

  private buildPresetSegment(last: Segment, piece: { type: PieceType; length?: number; radius?: number; angle?: number; turnRight?: boolean }): Segment {
    const lastEnd = this.computeEndOf(last);
    const baseHeading = lastEnd.heading;

    if (piece.type === 'straight') {
      return {
        id: crypto.randomUUID(),
        type: 'straight',
        length: (piece.length ?? 40) / PX_PER_M,
        position: { x: lastEnd.x, y: lastEnd.y },
        heading: baseHeading,
      };
    }

    if (['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(piece.type)) {
      const angleDeg = piece.angle ?? 45;
      const signedDeg = piece.turnRight ? -Math.abs(angleDeg) : Math.abs(angleDeg);
      return {
        id: crypto.randomUUID(),
        type: piece.type,
        radius: (piece.radius ?? 60) / PX_PER_M,
        angle: signedDeg,
        position: { x: lastEnd.x, y: lastEnd.y },
        heading: baseHeading,
      };
    }

    return {
      id: crypto.randomUUID(),
      type: 'straight',
      length: 40 / PX_PER_M,
      position: { x: lastEnd.x, y: lastEnd.y },
      heading: baseHeading,
    };
  }

  onDragStart(event: DragEvent, piece: any) {
    this.dragPreview = { ...piece };
    event.dataTransfer?.setData('text/plain', piece.type);
  }

  onDragOver(ev: DragEvent) { ev.preventDefault(); }
  onDragEnter(ev: DragEvent) { ev.preventDefault(); }

  onDrop(ev: DragEvent) {
    ev.preventDefault();
    if (!this.dragPreview) return;

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const screenX = ev.clientX - rect.left;
    const screenY = ev.clientY - rect.top;
    const world = this.screenToWorld(screenX, screenY);

    if (this.dragPreview.type === 'start') {
      this.segments = [{
        id: crypto.randomUUID(),
        type: 'start',
        position: { x: world.x, y: world.y },
        heading: 0,
        length: (this.dragPreview.length ?? 40) / PX_PER_M
      }];
    } else {
      if (this.segments.length === 0 || this.segments[0].type !== 'start') {
        alert('Place a Start piece first.');
        this.dragPreview = null;
        return;
      }
      const last = this.segments[this.segments.length - 1];
      this.segments.push(this.buildNextFrom(last, this.dragPreview, this.previewTurnRight));
    }

    this.dragPreview = null;
    this.onTrackChanged();
  }

  onDragEnd() { this.dragPreview = null; }

  undoLastPiece() {
    if (this.segments.length <= 1) return;
    this.segments.pop();
    this.onTrackChanged();
  }

  private onTrackChanged() {
    this.updateRacingLine();
    this.requestRedraw();
  }

  // ---------- Builders & Geometry ----------
  private buildNextFrom(last: Segment, piece: any, turnRight: boolean): Segment {
    const lastEnd = this.computeEndOf(last);
    const baseHeading = lastEnd.heading;

    if (piece.type === 'straight') {
      return {
        id: crypto.randomUUID(),
        type: 'straight',
        length: (piece.length ?? 100) / PX_PER_M,
        position: { x: lastEnd.x, y: lastEnd.y },
        heading: baseHeading
      };
    }

    if (['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(piece.type)) {
      const angleDeg = piece.angle ?? Number(piece.type.replace('curve', '')) ?? 90;
      const signedDeg = turnRight ? -Math.abs(angleDeg) : Math.abs(angleDeg);
      return {
        id: crypto.randomUUID(),
        type: piece.type as PieceType,
        radius: (piece.radius ?? 60) / PX_PER_M,
        angle: signedDeg,
        position: { x: lastEnd.x, y: lastEnd.y },
        heading: baseHeading
      };
    }

    return {
      id: crypto.randomUUID(),
      type: 'straight',
      length: 50 / PX_PER_M,
      position: { x: lastEnd.x, y: lastEnd.y },
      heading: baseHeading
    };
  }

  private computeEndOf(seg: Segment): { x: number; y: number; heading: number } {
    const x0 = seg.position.x;
    const y0 = seg.position.y;
    const θ = seg.heading;

    if (seg.type === 'start' || seg.type === 'straight') {
      const L = seg.length ?? 0;
      return { x: x0 + L * Math.cos(θ), y: y0 + L * Math.sin(θ), heading: θ };
    }

    if (['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(seg.type)) {
      const R = seg.radius ?? 6;
      const angleRad = (seg.angle ?? 90) * Math.PI / 180;
      const turnDirection = Math.sign(seg.angle ?? 90);
      const cx = x0 - turnDirection * R * Math.sin(θ);
      const cy = y0 + turnDirection * R * Math.cos(θ);
      const startAngle = Math.atan2(y0 - cy, x0 - cx);
      const endAngle = startAngle + angleRad;
      return {
        x: cx + R * Math.cos(endAngle),
        y: cy + R * Math.sin(endAngle),
        heading: θ + angleRad
      };
    }

    return { x: x0, y: y0, heading: θ };
  }

  // ---------- Racing Line ----------
  private updateRacingLine() {
    if (!this.car || this.segments.length === 0) {
      this.racingLine = [];
      this.estimatedLapTime = 0;
      return;
    }

    try {
      const centerline = this.car.computeRacingLine(this.segments);

      if (this.useOptimizedLine && centerline.length >= 2) {
        const optimized = this.lineOptimizer.optimize(centerline, this.settingsService.getSettings());
        this.racingLine = optimized.points;
        this.estimatedLapTime = optimized.estimatedLapTime;
      } else {
        this.racingLine = centerline;
        this.estimatedLapTime = 0;
      }
    } catch {
      this.racingLine = [];
      this.estimatedLapTime = 0;
    }
  }

  toggleRacingLine() {
    this.showRacingLine = !this.showRacingLine;
    this.requestRedraw();
  }

  toggleOptimizedLine() {
    this.useOptimizedLine = !this.useOptimizedLine;
    this.updateRacingLine();
    this.requestRedraw();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
    this.requestRedraw();
  }

  // ---------- Drawing ----------
  private drawAll() {
    const ctx = this.ctx;
    const canvas = this.canvasRef.nativeElement;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Work in CSS pixels from here on; the DPR scale is applied once.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    ctx.save();
    ctx.translate(this.camera.offsetX, this.camera.offsetY);
    ctx.scale(this.camera.scale, this.camera.scale);

    this.drawGrid(40);

    for (const s of this.segments) this.drawSegment(s);
    this.drawRacingLine();
    this.drawTrainingAgents();

    if (this.dragPreview && this.segments.length) {
      const last = this.segments[this.segments.length - 1];
      this.drawSegment(this.buildNextFrom(last, this.dragPreview, this.previewTurnRight), true);
    }

    ctx.restore();
  }

  private drawRacingLine() {
    if (this.racingLine.length < 2 || !this.showRacingLine) return;

    const ctx = this.ctx;
    const lineColor = this.useOptimizedLine ? this.colors.line : this.colors.lineAlt;

    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 3 / this.camera.scale;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(this.racingLine[0].x * PX_PER_M, this.racingLine[0].y * PX_PER_M);
    for (let i = 1; i < this.racingLine.length; i++) {
      ctx.lineTo(this.racingLine[i].x * PX_PER_M, this.racingLine[i].y * PX_PER_M);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawTrainingAgents() {
    if (!this.trainingAgents.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.8;

    for (const agent of this.trainingAgents) {
      const { x, y, heading, alive } = agent.state;
      const size = 8 / this.camera.scale;
      ctx.save();
      ctx.translate(x * PX_PER_M, y * PX_PER_M);
      ctx.rotate(heading);
      ctx.fillStyle = alive ? this.colors.agent : this.colors.agentDead;
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.6, -size * 0.7);
      ctx.lineTo(-size * 0.6, size * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  private drawGrid(step: number) {
    const ctx = this.ctx;
    const w = this.viewWidth / this.camera.scale;
    const h = this.viewHeight / this.camera.scale;
    const ox = -this.camera.offsetX / this.camera.scale;
    const oy = -this.camera.offsetY / this.camera.scale;

    ctx.save();
    ctx.lineWidth = 1 / this.camera.scale;

    const startX = Math.floor(ox / step) * step;
    const startY = Math.floor(oy / step) * step;

    // Every 5th line is emphasised so the grid reads as a measurable scale.
    for (let x = startX; x < ox + w; x += step) {
      ctx.strokeStyle = Math.round(x / step) % 5 === 0 ? this.colors.gridMajor : this.colors.grid;
      ctx.beginPath();
      ctx.moveTo(x, oy);
      ctx.lineTo(x, oy + h);
      ctx.stroke();
    }
    for (let y = startY; y < oy + h; y += step) {
      ctx.strokeStyle = Math.round(y / step) % 5 === 0 ? this.colors.gridMajor : this.colors.grid;
      ctx.beginPath();
      ctx.moveTo(ox, y);
      ctx.lineTo(ox + w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSegment(seg: Segment, ghost = false) {
    if (seg.type === 'start') return this.drawStart(seg, ghost);
    if (seg.type === 'straight') return this.drawStraight(seg, ghost);
    if (['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(seg.type)) return this.drawCurve(seg, ghost);
  }

  private drawStart(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const startLength = (seg.length ?? 40) * PX_PER_M;

    ctx.save();
    ctx.translate(seg.position.x * PX_PER_M, seg.position.y * PX_PER_M);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    ctx.fillStyle = this.colors.road;
    ctx.fillRect(0, -roadWidth / 2, startLength, roadWidth);
    ctx.fillStyle = this.colors.roadEdge;
    ctx.fillRect(0, -roadWidth / 2, startLength, 1.5);
    ctx.fillRect(0, roadWidth / 2 - 1.5, startLength, 1.5);

    const checkSize = 6;
    for (let i = 0; i < Math.ceil(roadWidth / checkSize); i++) {
      for (let j = 0; j < Math.ceil(startLength / checkSize); j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? this.colors.kerbA : this.colors.kerbB;
        ctx.fillRect(j * checkSize, -roadWidth / 2 + i * checkSize, checkSize, checkSize);
      }
    }

    ctx.restore();
  }

  private drawStraight(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const L = (seg.length ?? 0) * PX_PER_M;

    ctx.save();
    ctx.translate(seg.position.x * PX_PER_M, seg.position.y * PX_PER_M);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    ctx.fillStyle = this.colors.road;
    ctx.fillRect(0, -roadWidth / 2, L, roadWidth);

    ctx.strokeStyle = this.colors.roadEdge;
    ctx.lineWidth = 1.5 / this.camera.scale;
    ctx.beginPath();
    ctx.moveTo(0, -roadWidth / 2);
    ctx.lineTo(L, -roadWidth / 2);
    ctx.moveTo(0, roadWidth / 2);
    ctx.lineTo(L, roadWidth / 2);
    ctx.stroke();

    ctx.strokeStyle = this.colors.centerline;
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawCurve(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const R = (seg.radius ?? 6) * PX_PER_M;
    const angleRad = (seg.angle ?? 90) * Math.PI / 180;
    const turnDirection = Math.sign(seg.angle ?? 90);
    const x0 = seg.position.x * PX_PER_M;
    const y0 = seg.position.y * PX_PER_M;
    const cx = x0 - turnDirection * R * Math.sin(seg.heading);
    const cy = y0 + turnDirection * R * Math.cos(seg.heading);
    const startAngle = Math.atan2(y0 - cy, x0 - cx);
    const endAngle = startAngle + angleRad;

    ctx.save();
    ctx.globalAlpha = ghost ? 0.4 : 1;

    ctx.fillStyle = this.colors.road;
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.arc(cx, cy, R - roadWidth / 2, endAngle, startAngle, angleRad >= 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.colors.roadEdge;
    ctx.lineWidth = 1.5 / this.camera.scale;
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R - roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.stroke();

    ctx.strokeStyle = this.colors.centerline;
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.setLineDash([10, 9]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, startAngle, endAngle, angleRad < 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------- Simulation Control ----------
  async startAITraining() {
    if (this.segments.length < 2 || this.segments[0].type !== 'start') {
      alert('You need a Start piece and at least one track segment.');
      return;
    }

    this.trainingAgents = [];
    this.aiStats = { ...this.aiStats, active: true };
    this.aiDrivingService.clearHistory();

    const result = await this.aiDrivingService.train(
      this.settingsService.getSettings(),
      this.segments,
      this.aiConfig
    );
    if (result.bestAgents.length) {
      const best = result.bestAgents[0];
      this.racingLine = best.trajectory;
      this.estimatedLapTime = best.state.lapTime;
      this.useOptimizedLine = false;
    }
    this.requestRedraw();
  }

  stopAITraining() {
    this.aiDrivingService.stopTraining();
  }

  clearTrack() {
    this.segments = [];
    this.racingLine = [];
    this.estimatedLapTime = 0;
    this.car.resetCar();
    this.requestRedraw();
  }

  setTurnDirection(turnRight: boolean) {
    this.previewTurnRight = turnRight;
    this.requestRedraw();
  }

  toggleTurnDirection() {
    this.setTurnDirection(!this.previewTurnRight);
  }

  exportTrack() {
    if (this.segments.length <= 1) {
      alert('Build a track first so it can be exported.');
      return;
    }

    const presetDefinition = this.buildExportDefinition();
    const exportText = JSON.stringify(presetDefinition, null, 2);

    try {
      const textarea = document.createElement('textarea');
      textarea.value = exportText;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('Track preset copied to clipboard. Paste it into a preset definition.');
    } catch {
      alert(exportText);
    }
  }

  private buildExportDefinition(): Array<{ type: PieceType; length?: number; radius?: number; angle?: number; turnRight?: boolean }> {
    return this.segments
      .slice(1)
      .map(seg => {
        if (seg.type === 'straight') {
          return { type: 'straight', length: Math.round((seg.length ?? 0) * PX_PER_M) };
        }

        if (['curve30', 'curve45', 'curve60', 'curve90', 'curve120', 'curve180'].includes(seg.type)) {
          return {
            type: seg.type as PieceType,
            angle: Math.abs(seg.angle ?? 0),
            turnRight: (seg.angle ?? 0) < 0,
            radius: Math.round((seg.radius ?? 0) * PX_PER_M),
          };
        }

        return { type: 'straight', length: 20 };
      });
  }

  /** Marks the canvas dirty; the next animation frame paints it at most once. */
  private requestRedraw() {
    this.needsRedraw = true;
  }

  private animate(timestamp: number) {
    this.lastTime = timestamp;
    // Only paint when something actually changed. This previously redrew every frame regardless,
    // so an idle canvas repainted 60x a second, and during training those repaints competed with
    // the simulation for the main thread. Coalescing also collapses the several redraw requests
    // a single generation tick fires into one paint.
    if (this.needsRedraw) {
      this.needsRedraw = false;
      this.drawAll();
    }
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  // ---------- Template getters ----------
  get segmentCount(): number { return Math.max(0, this.segments.length - 1); }
  get isTraining(): boolean { return this.aiStats.active; }
  get trainingLabel(): string { return this.isTraining ? 'Training AI...' : 'Train AI'; }
  get activeCarModel(): string { return this.settingsService.getSettings().name; }

  get trackLength(): string {
    if (this.racingLine.length < 2) return '0 m';
    const total = this.racingLine[this.racingLine.length - 1].s;
    return `${total.toFixed(0)} m`;
  }
}
