import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { RacingLineOptimizerService } from '../../services/racing-line-optimizer.service';
import { AIDrivingService, AIGenerationStats } from '../../services/ai-driving.service';
import { ThemeService } from '../../services/theme.service';
import { SavedCarModel } from '../../services/model-library.service';
import { Car } from '../../models/Car';
import { CarAgent } from '../../models/CarAgent';
import { PieceType, Segment } from '../../models/Track';
import { CarState, RacingLinePoint } from '../../interfaces/car-state';
import {
  TrackModel, createTrackModel, trackFromSegments, DEFAULT_TRACK_HALF_WIDTH,
  simplifyPath, smoothPath, splineThroughPoints, scalePathToLength, pathLength, Vec2,
} from '../../utils/track-geometry';
import { IconComponent } from '../icon/icon.component';
import { CarSettingsComponent } from '../car-settings/car-settings.component';
import { ResultsPanelComponent } from '../results-panel/results-panel.component';
import { ModelCompareComponent, ModelComparisonResult } from '../model-compare/model-compare.component';
import { TrackTracerService } from '../../services/track-tracer.service';

const roadWidth = 30;
const PX_PER_M = 3;

interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

type SidebarTab = 'car' | 'track' | 'training';
/** How the track is being authored. Pieces stay for quick blocking-out; the others are free-form. */
export type BuildMode = 'pieces' | 'draw' | 'image';

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
  imports: [CommonModule, FormsModule, IconComponent, CarSettingsComponent, ResultsPanelComponent, ModelCompareComponent],
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
    private tracer: TrackTracerService,
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
  /** The single source of truth for simulation and rendering, whatever built it. */
  track: TrackModel | null = null;
  /** Full track width in metres — real circuits vary far more than the old fixed 10 m. */
  trackWidth = DEFAULT_TRACK_HALF_WIDTH * 2;

  buildMode: BuildMode = 'pieces';

  /** Editable control points behind a drawn/traced track. */
  controlPoints: Vec2[] = [];
  closedLoop = true;
  private isDrawing = false;
  private strokePoints: Vec2[] = [];
  private draggingPointIndex = -1;

  /** Imported reference image, drawn under the track in world space. */
  underlayImage: HTMLImageElement | null = null;
  underlayName = '';
  underlayOpacity = 0.45;
  underlayScale = 1;
  traceThreshold = 128;
  traceInvert = false;
  realLengthMeters = 3000;
  tracing = false;
  traceError: string | null = null;

  private dragPreview: any = null;
  previewTurnRight = false;
  private ctx!: CanvasRenderingContext2D;
  private racingLine: RacingLinePoint[] = [];
  showRacingLine = true;
  useOptimizedLine = true;
  showAgents = true;
  estimatedLapTime = 0;

  /** Best-effort provenance label attached to models extracted from training on this track. */
  currentTrackLabel = 'Custom Track';

  /** A model to start the next training run from, instead of a fresh random population. */
  seedModel: SavedCarModel | null = null;

  /** Which panel the telemetry drawer shows. */
  telemetryView: 'training' | 'models' = 'training';
  comparisonRunning = false;
  comparisonLines: Array<{ color: string; points: RacingLinePoint[] }> = [];
  comparisonResults: Record<string, ModelComparisonResult> = {};

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

  setTelemetryView(view: 'training' | 'models') {
    this.telemetryView = view;
    if (!this.telemetryOpen) this.toggleTelemetry();
  }

  toggleShowAgents() {
    this.showAgents = !this.showAgents;
    this.requestRedraw();
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

    const bboxWidthPx = (bbox.maxX - bbox.minX) * PX_PER_M;
    const bboxHeightPx = (bbox.maxY - bbox.minY) * PX_PER_M;

    if (bboxWidthPx < 1 && bboxHeightPx < 1) return;

    // Padding scales down on a short viewport (e.g. a small window with the telemetry drawer
    // open) instead of staying fixed at 60px each side — a fixed padding bigger than the
    // viewport itself drove `scaleX`/`scaleY` negative, which flipped and effectively hid
    // everything drawn afterwards (comparison lines, agents) with no visible error.
    const padding = Math.max(8, Math.min(60, Math.min(this.viewWidth, this.viewHeight) / 6));
    const scaleX = (this.viewWidth - padding * 2) / Math.max(bboxWidthPx, 100);
    const scaleY = (this.viewHeight - padding * 2) / Math.max(bboxHeightPx, 100);
    const scale = Math.max(0.05, Math.min(scaleX, scaleY, 2));

    const centerX = (bbox.minX + bbox.maxX) / 2 * PX_PER_M;
    const centerY = (bbox.minY + bbox.maxY) / 2 * PX_PER_M;

    this.camera.scale = scale;
    this.camera.offsetX = this.viewWidth / 2 - centerX * scale;
    this.camera.offsetY = this.viewHeight / 2 - centerY * scale;
    this.zoomLevel = Math.round(scale * 100);
  }

  private getTrackBoundingBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const pts = this.track?.points;
    if (!pts || pts.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  onCanvasMouseDown(event: MouseEvent) {
    if (this.onFreeformMouseDown(event)) return;
    if (event.button === 1 || event.button === 2 || event.altKey) {
      event.preventDefault();
      this.isPanning = true;
      this.panStart = { x: event.clientX, y: event.clientY };
      this.cameraStart = { offsetX: this.camera.offsetX, offsetY: this.camera.offsetY };
    }
  }

  onCanvasMouseMove(event: MouseEvent) {
    if (!this.isPanning && this.onFreeformMouseMove(event)) return;
    if (!this.isPanning) return;
    const dx = event.clientX - this.panStart.x;
    const dy = event.clientY - this.panStart.y;
    this.camera.offsetX = this.cameraStart.offsetX + dx;
    this.camera.offsetY = this.cameraStart.offsetY + dy;
    this.requestRedraw();
  }

  onCanvasMouseUp() {
    this.onFreeformMouseUp();
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
    this.currentTrackLabel = this.trackPresets.find(p => p.key === presetKey)?.label ?? 'Custom Track';
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
    this.currentTrackLabel = 'Custom Track';
    this.onTrackChanged();
  }

  onDragEnd() { this.dragPreview = null; }

  undoLastPiece() {
    if (this.segments.length <= 1) return;
    this.segments.pop();
    this.currentTrackLabel = 'Custom Track';
    this.onTrackChanged();
  }

  private onTrackChanged() {
    // Any edit invalidates comparison lines drawn for the previous layout.
    this.clearComparisonState();
    this.rebuildTrackFromSegments();
    this.updateRacingLine();
    this.requestRedraw();
  }

  /** Piece edits feed the unified model; drawn/traced tracks set `track` directly instead. */
  private rebuildTrackFromSegments() {
    this.track = this.segments.length
      ? trackFromSegments(this.segments, this.trackWidth / 2, this.currentTrackLabel)
      : null;
  }

  setTrackWidth(width: number) {
    this.trackWidth = Math.max(4, Math.min(40, Number(width) || 10));
    if (!this.track) return;
    // Width is part of the geometry, so the model (and its cached spatial index) is rebuilt.
    this.track = { ...this.track, points: this.track.points, halfWidth: this.trackWidth / 2 };
    this.clearComparisonState();
    this.updateRacingLine();
    this.requestRedraw();
  }

  /** Installs a free-form centreline (drawn or traced) as the active track. */
  private applyTrackPoints(points: Vec2[], label: string, closed: boolean, source: 'drawn' | 'traced') {
    if (points.length < 2) return;
    this.segments = [];
    this.currentTrackLabel = label;
    this.track = createTrackModel(points, {
      halfWidth: this.trackWidth / 2,
      closed,
      source,
      label,
    });
    this.clearComparisonState();
    this.updateRacingLine();
    this.fitTrackToView();
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
      const centerline = this.car.computeRacingLine(this.track);

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
    this.drawUnderlay();

    this.drawTrackSurface();
    this.drawRacingLine();
    this.drawComparisonLines();
    this.drawTrainingAgents();

    this.drawAuthoringOverlay();

    if (this.dragPreview && this.segments.length) {
      const last = this.segments[this.segments.length - 1];
      const ghost = trackFromSegments([this.buildNextFrom(last, this.dragPreview, this.previewTurnRight)], this.trackWidth / 2);
      this.drawTrackSurface(ghost, true);
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

  /**
   * One line per compared model, in the colour it was assigned in the comparer list — lets
   * lines from cars trained under different settings or on different tracks be read against
   * each other on whatever track is currently loaded.
   */
  private drawComparisonLines() {
    if (!this.comparisonLines.length) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2.5 / this.camera.scale;
    ctx.globalAlpha = 0.9;

    for (const line of this.comparisonLines) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = line.color;
      ctx.beginPath();
      ctx.moveTo(line.points[0].x * PX_PER_M, line.points[0].y * PX_PER_M);
      for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(line.points[i].x * PX_PER_M, line.points[i].y * PX_PER_M);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Cars are drawn at their real size in metres, derived from the car's own wheelbase.
   *
   * They were previously sized as a constant number of *screen* pixels (`8 / camera.scale`),
   * which meant zooming out inflated them in track terms — at a large track's fit-to-view zoom a
   * car came out around 10 m wide, wider than the 10 m track itself, and even at 1:1 it was
   * roughly twice the width of a real car.
   */
  private drawTrainingAgents() {
    if (!this.showAgents || !this.trainingAgents.length) return;

    const ctx = this.ctx;
    const wheelbase = Math.max(1.5, this.settingsService.getSettings().wheelbase || 2.7);
    // Overall length runs a little beyond the wheelbase at each end; width is a typical track.
    const lengthM = wheelbase * 1.6;
    const widthM = Math.max(1.6, wheelbase * 0.72);

    let length = lengthM * PX_PER_M;
    let width = widthM * PX_PER_M;

    // Below a few pixels a car is unreadable, so hold a floor on apparent size when zoomed far
    // out — but cap how far that can go, otherwise the floor reintroduces the original problem
    // and the cars swallow the track again at extreme zoom levels.
    const MIN_SCREEN_LENGTH = 4;
    const MAX_BOOST = 1.8;
    const screenLength = length * this.camera.scale;
    if (screenLength < MIN_SCREEN_LENGTH) {
      const boost = Math.min(MAX_BOOST, MIN_SCREEN_LENGTH / screenLength);
      length *= boost;
      width *= boost;
    }

    const half = length / 2;
    const halfW = width / 2;
    const detailed = length * this.camera.scale >= 14;

    ctx.save();
    ctx.globalAlpha = 0.9;

    for (const agent of this.trainingAgents) {
      const { x, y, heading, alive } = agent.state;
      ctx.save();
      ctx.translate(x * PX_PER_M, y * PX_PER_M);
      ctx.rotate(heading);
      ctx.fillStyle = alive ? this.colors.agent : this.colors.agentDead;

      ctx.beginPath();
      if (detailed) {
        // Simple silhouette: tapered nose, squared tail.
        ctx.moveTo(half, -halfW * 0.62);
        ctx.lineTo(half * 0.55, -halfW);
        ctx.lineTo(-half * 0.88, -halfW);
        ctx.lineTo(-half, -halfW * 0.72);
        ctx.lineTo(-half, halfW * 0.72);
        ctx.lineTo(-half * 0.88, halfW);
        ctx.lineTo(half * 0.55, halfW);
        ctx.lineTo(half, halfW * 0.62);
      } else {
        // Too small for detail to survive rasterisation — a plain body is cheaper and cleaner.
        ctx.rect(-half, -halfW, length, width);
      }
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

  /** Imported reference image, positioned in world space under the track. */
  private drawUnderlay() {
    if (!this.underlayImage || this.buildMode !== 'image') return;
    const ctx = this.ctx;
    const w = this.underlayImage.naturalWidth * this.underlayScale * PX_PER_M;
    const h = this.underlayImage.naturalHeight * this.underlayScale * PX_PER_M;

    ctx.save();
    ctx.globalAlpha = this.underlayOpacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.underlayImage, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** The in-progress stroke and the draggable control points behind a free-form track. */
  private drawAuthoringOverlay() {
    if (!this.isFreeform) return;
    const ctx = this.ctx;

    if (this.strokePoints.length > 1) {
      ctx.save();
      ctx.strokeStyle = this.colors.line;
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.setLineDash([6 / this.camera.scale, 4 / this.camera.scale]);
      ctx.beginPath();
      ctx.moveTo(this.strokePoints[0].x * PX_PER_M, this.strokePoints[0].y * PX_PER_M);
      for (let i = 1; i < this.strokePoints.length; i++) {
        ctx.lineTo(this.strokePoints[i].x * PX_PER_M, this.strokePoints[i].y * PX_PER_M);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (!this.controlPoints.length) return;
    const r = 4 / this.camera.scale;
    ctx.save();
    ctx.lineWidth = 1.5 / this.camera.scale;
    for (let i = 0; i < this.controlPoints.length; i++) {
      const p = this.controlPoints[i];
      ctx.beginPath();
      ctx.arc(p.x * PX_PER_M, p.y * PX_PER_M, r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? this.colors.line : this.colors.roadEdge;
      ctx.fill();
      ctx.strokeStyle = this.colors.text;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Paints a track as a stroked centreline rather than piece by piece.
   *
   * This is what lets an arbitrary shape render at all: a drawn or traced circuit has no
   * "segments" to iterate. Stroking once with round joins also removes the notches the old
   * per-piece fills left at every joint, and is far cheaper than filling thousands of quads on
   * a long circuit.
   */
  private drawTrackSurface(model: TrackModel | null = this.track, ghost = false) {
    if (!model || model.points.length < 2) return;

    const ctx = this.ctx;
    const widthPx = model.halfWidth * 2 * PX_PER_M;
    const edgePx = 3 / this.camera.scale;

    ctx.save();
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(model.points[0].x * PX_PER_M, model.points[0].y * PX_PER_M);
    for (let i = 1; i < model.points.length; i++) {
      ctx.lineTo(model.points[i].x * PX_PER_M, model.points[i].y * PX_PER_M);
    }
    if (model.closed) ctx.closePath();

    // Edge lines come free by stroking a wider path underneath the road colour.
    ctx.strokeStyle = this.colors.roadEdge;
    ctx.lineWidth = widthPx + edgePx * 2;
    ctx.stroke();

    ctx.strokeStyle = this.colors.road;
    ctx.lineWidth = widthPx;
    ctx.stroke();

    ctx.strokeStyle = this.colors.centerline;
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.setLineDash([12 / this.camera.scale, 10 / this.camera.scale]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!ghost) this.drawStartFinish(model, widthPx);
    ctx.restore();
  }

  /** Chequered bar across the track at s = 0. */
  private drawStartFinish(model: TrackModel, widthPx: number) {
    const ctx = this.ctx;
    const start = model.points[0];
    const barLength = Math.max(4, widthPx * 0.16);
    const cell = Math.max(2, widthPx / 8);

    ctx.save();
    ctx.translate(start.x * PX_PER_M, start.y * PX_PER_M);
    ctx.rotate(start.heading);

    const rows = Math.max(1, Math.round(widthPx / cell));
    const cols = Math.max(1, Math.round(barLength / cell));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? this.colors.kerbA : this.colors.kerbB;
        ctx.fillRect(c * cell, -widthPx / 2 + r * cell, cell, cell);
      }
    }
    ctx.restore();
  }

  // ---------- Free-form authoring ----------

  setBuildMode(mode: BuildMode) {
    this.buildMode = mode;
    this.requestRedraw();
  }

  get isFreeform(): boolean {
    return this.buildMode !== 'pieces';
  }

  get canEditPoints(): boolean {
    return this.isFreeform && this.controlPoints.length > 1;
  }

  /** Rebuilds the track from the current control points, fitting a smooth curve through them. */
  private rebuildFromControlPoints(fit = true) {
    if (this.controlPoints.length < 2) {
      this.track = null;
      this.racingLine = [];
      this.requestRedraw();
      return;
    }
    const curve = fit && this.controlPoints.length > 2
      ? splineThroughPoints(this.controlPoints, this.closedLoop, 10)
      : this.controlPoints;
    this.applyTrackPoints(curve, this.currentTrackLabel, this.closedLoop, this.track?.source === 'traced' ? 'traced' : 'drawn');
  }

  toggleClosedLoop() {
    this.closedLoop = !this.closedLoop;
    this.rebuildFromControlPoints();
  }

  clearDrawing() {
    this.controlPoints = [];
    this.track = null;
    this.racingLine = [];
    this.clearComparisonState();
    this.requestRedraw();
  }

  // --- pointer handling for draw/edit ---

  /** Index of a control point under the cursor, or -1. Radius is in screen pixels. */
  private pointAt(world: Vec2): number {
    const tolerance = 9 / this.camera.scale / PX_PER_M;
    for (let i = 0; i < this.controlPoints.length; i++) {
      if (Math.hypot(this.controlPoints[i].x - world.x, this.controlPoints[i].y - world.y) <= tolerance) return i;
    }
    return -1;
  }

  onFreeformMouseDown(event: MouseEvent): boolean {
    if (!this.isFreeform || event.button !== 0 || event.altKey) return false;
    const world = this.eventToWorld(event);

    const hit = this.pointAt(world);
    if (hit !== -1) {
      // Shift-click removes a point; otherwise start dragging it.
      if (event.shiftKey) {
        this.controlPoints.splice(hit, 1);
        this.rebuildFromControlPoints();
      } else {
        this.draggingPointIndex = hit;
      }
      return true;
    }

    this.isDrawing = true;
    this.strokePoints = [world];
    return true;
  }

  onFreeformMouseMove(event: MouseEvent): boolean {
    if (!this.isFreeform) return false;
    const world = this.eventToWorld(event);

    if (this.draggingPointIndex !== -1) {
      this.controlPoints[this.draggingPointIndex] = world;
      this.rebuildFromControlPoints();
      return true;
    }

    if (this.isDrawing) {
      const last = this.strokePoints[this.strokePoints.length - 1];
      // Thin the raw stream; a mouse emits far more samples than the shape needs.
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 1.5) {
        this.strokePoints.push(world);
        this.requestRedraw();
      }
      return true;
    }
    return false;
  }

  onFreeformMouseUp(): boolean {
    if (!this.isFreeform) return false;

    if (this.draggingPointIndex !== -1) {
      this.draggingPointIndex = -1;
      return true;
    }

    if (!this.isDrawing) return false;
    this.isDrawing = false;

    if (this.strokePoints.length < 3) {
      // A click rather than a stroke: append a single control point.
      if (this.strokePoints.length === 1) {
        this.controlPoints.push(this.strokePoints[0]);
        this.rebuildFromControlPoints();
      }
      this.strokePoints = [];
      return true;
    }

    // A freehand stroke becomes control points, so it stays editable afterwards.
    const simplified = simplifyPath(this.strokePoints, 2.5);
    this.controlPoints = this.controlPoints.length
      ? [...this.controlPoints, ...simplified]
      : simplified;
    this.strokePoints = [];
    this.currentTrackLabel = this.currentTrackLabel === 'Custom Track' ? 'Drawn Track' : this.currentTrackLabel;
    this.rebuildFromControlPoints();
    return true;
  }

  private eventToWorld(event: MouseEvent): Vec2 {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    return this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  }

  // ---------- Image import & tracing ----------

  async onImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.traceError = null;
    try {
      this.underlayImage = await this.loadImage(file);
      this.underlayName = file.name;
      this.buildMode = 'image';
      this.fitUnderlayToView();
      this.requestRedraw();
    } catch {
      this.traceError = `Could not read "${file.name}" as an image.`;
    }
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  /** Sizes the underlay so it roughly fills the current view, in world metres. */
  private fitUnderlayToView() {
    if (!this.underlayImage) return;
    const worldWidth = this.viewWidth / this.camera.scale / PX_PER_M;
    this.underlayScale = worldWidth / Math.max(1, this.underlayImage.naturalWidth) * 0.8;
  }

  async runTrace() {
    if (!this.underlayImage || this.tracing) return;
    this.tracing = true;
    this.traceError = null;

    try {
      const result = await this.tracer.trace(this.underlayImage, {
        threshold: this.traceThreshold,
        invert: this.traceInvert,
        realLengthMeters: this.realLengthMeters,
      });

      // The traced path becomes editable control points, so a bad corner can be dragged out
      // rather than forcing a re-trace.
      this.controlPoints = simplifyPath(result.points, 4);
      this.closedLoop = result.closed;
      this.currentTrackLabel = this.underlayName.replace(/\.[^.]+$/, '') || 'Traced Track';
      this.applyTrackPoints(result.points, this.currentTrackLabel, result.closed, 'traced');
    } catch (err) {
      this.traceError = err instanceof Error ? err.message : 'Tracing failed.';
    } finally {
      this.tracing = false;
    }
  }

  setUnderlayOpacity(value: number) {
    this.underlayOpacity = Math.max(0, Math.min(1, Number(value) || 0));
    this.requestRedraw();
  }

  clearUnderlay() {
    this.underlayImage = null;
    this.underlayName = '';
    this.traceError = null;
    this.requestRedraw();
  }

  // ---------- Simulation Control ----------
  async startAITraining() {
    if (!this.track || this.track.points.length < 2) {
      alert('Build, draw or import a track first.');
      return;
    }

    this.trainingAgents = [];
    this.aiStats = { ...this.aiStats, active: true };
    this.aiDrivingService.clearHistory();

    if (!this.track) return;
    const result = await this.aiDrivingService.train(
      this.settingsService.getSettings(),
      this.track,
      { ...this.aiConfig, seedWeights: this.seedModel?.weights ?? null },
      this.currentTrackLabel
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

  // ---------- Models: seeding & comparison ----------
  onUseModelAsSeed(model: SavedCarModel) {
    this.seedModel = model;
    this.activeTab = 'training';
  }

  clearSeedModel() {
    this.seedModel = null;
  }

  /**
   * Runs each selected model's frozen genome (no evolution) against the currently loaded track
   * and draws the resulting line in that model's colour, so lines from cars trained under
   * different settings or on different tracks can be compared directly on one layout.
   */
  async onRunModelComparison(entries: Array<{ model: SavedCarModel; color: string }>) {
    if (this.isTraining || this.comparisonRunning || !this.track) return;

    this.comparisonRunning = true;
    this.comparisonLines = [];

    for (const { model, color } of entries) {
      const result = await this.aiDrivingService.runGenomeOnTrack(model.weights, model.carSettings, this.track!);
      this.comparisonResults = {
        ...this.comparisonResults,
        [model.id]: { lapTime: result.lapTime, progress: result.progress, completed: result.completed },
      };
      this.comparisonLines = [...this.comparisonLines, { color, points: result.trajectory }];
      this.requestRedraw();
    }

    this.comparisonRunning = false;
  }

  clearTrack() {
    this.segments = [];
    this.track = null;
    this.racingLine = [];
    this.estimatedLapTime = 0;
    this.currentTrackLabel = 'Custom Track';
    this.clearComparisonState();
    this.car.resetCar();
    this.requestRedraw();
  }

  /** Comparison lines and results describe a specific track — stale once it changes. */
  private clearComparisonState() {
    this.comparisonLines = [];
    this.comparisonResults = {};
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
