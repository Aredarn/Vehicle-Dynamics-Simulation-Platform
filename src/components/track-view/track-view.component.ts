import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { RacingLineOptimizerService } from '../../services/racing-line-optimizer.service';
import { AIDrivingService, AIGenerationStats } from '../../services/ai-driving.service';
import { Car } from '../../models/Car';
import { CarAgent } from '../../models/CarAgent';
import { PieceType, Segment } from '../../models/Track';
import { CarState, RacingLinePoint } from '../../interfaces/car-state';

const roadWidth = 30;
const PX_PER_M = 3;

interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

@Component({
  selector: 'app-track-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './track-view.component.html',
  styleUrls: ['./track-view.component.scss']
})
export class TrackViewComponent implements AfterViewInit, OnDestroy {
  private settingsSub!: Subscription;
  private aiStatsSub!: Subscription;
  private aiAgentsSub!: Subscription;
  private car!: Car;
  private carColor: [string, string] = ['#3b82f6', '#60a5fa'];
  private trainingAgents: CarAgent[] = [];
  aiStats: AIGenerationStats = {
    generation: 0,
    bestFitness: 0,
    bestLapTime: 0,
    aliveCount: 0,
    averageFitness: 0,
    active: false,
  };
  aiConfig = {
    populationSize: 20,
    generations: 25,
    mutationRate: 0.2,
  };

  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  constructor(
    private settingsService: CarSettingsService,
    private lineOptimizer: RacingLineOptimizerService,
    private aiDrivingService: AIDrivingService,
  ) {}

  palette = [
    { label: 'Start', type: 'start' as PieceType, length: 50, icon: '🏁', meta: 'Launch zone' },
    { label: 'Short Straight', type: 'straight' as PieceType, length: 20, icon: '⬛', meta: '20 m' },
    { label: 'Medium Straight', type: 'straight' as PieceType, length: 50, icon: '⬛', meta: '50 m' },
    { label: 'Long Straight', type: 'straight' as PieceType, length: 100, icon: '⬛', meta: '100 m' },
    { label: 'Fast Sweep', type: 'curve30' as PieceType, radius: 80, angle: 30, icon: '↺', meta: '30°' },
    { label: 'Medium Corner', type: 'curve45' as PieceType, radius: 70, angle: 45, icon: '↺', meta: '45°' },
    { label: 'Technical Corner', type: 'curve60' as PieceType, radius: 65, angle: 60, icon: '↻', meta: '60°' },
    { label: 'Hairpin', type: 'curve90' as PieceType, radius: 55, angle: 90, icon: '↻', meta: '90°' },
    { label: 'Chicane', type: 'curve120' as PieceType, radius: 60, angle: 120, icon: '⤴', meta: '120°' },
  ];

  trackPresets = [
    { key: 'monaco', label: 'Monaco GP', description: 'Street circuit with tight braking zones and slow corners' },
    { key: 'silverstone', label: 'Silverstone GP', description: 'High-speed mix of straights and fast flowing corners' },
    { key: 'monza', label: 'Monza GP', description: 'Long straights and heavy braking for a classic F1 layout' },
  ];

  private lastTime = 0;
  private isSimulating = false;
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

  ngAfterViewInit(): void {
    const ctx = this.canvasRef.nativeElement.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.car = new Car(this.settingsService.getSettings());
    this.carColor = this.settingsService.getActivePresetColor();
    this.fitTrackToView();
    this.drawAll();

    this.settingsSub = this.settingsService.settings$.subscribe(settings => {
      this.car.updateSpecs(settings);
      this.carColor = this.settingsService.getActivePresetColor();
      this.updateRacingLine();
      this.drawAll();
    });

    this.aiStatsSub = this.aiDrivingService.stats$.subscribe(stats => {
      this.aiStats = stats;
      this.drawAll();
    });

    this.aiAgentsSub = this.aiDrivingService.agents$.subscribe(agents => {
      this.trainingAgents = agents;
      this.drawAll();
    });

    this.lastTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  ngOnDestroy() {
    this.settingsSub?.unsubscribe();
    this.aiStatsSub?.unsubscribe();
    this.aiAgentsSub?.unsubscribe();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
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
    this.drawAll();
  }

  zoomIn() {
    const canvas = this.canvasRef.nativeElement;
    this.zoomAt(canvas.width / 2, canvas.height / 2, 1.25);
  }

  zoomOut() {
    const canvas = this.canvasRef.nativeElement;
    this.zoomAt(canvas.width / 2, canvas.height / 2, 0.8);
  }

  resetZoom() {
    this.camera = { scale: 1, offsetX: 0, offsetY: 0 };
    this.zoomLevel = 100;
    this.drawAll();
  }

  fitTrackToView() {
    const canvas = this.canvasRef.nativeElement;
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

    const scaleX = (canvas.width - padding * 2) / Math.max(bboxWidthPx, 100);
    const scaleY = (canvas.height - padding * 2) / Math.max(bboxHeightPx, 100);
    const scale = Math.min(scaleX, scaleY, 2);

    const centerX = (bbox.minX + bbox.maxX) / 2 * PX_PER_M;
    const centerY = (bbox.minY + bbox.maxY) / 2 * PX_PER_M;

    this.camera.scale = scale;
    this.camera.offsetX = canvas.width / 2 - centerX * scale;
    this.camera.offsetY = canvas.height / 2 - centerY * scale;
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
    this.drawAll();
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
    this.isSimulating = false;
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
    if (this.isSimulating) this.car.invalidateRacingLine();
    this.drawAll();
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
    this.drawAll();
  }

  toggleOptimizedLine() {
    this.useOptimizedLine = !this.useOptimizedLine;
    this.updateRacingLine();
    this.drawAll();
  }

  // ---------- Drawing ----------
  private drawAll() {
    const ctx = this.ctx;
    const canvas = this.canvasRef.nativeElement;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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

    if (this.isSimulating || this.car?.state.speed > 0) {
      this.drawCar(this.car.state);
    }

    ctx.restore();
  }

  private drawRacingLine() {
    if (this.racingLine.length < 2 || !this.showRacingLine) return;

    const ctx = this.ctx;
    const lineColor = this.useOptimizedLine ? '#22c55e' : '#00ff00';

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
      ctx.fillStyle = alive ? '#facc15' : '#ef4444';
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
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.width / this.camera.scale;
    const h = canvas.height / this.camera.scale;
    const ox = -this.camera.offsetX / this.camera.scale;
    const oy = -this.camera.offsetY / this.camera.scale;

    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1 / this.camera.scale;

    const startX = Math.floor(ox / step) * step;
    const startY = Math.floor(oy / step) * step;

    for (let x = startX; x < ox + w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, oy);
      ctx.lineTo(x, oy + h);
      ctx.stroke();
    }
    for (let y = startY; y < oy + h; y += step) {
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

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, -roadWidth / 2, startLength, roadWidth);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, -roadWidth / 2, startLength, 2);
    ctx.fillRect(0, roadWidth / 2 - 2, startLength, 2);

    const checkSize = 8;
    for (let i = 0; i < Math.ceil(roadWidth / (checkSize * 2)); i++) {
      for (let j = 0; j < Math.ceil(startLength / checkSize); j++) {
        if ((i + j) % 2 === 0) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(j * checkSize, -roadWidth / 2 + i * checkSize * 2, checkSize, checkSize);
        }
      }
    }

    ctx.fillStyle = '#fffbeb';
    ctx.font = `bold ${14 / this.camera.scale}px Inter, Arial`;
    ctx.textAlign = 'center';
    ctx.fillText('START', startLength / 2, 0);

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3 / this.camera.scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(25, 0);
    ctx.stroke();
    ctx.restore();
  }

  private drawStraight(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const L = (seg.length ?? 0) * PX_PER_M;

    ctx.save();
    ctx.translate(seg.position.x * PX_PER_M, seg.position.y * PX_PER_M);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    const roadGradient = ctx.createLinearGradient(0, -roadWidth / 2, L, roadWidth / 2);
    roadGradient.addColorStop(0, ghost ? '#4b5563' : '#1f2937');
    roadGradient.addColorStop(1, ghost ? '#6b7280' : '#374151');
    ctx.fillStyle = roadGradient;
    ctx.fillRect(0, -roadWidth / 2, L, roadWidth);

    ctx.strokeStyle = ghost ? '#9ca3af' : '#f8fafc';
    ctx.lineWidth = 2 / this.camera.scale;
    ctx.strokeRect(0, -roadWidth / 2, L, roadWidth);

    ctx.strokeStyle = ghost ? '#cbd5e1' : '#fef3c7';
    ctx.lineWidth = 1.2 / this.camera.scale;
    ctx.setLineDash([16, 10]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = ghost ? '#94a3b8' : '#f8fafc';
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.beginPath();
    ctx.moveTo(0, -roadWidth / 2 + 3);
    ctx.lineTo(L, -roadWidth / 2 + 3);
    ctx.moveTo(0, roadWidth / 2 - 3);
    ctx.lineTo(L, roadWidth / 2 - 3);
    ctx.stroke();
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
    const roadGradient = ctx.createRadialGradient(cx, cy, R - roadWidth / 2, cx, cy, R + roadWidth / 2);
    roadGradient.addColorStop(0, ghost ? '#4b5563' : '#374151');
    roadGradient.addColorStop(1, ghost ? '#6b7280' : '#111827');
    ctx.fillStyle = roadGradient;
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.arc(cx, cy, R - roadWidth / 2, endAngle, startAngle, angleRad >= 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = ghost ? '#cbd5e1' : '#f8fafc';
    ctx.lineWidth = 2 / this.camera.scale;
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.stroke();

    ctx.strokeStyle = ghost ? '#94a3b8' : '#fef3c7';
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, startAngle, endAngle, angleRad < 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawCar(state: CarState) {
    const ctx = this.ctx;
    const carLength = 30;
    const carWidth = 15;
    const [colorStart, colorEnd] = this.carColor;

    ctx.save();
    ctx.translate(state.position.x * PX_PER_M, state.position.y * PX_PER_M);
    ctx.rotate(state.heading);

    const gradient = ctx.createLinearGradient(-carLength / 2, 0, carLength / 2, 0);
    gradient.addColorStop(0, colorStart);
    gradient.addColorStop(1, colorEnd);

    ctx.fillStyle = gradient;
    ctx.fillRect(-carLength / 2, -carWidth / 2, carLength, carWidth);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2 / this.camera.scale;
    ctx.strokeRect(-carLength / 2, -carWidth / 2, carLength, carWidth);

    ctx.fillStyle = '#a0e7ff';
    ctx.fillRect(carLength / 4, -carWidth / 2 + 2, carLength / 4, carWidth - 4);
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(carLength / 2 - 4, -2, 4, 4);
    ctx.restore();

    if (state.speed > 0.1) {
      ctx.save();
      ctx.fillStyle = '#f0f4f8';
      ctx.font = `bold ${12 / this.camera.scale}px Inter, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText(
        `${(state.speed * 3.6).toFixed(0)} km/h`,
        state.position.x * PX_PER_M,
        state.position.y * PX_PER_M - 25 / this.camera.scale
      );
      ctx.restore();
    }
  }

  // ---------- Simulation Control ----------
  async startSimulation() {
    if (this.segments.length < 2 || this.segments[0].type !== 'start') {
      alert('You need a Start piece and at least one track segment.');
      return;
    }

    this.updateRacingLine();
    if (this.racingLine.length < 2) {
      alert('Cannot compute racing line. Please check your track layout.');
      return;
    }

    this.car.invalidateRacingLine();
    this.car.setOptimizedRacingLine(this.racingLine);
    this.car.state.position = { x: this.racingLine[0].x, y: this.racingLine[0].y };
    this.car.state.heading = this.racingLine[0].heading;
    this.car.state.speed = 5;
    this.car.state.s = 0;
    this.car.state.racingLineIndex = 0;

    this.lastTime = performance.now();
    this.isSimulating = true;
  }

  async startAITraining() {
    if (this.segments.length < 2 || this.segments[0].type !== 'start') {
      alert('You need a Start piece and at least one track segment.');
      return;
    }

    this.trainingAgents = [];
    this.aiStats = { ...this.aiStats, active: true };
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
    this.drawAll();
  }

  stopAITraining() {
    this.aiDrivingService.stopTraining();
  }

  stopSimulation() { this.isSimulating = false; }

  resetSimulation() {
    this.isSimulating = false;
    if (this.racingLine.length > 0) {
      this.car.state.position = { x: this.racingLine[0].x, y: this.racingLine[0].y };
      this.car.state.heading = this.racingLine[0].heading;
      this.car.state.speed = 0;
      this.car.state.s = 0;
      this.car.state.racingLineIndex = 0;
    }
    this.drawAll();
  }

  clearTrack() {
    this.segments = [];
    this.racingLine = [];
    this.estimatedLapTime = 0;
    this.isSimulating = false;
    this.car.resetCar();
    this.drawAll();
  }

  setTurnDirection(turnRight: boolean) {
    this.previewTurnRight = turnRight;
    this.drawAll();
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

  private animate(timestamp: number) {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.033);
    this.lastTime = timestamp;

    if (this.isSimulating && this.segments.length > 0 && this.racingLine.length > 1) {
      try {
        this.car.update(dt, this.segments);
      } catch {
        this.car.state.racingLineIndex = 0;
      }
    }

    this.drawAll();
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  // ---------- Template getters ----------
  get isSimulatingRunning(): boolean { return this.isSimulating; }
  get currentTurnDirection(): string { return this.previewTurnRight ? 'Right' : 'Left'; }
  get carSpeed(): string { return this.car ? `${(this.car.state.speed * 3.6).toFixed(1)} km/h` : '0 km/h'; }
  get carName(): string { return this.settingsService.getSettings().name; }
  get segmentCount(): number { return Math.max(0, this.segments.length - 1); }
  get isTraining(): boolean { return this.aiStats.active; }
  get trainingLabel(): string { return this.isTraining ? 'Training AI...' : 'Train AI'; }

  get trackLength(): string {
    if (this.racingLine.length < 2) return '0 m';
    const total = this.racingLine[this.racingLine.length - 1].s;
    return `${total.toFixed(0)} m`;
  }

  get lapTimeEstimate(): string {
    if (this.estimatedLapTime <= 0) return '—';
    const mins = Math.floor(this.estimatedLapTime / 60);
    const secs = (this.estimatedLapTime % 60).toFixed(1);
    return mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : `${secs}s`;
  }
}
