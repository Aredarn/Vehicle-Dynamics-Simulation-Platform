import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { PlayerTelemetry } from '../../models/PlayerCar';
import {
  driftAngleQuality,
  DRIFT_MIN_ANGLE_DEG,
  DRIFT_IDEAL_ANGLE_DEG,
  DRIFT_MAX_ANGLE_DEG,
} from '../../utils/drift-scoring';

/** One completed or abandoned attempt, kept so the driver can see whether they are improving. */
export interface LapRecord {
  time: number;
  valid: boolean;
  /** Points banked on this run when driving for the drift objective. */
  driftScore?: number;
  /** Why the run ended, when it wasn't a completed lap. */
  note?: string;
}

/**
 * The driver's instrument panel: a speedometer plus the readouts that actually explain what the
 * car is doing — the friction circle, weight transfer, and where the tyres are being spent.
 *
 * Every value shown is measured from the same physics step the car is integrated with. Nothing
 * here is decorative telemetry invented to fill a gauge.
 */
@Component({
  selector: 'app-driver-hud',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './driver-hud.component.html',
  styleUrl: './driver-hud.component.scss',
})
export class DriverHudComponent {
  @Input({ required: true }) telemetry!: PlayerTelemetry;
  /** Best lap the AI has managed on this track, in seconds. 0 when it hasn't set one. */
  @Input() aiBestLap = 0;
  /** The optimizer's reference lap for this car and track, in seconds. 0 when unavailable. */
  @Input() referenceLap = 0;
  @Input() bestLap = 0;
  @Input() lastLap: LapRecord | null = null;
  /** Drift mode swaps the lap-time focus for a score readout. */
  @Input() drift = false;
  /** Best drift score the AI has reached on this track, 0 when it hasn't trained for it. */
  @Input() aiBestDrift = 0;
  @Input() bestDrift = 0;

  /** Speedo sweep: 225° of arc, starting bottom-left. */
  private readonly ARC_START = 135;
  private readonly ARC_SWEEP = 270;
  readonly dialRadius = 52;

  /** Lap completion as a clamped 0..1 fraction, for the bar to scale by. */
  get lapProgress(): number {
    return Math.min(1, Math.max(0, this.telemetry.progressRatio));
  }

  get speedAngle(): number {
    return this.ARC_START + this.ARC_SWEEP * this.clamp01(this.telemetry.speedRatio);
  }

  /** Ticks every 10% of the car's own top speed, so the dial is scaled to this car. */
  get ticks(): Array<{ angle: number; major: boolean; label: string | null }> {
    const out: Array<{ angle: number; major: boolean; label: string | null }> = [];
    const top = this.telemetry.topSpeedKmh;
    for (let i = 0; i <= 10; i++) {
      const frac = i / 10;
      out.push({
        angle: this.ARC_START + this.ARC_SWEEP * frac,
        major: i % 2 === 0,
        label: i % 2 === 0 ? Math.round(top * frac).toString() : null,
      });
    }
    return out;
  }

  /** Arc path for the coloured portion of the dial, from zero to the current speed. */
  get speedArc(): string {
    return this.arcPath(this.ARC_START, this.speedAngle, this.dialRadius);
  }

  get trackArc(): string {
    return this.arcPath(this.ARC_START, this.ARC_START + this.ARC_SWEEP, this.dialRadius);
  }

  tickOuter(angle: number): { x: number; y: number } {
    return this.polar(angle, this.dialRadius - 3);
  }

  tickInner(angle: number, major: boolean): { x: number; y: number } {
    return this.polar(angle, this.dialRadius - (major ? 12 : 8));
  }

  labelPoint(angle: number): { x: number; y: number } {
    return this.polar(angle, this.dialRadius - 22);
  }

  get needleTip(): { x: number; y: number } {
    return this.polar(this.speedAngle, this.dialRadius - 14);
  }

  get needleTail(): { x: number; y: number } {
    return this.polar(this.speedAngle + 180, 9);
  }

  /**
   * Position on the g-g diagram. Lateral g has no sign in the step result (it is a magnitude),
   * so it is signed here by which way the car is actually yawing.
   */
  get gDot(): { x: number; y: number } {
    const scale = 22; // px per g
    const lateralSign = this.telemetry.yawRate >= 0 ? 1 : -1;
    return {
      x: this.clamp(this.telemetry.lateralG * lateralSign * scale, -34, 34),
      // Braking is negative longitudinal g and belongs at the bottom of the plot.
      y: this.clamp(-this.telemetry.longitudinalG * scale, -34, 34),
    };
  }

  /** Body slip drawn either side of centre, saturating at 30 degrees of slide. */
  get slipBar(): { left: number; width: number } {
    const frac = this.clamp(this.telemetry.bodySlipDeg / 30, -1, 1);
    const half = Math.abs(frac) * 50;
    return { left: frac < 0 ? 50 - half : 50, width: half };
  }

  /** How close the current angle is to the ideal drift angle, 0..1 — the scoring curve itself. */
  get driftQuality(): number {
    return driftAngleQuality(this.telemetry.bodySlipDeg);
  }

  get driftAngleLabel(): string {
    const a = Math.abs(this.telemetry.bodySlipDeg);
    if (a < DRIFT_MIN_ANGLE_DEG) return 'too straight';
    if (a >= DRIFT_MAX_ANGLE_DEG) return 'spinning';
    if (a > DRIFT_IDEAL_ANGLE_DEG) return 'past ideal';
    return 'scoring';
  }

  /** 0 = straight, 1 = fully sideways. Drives the slide warning colour. */
  get slideSeverity(): number {
    return this.clamp(Math.abs(this.telemetry.bodySlipDeg) / 30, 0, 1);
  }

  get gLimitRadius(): number {
    return this.clamp(this.telemetry.maxLateralAccelG * 22, 10, 34);
  }

  /** Delta to the best reference available, in seconds. Positive means the driver is slower. */
  get deltaToBeat(): number | null {
    const target = this.targetLap;
    if (!target || !this.bestLap) return null;
    return this.bestLap - target;
  }

  /** The AI's lap when it has set one, otherwise the optimizer's reference. */
  get targetLap(): number {
    return this.aiBestLap > 0 ? this.aiBestLap : this.referenceLap;
  }

  get targetLabel(): string {
    return this.aiBestLap > 0 ? 'AI best' : 'Reference';
  }

  get statusLabel(): string {
    switch (this.telemetry.status) {
      case 'ready': return 'Ready — throttle to start';
      case 'running': return this.telemetry.onTrack ? 'On track' : 'OFF TRACK';
      case 'finished': return 'Lap complete';
      case 'retired': return 'Run ended';
    }
  }

  formatTime(seconds: number): string {
    if (!seconds || !Number.isFinite(seconds)) return '--.---';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return m > 0
      ? `${m}:${s.toFixed(3).padStart(6, '0')}`
      : s.toFixed(3);
  }

  formatDelta(delta: number): string {
    const sign = delta >= 0 ? '+' : '-';
    return `${sign}${Math.abs(delta).toFixed(3)}`;
  }

  private arcPath(fromDeg: number, toDeg: number, r: number): string {
    const start = this.polar(fromDeg, r);
    const end = this.polar(toDeg, r);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  private polar(deg: number, r: number): { x: number; y: number } {
    const rad = (deg * Math.PI) / 180;
    return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  private clamp01(v: number): number {
    return this.clamp(v, 0, 1);
  }
}
