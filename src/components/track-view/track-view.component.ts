import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { CarSettings, CarSettingsService } from '../../services/car-settings.service';
import { Car } from '../../models/Car';
import { PieceType, Segment } from '../../models/Track';
import { CarState } from '../../interfaces/car-state';

const roadWidth = 35;     // px
const PX_PER_M = 10;      // 1m = 10px

@Component({
  selector: 'app-track-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './track-view.component.html',
  styleUrls: ['./track-view.component.scss']
})
export class TrackViewComponent implements AfterViewInit, OnDestroy {
  private settingsSub!: Subscription;
  private car!: Car;

  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  constructor(private settingsService: CarSettingsService) { }

  // palette pieces (all in px, will be converted to meters)
  palette = [
    { label: 'Start', type: 'start' as PieceType, length: 40 },
    { label: 'Straight 50', type: 'straight' as PieceType, length: 50 },
    { label: 'Straight 100', type: 'straight' as PieceType, length: 100 },
    { label: 'Curve 45°', type: 'curve45' as PieceType, radius: 60, angle: 45 },
    { label: 'Curve 90°', type: 'curve90' as PieceType, radius: 60, angle: 90 },
    { label: 'Curve 180°', type: 'curve180' as PieceType, radius: 60, angle: 180 },
  ];

  private lastTime = 0;
  private isSimulating = false;
  private animationFrameId: number | null = null;

  segments: Segment[] = [];
  private dragPreview: any = null;
  private previewTurnRight = false;
  private ctx!: CanvasRenderingContext2D;
  private racingLine: { x: number, y: number, heading: number }[] = [];
  showRacingLine = true;

  // Default car settings in case service doesn't provide them
  private defaultCarSettings: CarSettings = {
    mass: 1000,
    enginePower: 450, // Increased power for better acceleration
    dragCoeff: 0.3,
    frontalArea: 2.0,
    tireGrip: 1.8, // Increased grip for better cornering
    downforce: 800, // Increased downforce
    finalDrive: 3.8,
    wheelbase: 2.5 // meters
  };

  ngAfterViewInit(): void {
    const ctx = this.canvasRef.nativeElement.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    // Initialize car with default settings
    this.car = new Car(this.defaultCarSettings);
    this.drawAll();

    // Subscribe to settings changes
    this.settingsSub = this.settingsService.settings$.subscribe(settings => {
      if (!this.car) {
        this.car = new Car(settings);
      } else {
        this.car.updateSpecs(settings);
      }
      this.updateRacingLine();
      this.drawAll();
    });

    this.lastTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  ngOnDestroy() {
    this.settingsSub?.unsubscribe();
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  // ---------- Drag & Drop ----------
  onDragStart(event: DragEvent, piece: any) {
    this.dragPreview = { ...piece };
    event.dataTransfer?.setData('text/plain', piece.type);
  }

  onDragOver(ev: DragEvent) {
    ev.preventDefault();
  }

  onDragEnter(ev: DragEvent) {
    ev.preventDefault();
  }

  onDrop(ev: DragEvent) {
    ev.preventDefault();
    if (!this.dragPreview) return;

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const dropX = (ev.clientX - rect.left) / PX_PER_M;
    const dropY = (ev.clientY - rect.top) / PX_PER_M;

    if (this.dragPreview.type === 'start') {
      const seg: Segment = {
        id: crypto.randomUUID(),
        type: 'start',
        position: { x: dropX, y: dropY },
        heading: 0,
        length: (this.dragPreview.length ?? 40) / PX_PER_M
      };
      this.segments = [seg];
    } else {
      if (this.segments.length === 0 || this.segments[0].type !== 'start') {
        alert('Place a Start piece first.');
        this.dragPreview = null;
        return;
      }
      const last = this.segments[this.segments.length - 1];
      const next = this.buildNextFrom(last, this.dragPreview, this.previewTurnRight);
      this.segments.push(next);
    }

    this.dragPreview = null;
    this.updateRacingLine();
    this.drawAll();
  }

  onDragEnd() {
    this.dragPreview = null;
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

    if (['curve45', 'curve90', 'curve180'].includes(piece.type)) {
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

    // Fallback
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
    let θ = seg.heading;

    if (seg.type === 'start') {
      const L = seg.length ?? 0;
      return {
        x: x0 + L * Math.cos(θ),
        y: y0 + L * Math.sin(θ),
        heading: θ
      };
    }

    if (seg.type === 'straight') {
      const L = seg.length ?? 0;
      return {
        x: x0 + L * Math.cos(θ),
        y: y0 + L * Math.sin(θ),
        heading: θ
      };
    }

    if (['curve45', 'curve90', 'curve180'].includes(seg.type)) {
      const R = seg.radius ?? 6;
      const angleDeg = seg.angle ?? 90;
      const angleRad = angleDeg * Math.PI / 180;
      const turnDirection = Math.sign(angleDeg);

      // Curve center
      const cx = x0 - turnDirection * R * Math.sin(θ);
      const cy = y0 + turnDirection * R * Math.cos(θ);

      // Start angle
      const startAngle = Math.atan2(y0 - cy, x0 - cx);

      // End angle
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
    if (this.car && this.segments.length > 0) {
      try {
        this.racingLine = this.car.computeRacingLine(this.segments);
        console.log('Racing line computed with', this.racingLine.length, 'points');
      } catch (error) {
        console.error('Error computing racing line:', error);
        this.racingLine = this.generateFallbackRacingLine(this.segments);
      }
    } else {
      this.racingLine = [];
    }
  }


  private generateFallbackRacingLine(segments: Segment[]): { x: number, y: number, heading: number }[] {
    const racingLine: { x: number, y: number, heading: number }[] = [];

    console.log('Generating fallback racing line for', segments.length, 'segments');

    for (const seg of segments) {
      const segLength = this.getSegmentLength(seg);
      const steps = Math.max(5, Math.ceil(segLength / 2));

      for (let i = 0; i <= steps; i++) {
        const distance = (i / steps) * segLength;
        const point = this.computeCenterPoint(seg, distance);
        racingLine.push(point);
      }
    }

    return racingLine;
  }



  private getSegmentLength(seg: Segment): number {
    if (seg.type === 'straight' || seg.type === 'start') return seg.length ?? 100;
    if (seg.type.startsWith('curve')) {
      const angleRad = Math.abs((seg.angle ?? 90) * Math.PI / 180);
      return (seg.radius ?? 60) * angleRad;
    }
    return 100;
  }

  private computeCenterPoint(seg: Segment, distance: number): { x: number, y: number, heading: number } {
    if (seg.type === 'straight' || seg.type === 'start') {
      const x = seg.position.x + distance * Math.cos(seg.heading);
      const y = seg.position.y + distance * Math.sin(seg.heading);
      return { x, y, heading: seg.heading };
    }

    if (seg.type.startsWith('curve')) {
      const R = seg.radius ?? 60;
      const angleDeg = seg.angle ?? 90;
      const angleRad = angleDeg * Math.PI / 180;
      const turnDirection = Math.sign(angleDeg);

      const cx = seg.position.x - turnDirection * R * Math.sin(seg.heading);
      const cy = seg.position.y + turnDirection * R * Math.cos(seg.heading);

      const startAngle = Math.atan2(seg.position.y - cy, seg.position.x - cx);
      const arcLength = R * Math.abs(angleRad);
      const arcFraction = distance / Math.max(arcLength, 0.001);

      const endAngle = startAngle + turnDirection * arcFraction * Math.abs(angleRad);

      const x = cx + R * Math.cos(endAngle);
      const y = cy + R * Math.sin(endAngle);
      const heading = seg.heading + turnDirection * arcFraction * Math.abs(angleRad);

      return { x, y, heading };
    }

    return { x: seg.position.x, y: seg.position.y, heading: seg.heading };
  }

  private drawRacingLine() {
        if (this.racingLine.length < 2 || !this.showRacingLine) return;

        const ctx = this.ctx;
        
        // Draw smooth racing line
        ctx.save();
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(this.racingLine[0].x * PX_PER_M, this.racingLine[0].y * PX_PER_M);

        for (let i = 1; i < this.racingLine.length; i++) {
            ctx.lineTo(this.racingLine[i].x * PX_PER_M, this.racingLine[i].y * PX_PER_M);
        }

        ctx.stroke();

        // Draw direction indicators
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        
        for (let i = 0; i < this.racingLine.length; i += 15) {
            if (i >= this.racingLine.length) break;
            
            const point = this.racingLine[i];
            const length = 12;
            ctx.beginPath();
            ctx.moveTo(point.x * PX_PER_M, point.y * PX_PER_M);
            ctx.lineTo(
                point.x * PX_PER_M + Math.cos(point.heading) * length,
                point.y * PX_PER_M + Math.sin(point.heading) * length
            );
            ctx.stroke();
        }
        ctx.setLineDash([]);

        ctx.restore();
    }


  public toggleRacingLine() {
    this.showRacingLine = !this.showRacingLine;
    this.drawAll();
  }

  // ---------- Drawing ----------
  private drawAll() {
    const ctx = this.ctx;
    const canvas = this.canvasRef.nativeElement;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this.drawGrid(40);

    // Draw track segments first
    for (const s of this.segments) {
      this.drawSegment(s);
    }

    // Draw racing line on top of track
    this.drawRacingLine();

    // Draw ghost segment last
    if (this.dragPreview && this.segments.length) {
      const last = this.segments[this.segments.length - 1];
      const next = this.buildNextFrom(last, this.dragPreview, this.previewTurnRight);
      this.drawSegment(next, true);
    }

    // Draw car if simulating
    if (this.isSimulating) {
      this.drawCar(this.car.state);
    }
  }

  private drawGrid(step: number) {
    const ctx = this.ctx;
    const w = this.canvasRef.nativeElement.width;
    const h = this.canvasRef.nativeElement.height;

    ctx.save();
    ctx.strokeStyle = '#f0f3f7';
    ctx.lineWidth = 1;

    // Vertical lines
    for (let x = 0; x <= w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawSegment(seg: Segment, ghost = false) {
    if (seg.type === 'start') return this.drawStart(seg, ghost);
    if (seg.type === 'straight') return this.drawStraight(seg, ghost);
    if (['curve45', 'curve90', 'curve180'].includes(seg.type)) return this.drawCurve(seg, ghost);
  }

  private drawStart(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const startLength = (seg.length ?? 40) * PX_PER_M;

    ctx.save();
    ctx.translate(seg.position.x * PX_PER_M, seg.position.y * PX_PER_M);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    // Draw start line with checkered pattern
    const checkSize = 8; // pixels per check
    const checks = Math.ceil(roadWidth / (checkSize * 2));

    // Draw black base
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, -roadWidth / 2, startLength, roadWidth);

    // Draw checkered pattern
    for (let i = 0; i < checks; i++) {
      for (let j = 0; j < Math.ceil(startLength / checkSize); j++) {
        if ((i + j) % 2 === 0) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(
            j * checkSize,
            -roadWidth / 2 + i * checkSize * 2,
            checkSize,
            checkSize
          );
        }
      }
    }

    // Start text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('START', startLength / 2, 0);

    // Direction indicator
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(25, 0);
    ctx.stroke();

    ctx.restore();
  }

  private drawStraight(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const L = (seg.length ?? 0) * PX_PER_M;
    const x = seg.position.x * PX_PER_M;
    const y = seg.position.y * PX_PER_M;
    const θ = seg.heading;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(θ);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    // Road surface with texture
    ctx.fillStyle = ghost ? '#4b5563' : '#374151';
    ctx.beginPath();
    ctx.rect(0, -roadWidth / 2, L, roadWidth);
    ctx.fill();

    // Road edges
    ctx.strokeStyle = ghost ? '#9ca3af' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -roadWidth / 2);
    ctx.lineTo(L, -roadWidth / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, roadWidth / 2);
    ctx.lineTo(L, roadWidth / 2);
    ctx.stroke();

    // Center line (dashed)
    ctx.strokeStyle = ghost ? '#d1d5db' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([15, 10]);
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
    const angleDeg = seg.angle ?? 90;
    const angleRad = angleDeg * Math.PI / 180;
    const turnDirection = Math.sign(angleDeg);

    const x0 = seg.position.x * PX_PER_M;
    const y0 = seg.position.y * PX_PER_M;
    const θ = seg.heading;

    // Curve center
    const cx = x0 - turnDirection * R * Math.sin(θ);
    const cy = y0 + turnDirection * R * Math.cos(θ);

    const startAngle = Math.atan2(y0 - cy, x0 - cx);
    const endAngle = startAngle + angleRad;

    ctx.save();
    ctx.globalAlpha = ghost ? 0.4 : 1;

    // Road surface
    ctx.fillStyle = ghost ? '#4b5563' : '#374151';
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.arc(cx, cy, R - roadWidth / 2, endAngle, startAngle, angleRad >= 0);
    ctx.closePath();
    ctx.fill();

    // Road edges
    ctx.strokeStyle = ghost ? '#9ca3af' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, R - roadWidth / 2, startAngle, endAngle, angleRad < 0);
    ctx.stroke();

    // Center line (dashed)
    ctx.strokeStyle = ghost ? '#d1d5db' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([15, 10]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, startAngle, endAngle, angleRad < 0);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  // ---------- Car ----------
  private drawCar(state: CarState) {
    const ctx = this.ctx;
    const carLength = 30; // px
    const carWidth = 15; // px

    ctx.save();
    ctx.translate(state.position.x * PX_PER_M, state.position.y * PX_PER_M);
    ctx.rotate(state.heading);

    // Car body with gradient for better appearance
    const gradient = ctx.createLinearGradient(-carLength / 2, 0, carLength / 2, 0);
    gradient.addColorStop(0, '#00a0b0');
    gradient.addColorStop(1, '#00cdd4');

    ctx.fillStyle = gradient;
    ctx.fillRect(-carLength / 2, -carWidth / 2, carLength, carWidth);

    // Car outline
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(-carLength / 2, -carWidth / 2, carLength, carWidth);

    // Windows
    ctx.fillStyle = '#a0e7ff';
    ctx.fillRect(carLength / 4, -carWidth / 2 + 2, carLength / 4, carWidth - 4);

    // Direction indicator (front of car)
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(carLength / 2 - 4, -2, 4, 4);

    ctx.restore();

    // Speed indicator
    if (state.speed > 0.1) {
      ctx.save();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(
        `${(state.speed * 3.6).toFixed(0)} km/h`,
        state.position.x * PX_PER_M,
        state.position.y * PX_PER_M - 25
      );
      ctx.restore();
    }
  }

  // ---------- Simulation Control ----------
  public startSimulation() {
    if (this.segments.length < 2 || this.segments[0].type !== 'start') {
      alert('You need a Start piece and at least one track segment.');
      return;
    }

    this.updateRacingLine();

    if (this.racingLine.length < 2) {
      alert('Cannot compute racing line. Please check your track layout.');
      return;
    }

    // Reset car with proper bounds checking
    this.car.state.position = { ...this.racingLine[0] };
    this.car.state.heading = this.racingLine[0].heading;
    this.car.state.speed = 10;
    this.car.state.racingLineIndex = 0;

    this.lastTime = performance.now();
    this.isSimulating = true;

    console.log('Simulation started. Racing line points:', this.racingLine.length);
  }

  public stopSimulation() {
    this.isSimulating = false;
  }

  public resetSimulation() {
    this.isSimulating = false;
    if (this.racingLine.length > 0) {
      this.car.state.position = { ...this.racingLine[0] };
      this.car.state.heading = this.racingLine[0].heading;
      this.car.state.speed = 0;
      this.car.state.racingLineIndex = 0;
    }
    this.drawAll();
  }

  public clearTrack() {
    this.segments = [];
    this.racingLine = [];
    this.isSimulating = false;
    this.drawAll();
  }

  public toggleTurnDirection() {
    this.previewTurnRight = !this.previewTurnRight;
    this.drawAll();
  }

  // ---------- Animation Loop ----------
  private animate(timestamp: number) {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.033);
    this.lastTime = timestamp;

    this.drawAll();

    if (this.isSimulating && this.segments.length > 0 && this.racingLine.length > 1) {
      try {
        this.car.update(dt, this.segments);

        // Additional safety: if car goes out of bounds, reset it
        if (this.car.state.racingLineIndex < 0 || this.car.state.racingLineIndex >= this.racingLine.length) {
          console.warn('Car out of bounds, resetting to start');
          this.car.state.racingLineIndex = 0;
        }
      } catch (error) {
        console.error('Error updating car:', error);
        // Don't stop simulation, just reset car position
        this.car.state.racingLineIndex = 0;
      }
    }

    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  // ---------- Getters for Template ----------
  get isSimulatingRunning(): boolean {
    return this.isSimulating;
  }

  get currentTurnDirection(): string {
    return this.previewTurnRight ? 'Right' : 'Left';
  }

  get carSpeed(): string {
    return this.car ? `${(this.car.state.speed * 3.6).toFixed(1)} km/h` : '0 km/h';
  }

  get trackLength(): string {
    if (this.racingLine.length < 2) return '0 m';
    let length = 0;
    for (let i = 1; i < this.racingLine.length; i++) {
      const dx = this.racingLine[i].x - this.racingLine[i - 1].x;
      const dy = this.racingLine[i].y - this.racingLine[i - 1].y;
      length += Math.sqrt(dx * dx + dy * dy);
    }
    return `${length.toFixed(0)} m`;
  }
}