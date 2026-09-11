import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { RacingLineOptimizerService } from '../../services/racing-line-optimizer.service';
import { AIDrivingService, AIGenerationStats, AgentSnapshot } from '../../services/ai-driving.service';
import { ThemePreference, ThemeService } from '../../services/theme.service';
import { SavedCarModel } from '../../services/model-library.service';
import { Car } from '../../models/Car';
import { PlayerCar, DriverInput, PlayerTelemetry } from '../../models/PlayerCar';
import { TrainingObjective } from '../../utils/drift-scoring';
import { PieceType, Segment } from '../../models/Track';
import { CarState, RacingLinePoint } from '../../interfaces/car-state';
import { getTrackLength } from '../../utils/track-utils';
import {
  TrackModel, createTrackModel, trackFromSegments, DEFAULT_TRACK_HALF_WIDTH,
  simplifyPath, smoothPath, splineThroughPoints, scalePathToLength, pathLength, Vec2, normalizeAngle,
} from '../../utils/track-geometry';
import { IconComponent } from '../icon/icon.component';
import { CarSettingsComponent } from '../car-settings/car-settings.component';
import { ResultsPanelComponent } from '../results-panel/results-panel.component';
import { ModelCompareComponent, ModelComparisonResult } from '../model-compare/model-compare.component';
import { TrackTracerService } from '../../services/track-tracer.service';
import { DriverHudComponent, LapRecord } from '../driver-hud/driver-hud.component';

const roadWidth = 30;
const PX_PER_M = 3;

/** Identity of the objects the scene layer depends on, as a string the cache key can carry. */
const revisions = new WeakMap<object, number>();
let nextRevision = 1;
function sceneRevision(value: object): string {
  let id = revisions.get(value);
  if (id === undefined) {
    id = nextRevision++;
    revisions.set(value, id);
  }
  return `#${id}`;
}

interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

type SidebarTab = 'car' | 'track' | 'training' | 'drive';
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
  curbA: string;
  curbB: string;
  line: string;
  lineAlt: string;
  agent: string;
  agentDead: string;
  player: string;
  playerLine: string;
  text: string;
}

@Component({
  selector: 'app-track-view',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CarSettingsComponent, ResultsPanelComponent, ModelCompareComponent, DriverHudComponent],
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
  /** The field as last published — poses only; the cars themselves live in the training worker. */
  private trainingAgents: AgentSnapshot[] = [];
  aiStats: AIGenerationStats = {
    generation: 0,
    bestFitness: 0,
    bestLapTime: 0,
    bestProgress: 0,
    aliveCount: 0,
    averageFitness: 0,
    active: false,
    carModel: '',
    bestDriftScore: 0,
    objective: 'grip',
  };
  aiConfig = {
    populationSize: 25,
    generations: 20,
    mutationRate: 0.2,
  };

  /** What the AI is being asked to learn. Grip is the existing behaviour, unchanged. */
  objective: TrainingObjective = 'grip';

  /**
   * Simulation speed, as a slider index into `speedSteps`.
   *
   * A small population finishes a generation faster than the eye can follow, so watching how a
   * driver actually behaves needs the physics paced to real time. A large one is limited by
   * compute instead, and wants to run flat out.
   */
  speedIndex = 5;

  readonly speedSteps: Array<{ value: number; label: string }> = [
    { value: 0.25, label: '¼×' },
    { value: 0.5, label: '½×' },
    { value: 1, label: '1×' },
    { value: 2, label: '2×' },
    { value: 5, label: '5×' },
    { value: Number.POSITIVE_INFINITY, label: 'Max' },
  ];

  readonly objectives: Array<{ value: TrainingObjective; label: string; blurb: string }> = [
    { value: 'grip', label: 'Grip', blurb: 'Fastest lap: the racing line, trail braking, and every tenth of grip spent going forward.' },
    { value: 'drift', label: 'Drift', blurb: 'Angle held at speed: points for a big controlled slide, nothing for a spin or a straight car.' },
  ];

  /**
   * Drift needs far more generations than grip, and the reason is structural rather than a
   * tuning problem: the population has to learn to drive the track first (about 30 generations)
   * and only then starts adding angle. Measured on a four-corner circuit, the champion held 4%
   * drift time at generation 60 and 16% by 120 — a run stopped at 80 looks like it has simply
   * learned to grip, because that is genuinely all it has managed so far.
   */
  private static readonly SUGGESTED_DRIFT_GENERATIONS = 200;

  /**
   * The drivetrain the car had before drift mode forced RWD + LSD, so leaving drift puts the
   * car back the way it was rather than silently keeping the drift setup.
   */
  private preDriftDrivetrain: {
    drivetrain: CarSettings['drivetrain'];
    differential: CarSettings['differential'];
    steeringLockDeg: number;
  } | null = null;

  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  constructor(
    private settingsService: CarSettingsService,
    private lineOptimizer: RacingLineOptimizerService,
    private aiDrivingService: AIDrivingService,
    private themeService: ThemeService,
    private tracer: TrackTracerService,
  ) {}

  activeTab: SidebarTab = 'track';
  telemetryOpen = false;

  /**
   * The panel docks beside the rail and folds away entirely.
   *
   * The canvas runs edge to edge underneath, so collapsing the dock hands the
   * whole instrument back to the track rather than merely narrowing a column.
   */
  dockCollapsed = window.innerWidth <= TrackViewComponent.COMPACT_W;

  /** Tracks breakpoint crossings so the dock folds itself away on the way down. */
  private wasCompact = window.innerWidth <= TrackViewComponent.COMPACT_W;

  readonly themeOptions: Array<{ value: ThemePreference; icon: string; label: string }> = [
    { value: 'light', icon: 'sun', label: 'Light' },
    { value: 'dark', icon: 'moon', label: 'Dark' },
    { value: 'system', icon: 'monitor', label: 'System' },
  ];

  readonly tabs: Array<{ id: SidebarTab; label: string; icon: string }> = [
    { id: 'car', label: 'Car', icon: 'car' },
    { id: 'track', label: 'Track', icon: 'track' },
    { id: 'training', label: 'Training', icon: 'cpu' },
    { id: 'drive', label: 'Drive', icon: 'steering' },
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

  /**
   * Draw adds geometry; Edit only adjusts what is already there. Splitting them is what stops a
   * stray click from appending to the track while you are trying to nudge a corner.
   */
  drawTool: 'draw' | 'edit' = 'draw';

  /** Snapshots of controlPoints taken before each mutation, for undo. */
  private pointHistory: Vec2[][] = [];
  private static readonly MAX_HISTORY = 60;

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

  /**
   * The ground — grid, image underlay, track surface and kerbs — rendered once and blitted.
   *
   * During training the field repaints tens of times a second, and nothing under it changes
   * between paints; re-tessellating a few hundred kerb stripes and a five-megapixel grid every
   * time was most of the frame. The layer is keyed on everything it depends on and rebuilt
   * only when that key changes: a pan, a zoom, an edit, a theme switch.
   */
  private sceneLayer: HTMLCanvasElement | null = null;
  private sceneLayerCtx: CanvasRenderingContext2D | null = null;
  private sceneLayerKey = '';

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
  /** Kerb geometry is derived from the track, so it's built once per model rather than per frame. */
  private kerbCache = new WeakMap<TrackModel, Array<{ left: Vec2[]; right: Vec2[] }>>();

  // ---------- Drive mode ----------
  /**
   * The human-driven car runs the same physics and the same track limits as the AI, stepped at
   * the same fixed 1/30 s. Frame rate therefore has no effect on the lap time, which is what
   * makes a player's lap comparable with an agent's rather than a function of their monitor.
   */
  /*
   * Chrome insets, matching the rail, dock, strip and telemetry sizes in CSS.
   *
   * The canvas is the ground and runs edge to edge underneath the chrome, so
   * fitting or following has to centre the track in the part of it you can
   * actually see; centring on the raw element would park the car behind the
   * docked panel.
   */
  private static readonly RAIL_W = 52;
  private static readonly DOCK_W = 312;
  private static readonly STRIP_H = 44;
  private static readonly TELEMETRY_H = 268;

  /**
   * Below this width the panel overlays the canvas instead of sitting beside it,
   * the rail narrows and the drawer is sized as a fraction of the viewport.
   * Mirrors the `@media (max-width: 900px)` block in the component stylesheet —
   * change one and you must change the other.
   */
  private static readonly COMPACT_W = 900;
  private static readonly RAIL_W_COMPACT = 46;
  private static readonly TELEMETRY_FRACTION = 0.46;

  /** Live cars beyond this are painted as marks, not silhouettes; see drawTrainingAgents. */
  private static readonly SILHOUETTE_LIMIT = 1200;

  private static readonly PLAYER_DT = 1 / 30;
  private static readonly MAX_CATCHUP_STEPS = 8;

  driveMode = false;
  playerCar: PlayerCar | null = null;
  playerTelemetry: PlayerTelemetry | null = null;
  followCam = true;
  showPlayerLine = true;
  playerBestLap = 0;
  /** Best drift score the driver has banked on this track. */
  playerBestDrift = 0;
  lastLap: LapRecord | null = null;
  lapHistory: LapRecord[] = [];
  /** The line from the driver's best lap so far, kept to compare routes against the AI's. */
  playerBestLine: RacingLinePoint[] = [];

  private heldKeys = new Set<string>();
  private physicsAccumulator = 0;

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
    this.playerCar = new PlayerCar(this.settingsService.getSettings());
    this.playerCar.objective = this.objective;

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
      // Every driving trait — top speed, grip, weight transfer, off-track grace, car size — is
      // derived from these settings, so a change mid-session re-arms the run rather than
      // leaving the driver in a car whose stats no longer match the panel.
      this.playerCar?.updateSettings(settings);
      if (this.driveMode) this.resetRun();
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
    // Clicking the rail while the panel is folded away should open it rather than
    // silently changing which panel would appear if it were open.
    if (this.dockCollapsed) {
      this.activeTab = tab;
      this.toggleDock();
      return;
    }
    // Clicking the panel already showing folds it away, so the rail doubles as a toggle.
    if (this.activeTab === tab) {
      this.toggleDock();
      return;
    }
    this.activeTab = tab;
  }

  get themePreference(): ThemePreference {
    return this.themeService.preference;
  }

  setTheme(preference: ThemePreference) {
    this.themeService.setPreference(preference);
  }

  get activeTabLabel(): string {
    return this.tabs.find(tab => tab.id === this.activeTab)?.label ?? '';
  }

  toggleDock() {
    this.dockCollapsed = !this.dockCollapsed;
    this.afterLayoutChange();
  }

  /** The figure the strip leads with: drift points when drifting, lap time otherwise. */
  get headlineLabel(): string {
    return this.isDrift ? 'Best drift' : 'Best lap';
  }

  get headlineValue(): string {
    if (this.isDrift) {
      return this.aiStats.bestDriftScore ? this.aiStats.bestDriftScore.toFixed(0) : '—';
    }
    return this.aiStats.bestLapTime ? this.aiStats.bestLapTime.toFixed(2) : '—';
  }

  get headlineUnit(): string {
    if (this.isDrift) return this.aiStats.bestDriftScore ? 'pts' : '';
    return this.aiStats.bestLapTime ? 's' : '';
  }

  /** Generations done as a 0..1 fraction, clamped so a bad config cannot overscale the bar. */
  get trainingProgress(): number {
    const total = this.aiConfig.generations;
    if (!total || total <= 0) return 0;
    return Math.min(1, Math.max(0, this.aiStats.generation / total));
  }

  /** Idle, running or finished — the one word the strip reports about the session. */
  get sessionState(): 'idle' | 'running' | 'ready' {
    if (this.isTraining) return 'running';
    return this.aiStats.generation > 0 ? 'ready' : 'idle';
  }

  /** The canvas box changed, so re-measure it and repaint on the next frame. */
  private afterLayoutChange() {
    requestAnimationFrame(() => {
      this.resizeCanvasToContainer();
      this.requestRedraw();
    });
  }

  toggleTelemetry() {
    this.telemetryOpen = !this.telemetryOpen;
    this.afterLayoutChange();
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
      curbA: read('--canvas-curb-a', '#e2e8f0'),
      curbB: read('--canvas-curb-b', '#c0392f'),
      line: read('--canvas-line', '#22c55e'),
      lineAlt: read('--canvas-line-alt', '#38bdf8'),
      agent: read('--canvas-agent', '#f4c14e'),
      agentDead: read('--canvas-agent-dead', '#7f3f45'),
      player: read('--canvas-player', '#38bdf8'),
      playerLine: read('--canvas-player-line', '#0ea5e9'),
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

  /** True while the compact layout is in force; see COMPACT_W. */
  private get isCompact(): boolean {
    return window.innerWidth <= TrackViewComponent.COMPACT_W;
  }

  private get viewInsetLeft(): number {
    // Compact: the dock floats over the canvas, so only the rail takes width off it.
    if (this.isCompact) return TrackViewComponent.RAIL_W_COMPACT;
    return TrackViewComponent.RAIL_W + (this.dockCollapsed ? 0 : TrackViewComponent.DOCK_W);
  }

  private get viewInsetBottom(): number {
    if (!this.telemetryOpen) return 0;
    return this.isCompact
      ? TrackViewComponent.TELEMETRY_FRACTION * this.viewHeight
      : TrackViewComponent.TELEMETRY_H;
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
    const left = this.viewInsetLeft;
    const top = TrackViewComponent.STRIP_H;
    const usableW = Math.max(120, this.viewWidth - left);
    const usableH = Math.max(120, this.viewHeight - top - this.viewInsetBottom);

    const padding = Math.max(8, Math.min(60, Math.min(usableW, usableH) / 6));
    const scaleX = (usableW - padding * 2) / Math.max(bboxWidthPx, 100);
    const scaleY = (usableH - padding * 2) / Math.max(bboxHeightPx, 100);
    const scale = Math.max(0.05, Math.min(scaleX, scaleY, 2));

    const centerX = (bbox.minX + bbox.maxX) / 2 * PX_PER_M;
    const centerY = (bbox.minY + bbox.maxY) / 2 * PX_PER_M;

    this.camera.scale = scale;
    this.camera.offsetX = left + usableW / 2 - centerX * scale;
    this.camera.offsetY = top + usableH / 2 - centerY * scale;
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
    const panWithLeftDrag = this.isFreeform && this.drawTool === 'edit' && event.button === 0;
    if (event.button === 1 || event.button === 2 || event.altKey || panWithLeftDrag) {
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
  private applyTrackPoints(
    points: Vec2[],
    label: string,
    closed: boolean,
    source: 'drawn' | 'traced',
    fitView = false
  ) {
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
    // Only recentre when a track first appears. Refitting on every rebuild made the view jump
    // on each mousemove while dragging a point, which made editing almost unusable.
    if (fitView) this.fitTrackToView();
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
    // Gated on the track rather than on `segments`, which only exist for piece-built layouts —
    // drawn and traced tracks were silently getting no racing line and no reference lap time,
    // even though `computeRacingLine` works from the unified model for all three.
    if (!this.car || !this.track || this.track.points.length < 2) {
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
    const compact = this.isCompact;
    // Only the downward crossing folds the dock: widening must not undo a
    // deliberate choice to keep the panel open.
    if (compact && !this.wasCompact) this.dockCollapsed = true;
    this.wasCompact = compact;

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

    this.drawSceneLayer(canvas);

    ctx.save();
    ctx.translate(this.camera.offsetX, this.camera.offsetY);
    ctx.scale(this.camera.scale, this.camera.scale);

    this.drawRacingLine();
    this.drawComparisonLines();
    this.drawTrainingAgents();
    this.drawPlayerLine();
    this.drawPlayerCar();

    this.drawAuthoringOverlay();

    if (this.dragPreview && this.segments.length) {
      const last = this.segments[this.segments.length - 1];
      const ghost = trackFromSegments([this.buildNextFrom(last, this.dragPreview, this.previewTurnRight)], this.trackWidth / 2);
      this.drawTrackSurface(ghost, true);
    }

    ctx.restore();
  }

  /** Blits the cached ground, rebuilding it first if anything it shows has changed. */
  private drawSceneLayer(canvas: HTMLCanvasElement) {
    const key = [
      canvas.width, canvas.height, this.dpr,
      this.camera.scale, this.camera.offsetX, this.camera.offsetY,
      this.track, this.trackWidth, this.colors,
      this.buildMode === 'image' ? this.underlayImage : null, this.underlayScale, this.underlayOpacity,
    ].map(v => (typeof v === 'object' && v !== null ? sceneRevision(v) : String(v))).join('|');

    if (!this.sceneLayer || !this.sceneLayerCtx) {
      this.sceneLayer = document.createElement('canvas');
      this.sceneLayerCtx = this.sceneLayer.getContext('2d');
      if (!this.sceneLayerCtx) return;
    }

    if (key !== this.sceneLayerKey) {
      const layer = this.sceneLayer;
      const layerCtx = this.sceneLayerCtx;
      if (layer.width !== canvas.width || layer.height !== canvas.height) {
        layer.width = canvas.width;
        layer.height = canvas.height;
      }
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.clearRect(0, 0, layer.width, layer.height);
      layerCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      layerCtx.save();
      layerCtx.translate(this.camera.offsetX, this.camera.offsetY);
      layerCtx.scale(this.camera.scale, this.camera.scale);

      // The ground painters draw through `this.ctx`; point it at the layer for the duration.
      const main = this.ctx;
      this.ctx = layerCtx;
      try {
        this.drawGrid(40);
        this.drawUnderlay();
        this.drawTrackSurface();
      } finally {
        this.ctx = main;
      }
      layerCtx.restore();
      this.sceneLayerKey = key;
    }

    // Device pixels to device pixels: one copy, no scaling.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.sceneLayer, 0, 0);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
  private carScreenSize(): { length: number; width: number } {
    const wheelbase = Math.max(1.5, this.settingsService.getSettings().wheelbase || 2.7);
    // Overall length runs a little beyond the wheelbase at each end; width is a typical track.
    const lengthM = wheelbase * 1.6;
    const widthM = Math.max(1.6, wheelbase * 0.72);

    let length = lengthM * PX_PER_M;
    let width = widthM * PX_PER_M;

    // Real size is the truth, but a real car is only a couple of screen pixels once the view is
    // zoomed out far enough to see a whole circuit, which reads as specks rather than cars. So
    // grow them toward a legible minimum — capped as a *fraction of the road* rather than a fixed
    // multiple, which is what keeps them from ever swallowing the track (the original bug) while
    // still letting them scale up sensibly on a wide circuit.
    const MIN_SCREEN_LENGTH = 10;
    const MAX_TRACK_FRACTION = 0.5;
    const roadWidthPx = (this.track?.halfWidth ?? DEFAULT_TRACK_HALF_WIDTH) * 2 * PX_PER_M;

    const screenLength = length * this.camera.scale;
    if (screenLength < MIN_SCREEN_LENGTH) {
      const legibilityBoost = MIN_SCREEN_LENGTH / screenLength;
      const widthCapBoost = (roadWidthPx * MAX_TRACK_FRACTION) / width;
      const boost = Math.max(1, Math.min(legibilityBoost, widthCapBoost));
      length *= boost;
      width *= boost;
    }

    return { length, width };
  }

  /**
   * The field, thousands of cars at a time, painted tens of times a second.
   *
   * Measured at 4000 cars: the per-car save / translate / rotate / restore dance cost ~15 ms a
   * paint, most of it on wreckage. So a dead car is a plain square where it stopped — one
   * `fillRect` with no transform, its heading no longer matters — and a live car gets exactly
   * one `setTransform`. Mid-generation, when most of the grid is wreckage, that is a ~5x
   * cheaper paint; a single batched path was measured and rejected, since one huge path with
   * thousands of subpaths rasterises far slower than thousands of small ones.
   */
  private drawTrainingAgents() {
    if (!this.showAgents || !this.trainingAgents.length) return;

    const ctx = this.ctx;
    const { length, width } = this.carScreenSize();

    const half = length / 2;
    const halfW = width / 2;
    const detailed = length * this.camera.scale >= 14;

    // The scene transform in effect right now: DPR, then camera. Rebuilt per car below.
    const k = this.dpr * this.camera.scale;
    const tx = this.dpr * this.camera.offsetX;
    const ty = this.dpr * this.camera.offsetY;

    ctx.save();
    ctx.globalAlpha = 0.9;

    // Wreckage first, so live cars paint over it.
    ctx.fillStyle = this.colors.agentDead;
    const mark = Math.max(width * 0.8, 1.5 / this.camera.scale);
    let aliveCount = 0;
    for (const agent of this.trainingAgents) {
      const { x, y, alive } = agent.state;
      if (alive) { aliveCount++; continue; }
      ctx.fillRect(x * PX_PER_M - mark / 2, y * PX_PER_M - mark / 2, mark, mark);
    }

    ctx.fillStyle = this.colors.agent;

    // A whole grid alive at once — the first seconds of every generation — is one overlapping
    // blob at the start line where no silhouette can be told from its neighbour, and painting
    // thousands of rotated polygons a frame is what turns that moment into a stutter. Past a
    // crowd, a live car is a plain mark like the wreckage, only in the live colour.
    if (aliveCount > TrackViewComponent.SILHOUETTE_LIMIT) {
      const body = Math.max(width, 2 / this.camera.scale);
      for (const agent of this.trainingAgents) {
        const { x, y, alive } = agent.state;
        if (!alive) continue;
        ctx.fillRect(x * PX_PER_M - body / 2, y * PX_PER_M - body / 2, body, body);
      }
      ctx.restore();
      return;
    }

    for (const agent of this.trainingAgents) {
      const { x, y, heading, alive } = agent.state;
      if (!alive) continue;
      const c = Math.cos(heading) * k;
      const s = Math.sin(heading) * k;
      ctx.setTransform(c, s, -s, c, k * x * PX_PER_M + tx, k * y * PX_PER_M + ty);

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
    }

    // restore() puts the scene transform back for whatever draws next.
    ctx.restore();
  }

  /**
   * The driver's line: the lap in progress solid, their best lap so far faded underneath.
   *
   * This is the point of driving at all — seeing your route next to the AI's makes the places
   * you differ, and which of you is right, immediately legible.
   */
  private drawPlayerLine() {
    if (!this.driveMode || !this.showPlayerLine) return;

    const ctx = this.ctx;
    const stroke = (points: RacingLinePoint[], alpha: number, dashed: boolean) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = this.colors.playerLine;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.5 / this.camera.scale;
      ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash([8 / this.camera.scale, 6 / this.camera.scale]);
      ctx.beginPath();
      ctx.moveTo(points[0].x * PX_PER_M, points[0].y * PX_PER_M);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * PX_PER_M, points[i].y * PX_PER_M);
      }
      ctx.stroke();
      ctx.restore();
    };

    stroke(this.playerBestLine, 0.4, true);
    if (this.playerCar) stroke(this.playerCar.trail, 0.95, false);
  }

  /** The player's car, drawn at the same real-world size as the agents but in its own colour. */
  private drawPlayerCar() {
    const car = this.playerCar;
    if (!this.driveMode || !car || !this.hasTrack) return;

    const ctx = this.ctx;
    const { length, width } = this.carScreenSize();
    const half = length / 2;
    const halfW = width / 2;

    ctx.save();
    ctx.translate(car.state.x * PX_PER_M, car.state.y * PX_PER_M);
    ctx.rotate(car.state.heading);

    ctx.fillStyle = this.colors.player;
    ctx.beginPath();
    if (length * this.camera.scale >= 14) {
      ctx.moveTo(half, -halfW * 0.62);
      ctx.lineTo(half * 0.55, -halfW);
      ctx.lineTo(-half * 0.88, -halfW);
      ctx.lineTo(-half, -halfW * 0.72);
      ctx.lineTo(-half, halfW * 0.72);
      ctx.lineTo(-half * 0.88, halfW);
      ctx.lineTo(half * 0.55, halfW);
      ctx.lineTo(half, halfW * 0.62);
    } else {
      ctx.rect(-half, -halfW, length, width);
    }
    ctx.closePath();
    ctx.fill();

    // A ring while the car is off the track surface — the grip penalty is invisible otherwise.
    if (car.status === 'running' && this.playerTelemetry && !this.playerTelemetry.onTrack) {
      ctx.strokeStyle = this.colors.curbB;
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(half, halfW) * 1.6, 0, Math.PI * 2);
      ctx.stroke();
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

    if (!ghost) this.drawKerbs(model);

    ctx.strokeStyle = this.colors.centerline;
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.setLineDash([12 / this.camera.scale, 10 / this.camera.scale]);
    ctx.beginPath();
    ctx.moveTo(model.points[0].x * PX_PER_M, model.points[0].y * PX_PER_M);
    for (let i = 1; i < model.points.length; i++) {
      ctx.lineTo(model.points[i].x * PX_PER_M, model.points[i].y * PX_PER_M);
    }
    if (model.closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    if (!ghost) this.drawStartFinish(model, widthPx);
    ctx.restore();
  }

  /**
   * Kerb strips, placed only where the track actually curves.
   *
   * Real circuits only kerb the corners, so keying this off curvature is what makes a drawn or
   * traced layout read as a racetrack rather than a striped ribbon. Each corner run is widened a
   * little at both ends so the kerb starts before turn-in and runs past the exit, as it does in
   * reality.
   */
  private getKerbRuns(model: TrackModel): Array<{ left: Vec2[]; right: Vec2[] }> {
    const cached = this.kerbCache.get(model);
    if (cached) return cached;

    const pts = model.points;
    const runs: Array<{ left: Vec2[]; right: Vec2[] }> = [];
    if (pts.length < 5) {
      this.kerbCache.set(model, runs);
      return runs;
    }

    const CURVATURE_THRESHOLD = 0.010;   // ~1/100 m radius; gentler than this reads as a straight
    const RUN_PADDING = 4;               // points of lead-in / run-off, at 2 m spacing

    const n = pts.length;
    const wrap = model.closed;
    // Arc length is measured between the neighbours directly rather than differenced off `s`,
    // because on a closed track `s` resets at the seam and the difference there is meaningless.
    const span = (a: number, b: number) => Math.hypot(pts[b].x - pts[a].x, pts[b].y - pts[a].y);

    const corner = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : (wrap ? n - 1 : -1);
      const next = i < n - 1 ? i + 1 : (wrap ? 0 : -1);
      if (prev < 0 || next < 0) continue;
      const ds = span(prev, i) + span(i, next);
      if (ds <= 0) continue;
      const curvature = Math.abs(normalizeAngle(pts[next].heading - pts[prev].heading)) / ds;
      if (curvature > CURVATURE_THRESHOLD) corner[i] = 1;
    }

    // Widen each corner run, then walk out contiguous stretches.
    const padded = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!corner[i]) continue;
      for (let d = -RUN_PADDING; d <= RUN_PADDING; d++) {
        const k = wrap ? (i + d + n) % n : i + d;
        if (k >= 0 && k < n) padded[k] = 1;
      }
    }

    const kerbWidth = Math.min(1.4, model.halfWidth * 0.3);
    const offset = model.halfWidth - kerbWidth / 2;

    let i = 0;
    while (i < pts.length) {
      if (!padded[i]) { i++; continue; }
      const left: Vec2[] = [];
      const right: Vec2[] = [];
      while (i < pts.length && padded[i]) {
        const p = pts[i];
        const nx = -Math.sin(p.heading);
        const ny = Math.cos(p.heading);
        left.push({ x: p.x + nx * offset, y: p.y + ny * offset });
        right.push({ x: p.x - nx * offset, y: p.y - ny * offset });
        i++;
      }
      if (left.length > 1) runs.push({ left, right });
    }

    // A corner straddling the seam comes out as two runs; join them so the stripe is unbroken.
    if (wrap && runs.length > 1 && padded[0] && padded[n - 1]) {
      const tail = runs.pop()!;
      runs[0].left = tail.left.concat(runs[0].left);
      runs[0].right = tail.right.concat(runs[0].right);
    }

    this.kerbCache.set(model, runs);
    return runs;
  }

  private drawKerbs(model: TrackModel) {
    const runs = this.getKerbRuns(model);
    if (!runs.length) return;

    const ctx = this.ctx;
    const kerbWidth = Math.min(1.4, model.halfWidth * 0.3) * PX_PER_M;
    // Below a pixel or so the stripes just alias into mush, so skip them when zoomed far out.
    if (kerbWidth * this.camera.scale < 1.2) return;

    const stripe = 1.6 * PX_PER_M;

    ctx.save();
    ctx.lineWidth = kerbWidth;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    const trace = (points: Vec2[]) => {
      ctx.beginPath();
      ctx.moveTo(points[0].x * PX_PER_M, points[0].y * PX_PER_M);
      for (let k = 1; k < points.length; k++) ctx.lineTo(points[k].x * PX_PER_M, points[k].y * PX_PER_M);
    };

    for (const run of runs) {
      for (const side of [run.left, run.right]) {
        if (side.length < 2) continue;
        // Two passes with complementary dash offsets give the alternating red/white banding.
        ctx.setLineDash([stripe, stripe]);
        ctx.lineDashOffset = 0;
        ctx.strokeStyle = this.colors.curbA;
        trace(side);
        ctx.stroke();

        ctx.lineDashOffset = -stripe;
        ctx.strokeStyle = this.colors.curbB;
        trace(side);
        ctx.stroke();
      }
    }

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
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

  /** Any track exists, however it was built — drives the canvas placeholder hints. */
  get hasTrack(): boolean {
    return !!this.track && this.track.points.length > 1;
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
    const hadTrack = !!this.track;
    const curve = fit && this.controlPoints.length > 2
      ? splineThroughPoints(this.controlPoints, this.closedLoop, 10)
      : this.controlPoints;
    this.applyTrackPoints(
      curve,
      this.currentTrackLabel,
      this.closedLoop,
      this.track?.source === 'traced' ? 'traced' : 'drawn',
      !hadTrack
    );
  }

  setDrawTool(tool: 'draw' | 'edit') {
    this.drawTool = tool;
  }

  get canUndoDrawing(): boolean {
    return this.pointHistory.length > 0;
  }

  /** Call immediately before any change to controlPoints. */
  private pushHistory() {
    this.pointHistory.push(this.controlPoints.map(p => ({ ...p })));
    if (this.pointHistory.length > TrackViewComponent.MAX_HISTORY) this.pointHistory.shift();
  }

  undoDrawing() {
    const previous = this.pointHistory.pop();
    if (!previous) return;
    this.controlPoints = previous;
    if (this.controlPoints.length < 2) {
      this.track = null;
      this.racingLine = [];
      this.clearComparisonState();
      this.requestRedraw();
      return;
    }
    this.rebuildFromControlPoints();
  }

  /** True while the user is typing, so driving keys never steal a keystroke from a field. */
  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable;
  }

  private static readonly DRIVING_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
  ]);

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (this.isTypingTarget(event.target)) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      if (!this.isFreeform || !this.canUndoDrawing) return;
      event.preventDefault();
      this.undoDrawing();
      return;
    }

    if (!this.driveMode || event.ctrlKey || event.metaKey || event.altKey) return;

    if (TrackViewComponent.DRIVING_KEYS.has(event.code)) {
      // Arrows scroll the page and space activates the focused button; neither is wanted
      // while driving.
      event.preventDefault();
      this.heldKeys.add(event.code);
      return;
    }

    if (event.code === 'KeyR') {
      event.preventDefault();
      this.resetRun();
    }
  }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(event: KeyboardEvent) {
    this.heldKeys.delete(event.code);
  }

  /**
   * A key held while the window loses focus never fires keyup, so the car would drive away on
   * its own the moment attention moved elsewhere.
   */
  @HostListener('window:blur')
  onWindowBlur() {
    this.heldKeys.clear();
  }

  toggleClosedLoop() {
    this.closedLoop = !this.closedLoop;
    this.rebuildFromControlPoints();
  }

  clearDrawing() {
    if (this.controlPoints.length) this.pushHistory();
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
        this.pushHistory();
        this.controlPoints.splice(hit, 1);
        this.rebuildFromControlPoints();
      } else {
        this.pushHistory();
        this.draggingPointIndex = hit;
      }
      return true;
    }

    // In Edit the canvas never gains geometry; let the press fall through to panning instead.
    if (this.drawTool === 'edit') return false;

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

    // Ignore anything shorter than a deliberate mark, so a twitch during a click doesn't
    // silently append a stub to the track.
    const MIN_STROKE_M = 4;
    if (this.strokePoints.length < 3 || pathLength(this.strokePoints) < MIN_STROKE_M) {
      // A click rather than a stroke: append a single control point.
      if (this.strokePoints.length >= 1) {
        this.pushHistory();
        this.controlPoints.push(this.strokePoints[0]);
        this.rebuildFromControlPoints();
      }
      this.strokePoints = [];
      return true;
    }

    this.pushHistory();
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
      this.applyTrackPoints(result.points, this.currentTrackLabel, result.closed, 'traced', true);
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
    this.aiDrivingService.setTrainingSpeed(this.speedSteps[this.speedIndex].value);
    this.aiDrivingService.clearHistory();

    if (!this.track) return;
    const result = await this.aiDrivingService.train(
      this.settingsService.getSettings(),
      this.track,
      { ...this.aiConfig, seedWeights: this.seedModel?.weights ?? null, objective: this.objective },
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

  /**
   * Switches what the AI is being trained for.
   *
   * Drift is only meaningful on a rear-driven car with a diff that will actually light up both
   * wheels, so selecting it forces RWD + LSD and locks the pickers. The previous drivetrain is
   * restored on the way back to grip, so the choice is borrowed rather than overwritten.
   */
  setObjective(objective: TrainingObjective) {
    if (this.objective === objective) return;
    this.objective = objective;

    const current = this.settingsService.getSettings();
    if (objective === 'drift') {
      if (!this.preDriftDrivetrain) {
        this.preDriftDrivetrain = {
          drivetrain: current.drivetrain,
          differential: current.differential,
          steeringLockDeg: current.steeringLockDeg,
        };
      }
      // Plus drift knuckles. With a road car's 26 degrees of lock a slide past about 30 degrees
      // cannot be caught by any input — the car spins every time — so holding or transitioning a
      // drift was not merely hard to learn, it was impossible.
      this.settingsService.updateSettings({ drivetrain: 'rwd', differential: 'lsd', steeringLockDeg: 60 });
    } else if (this.preDriftDrivetrain) {
      this.settingsService.updateSettings({ ...this.preDriftDrivetrain });
      this.preDriftDrivetrain = null;
    }

    if (objective === 'drift') {
      this.aiConfig.generations = Math.max(
        this.aiConfig.generations,
        TrackViewComponent.SUGGESTED_DRIFT_GENERATIONS
      );
    }

    if (this.playerCar) this.playerCar.objective = objective;
    if (this.driveMode) this.resetRun();
    this.requestRedraw();
  }

  get speedLabel(): string {
    return this.speedSteps[this.speedIndex]?.label ?? 'Max';
  }

  get isRealTimeSpeed(): boolean {
    return Number.isFinite(this.speedSteps[this.speedIndex]?.value);
  }

  setSpeedIndex(index: number) {
    this.speedIndex = Math.max(0, Math.min(this.speedSteps.length - 1, Math.round(Number(index) || 0)));
    this.aiDrivingService.setTrainingSpeed(this.speedSteps[this.speedIndex].value);
  }

  get objectiveBlurb(): string {
    return this.objectives.find(o => o.value === this.objective)?.blurb ?? '';
  }

  get isDrift(): boolean {
    return this.objective === 'drift';
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
      // A drift model must be replayed under the objective it was trained for, or its result
      // is scored as a lap it was never trying to drive.
      const result = await this.aiDrivingService.runGenomeOnTrack(
        model.weights, model.carSettings, this.track!, model.objective ?? 'grip'
      );
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
    const elapsed = Math.min(0.25, Math.max(0, (timestamp - this.lastTime) / 1000));
    this.lastTime = timestamp;

    if (this.driveMode) this.stepPlayer(elapsed);

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

  // ---------- Drive mode ----------

  /**
   * Runs the car forward in fixed 1/30 s steps, consuming however much real time has passed.
   *
   * A variable timestep would make the physics — and therefore the lap time — depend on frame
   * rate, so a faster machine would set faster laps. The catch-up is capped so a backgrounded
   * tab resumes rather than simulating a hundred steps in one frame.
   */
  private stepPlayer(elapsed: number) {
    const car = this.playerCar;
    if (!car || !this.hasTrack) return;

    // Editing the track, changing its width or loading a preset builds a new model. Without
    // this the car would keep driving the old geometry — running through walls that moved and
    // being retired by edges that no longer exist.
    if (car.boundTrack !== this.track) {
      this.resetRun();
      return;
    }

    const dt = TrackViewComponent.PLAYER_DT;
    this.physicsAccumulator = Math.min(this.physicsAccumulator + elapsed, dt * TrackViewComponent.MAX_CATCHUP_STEPS);

    const input = this.currentDriverInput();
    let stepped = 0;
    while (this.physicsAccumulator >= dt) {
      this.physicsAccumulator -= dt;
      stepped++;
      if (car.update(dt, input)) {
        this.onRunEnded();
        break;
      }
    }

    if (stepped === 0) return;
    this.playerTelemetry = car.telemetry();
    if (this.followCam) this.centerCameraOn(car.state.x, car.state.y);
    this.requestRedraw();
  }

  /** Keyboard mapped to control targets. An analog device would set these values directly. */
  private currentDriverInput(): DriverInput {
    const held = (...codes: string[]) => codes.some(c => this.heldKeys.has(c));
    const left = held('ArrowLeft', 'KeyA');
    const right = held('ArrowRight', 'KeyD');
    return {
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      throttle: held('ArrowUp', 'KeyW') ? 1 : 0,
      brake: held('ArrowDown', 'KeyS', 'Space') ? 1 : 0,
    };
  }

  private onRunEnded() {
    const car = this.playerCar;
    if (!car) return;

    this.playerTelemetry = car.telemetry();

    const telemetry = car.telemetry();
    if (this.objective === 'drift') {
      this.playerBestDrift = Math.max(this.playerBestDrift, telemetry.driftScore);
    }

    if (car.status === 'finished') {
      const record: LapRecord = { time: car.lapTime, valid: true, driftScore: telemetry.driftScore };
      this.lastLap = record;
      this.lapHistory = [record, ...this.lapHistory].slice(0, 12);
      if (!this.playerBestLap || car.lapTime < this.playerBestLap) {
        this.playerBestLap = car.lapTime;
        this.playerBestLine = car.trail.map(p => ({ ...p }));
      }
    } else {
      const note = car.telemetry().beyondEdge > 1
        ? 'Off track — run ended'
        : 'Too long off track — run ended';
      this.lastLap = { time: car.lapTime, valid: false, note };
    }
    this.requestRedraw();
  }

  toggleDriveMode() {
    this.setDriveMode(!this.driveMode);
  }

  setDriveMode(on: boolean) {
    this.driveMode = on;
    this.heldKeys.clear();
    this.physicsAccumulator = 0;

    if (on) {
      this.activeTab = 'drive';
      this.resetRun();
    } else {
      this.playerTelemetry = null;
    }
    this.requestRedraw();
  }

  /** Puts the car back on the start line, ready for another attempt. */
  resetRun() {
    if (!this.playerCar || !this.track) return;
    this.playerCar.reset(this.track);
    this.playerTelemetry = this.playerCar.telemetry();
    this.physicsAccumulator = 0;
    if (this.followCam) this.centerCameraOn(this.playerCar.state.x, this.playerCar.state.y);
    this.requestRedraw();
  }

  clearLapHistory() {
    this.lapHistory = [];
    this.lastLap = null;
    this.playerBestLap = 0;
    this.playerBestLine = [];
    this.requestRedraw();
  }

  toggleFollowCam() {
    this.followCam = !this.followCam;
    if (this.followCam && this.playerCar) {
      this.centerCameraOn(this.playerCar.state.x, this.playerCar.state.y);
    }
    this.requestRedraw();
  }

  get steeringAid(): boolean {
    return this.playerCar?.steeringAid ?? true;
  }

  toggleSteeringAid() {
    if (this.playerCar) this.playerCar.steeringAid = !this.playerCar.steeringAid;
    this.requestRedraw();
  }

  toggleShowPlayerLine() {
    this.showPlayerLine = !this.showPlayerLine;
    this.requestRedraw();
  }

  private centerCameraOn(worldX: number, worldY: number) {
    const left = this.viewInsetLeft;
    const top = TrackViewComponent.STRIP_H;
    const usableW = Math.max(120, this.viewWidth - left);
    const usableH = Math.max(120, this.viewHeight - top - this.viewInsetBottom);
    this.camera.offsetX = left + usableW / 2 - worldX * PX_PER_M * this.camera.scale;
    this.camera.offsetY = top + usableH / 2 - worldY * PX_PER_M * this.camera.scale;
  }

  /** The lap the driver is chasing: the AI's best if it has set one, else the reference lap. */
  get aiBestLap(): number {
    return this.aiStats.bestLapTime > 0 ? this.aiStats.bestLapTime : 0;
  }

  // ---------- Template getters ----------
  get segmentCount(): number { return Math.max(0, this.segments.length - 1); }
  get isTraining(): boolean { return this.aiStats.active; }
  get trainingLabel(): string { return this.isTraining ? 'Training AI...' : 'Train AI'; }
  get activeCarModel(): string { return this.settingsService.getSettings().name; }

  /**
   * The circuit's own length. Read off the track model, not the displayed line: after a run the
   * line on screen is the champion's trajectory, which ends wherever that car did, and the
   * strip's TRACK figure was quietly shrinking to match.
   */
  get trackLength(): string {
    if (!this.track || this.track.points.length < 2) return '0 m';
    return `${getTrackLength(this.track.points).toFixed(0)} m`;
  }
}
