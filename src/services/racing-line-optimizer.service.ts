import { Injectable } from '@angular/core';
import { RacingLinePoint } from '../interfaces/car-state';
import { CarSettings } from './car-settings.service';
import { maxLateralAcceleration, maxLongitudinalForce, maxBrakingDeceleration } from '../utils/car-physics';

export interface OptimizedRacingLine {
  points: RacingLinePoint[];
  estimatedLapTime: number;
}

/**
 * Computes a minimum-time speed profile along a discretized racing line.
 * This is the foundation for future AI-based line optimization (lateral offset, ML, etc.).
 */
@Injectable({ providedIn: 'root' })
export class RacingLineOptimizerService {

  optimize(centerline: RacingLinePoint[], settings: CarSettings): OptimizedRacingLine {
    if (centerline.length < 2) {
      return { points: centerline, estimatedLapTime: 0 };
    }

    const racingLine = this.buildRacingLine(centerline);
    const curvatures = this.computeCurvatures(racingLine);
    const maxLatAcc = maxLateralAcceleration(settings);
    const maxBrakeDecel = maxBrakingDeceleration(settings);

    const speedLimits = racingLine.map((_, i) => {
      const kappa = curvatures[i];
      if (kappa < 0.0001) return 120;
      return Math.sqrt(maxLatAcc / kappa);
    });

    const targetSpeeds = [...speedLimits];

    for (let i = 1; i < racingLine.length; i++) {
      const ds = racingLine[i].s - racingLine[i - 1].s;
      if (ds <= 0) continue;
      const vPrev = targetSpeeds[i - 1];
      const maxAccel = Math.max(0, maxLongitudinalForce(settings, Math.max(vPrev, 1), 1) / settings.mass);
      const vFromAccel = Math.sqrt(vPrev * vPrev + 2 * maxAccel * ds);
      targetSpeeds[i] = Math.min(targetSpeeds[i], vFromAccel);
    }

    for (let i = racingLine.length - 2; i >= 0; i--) {
      const ds = racingLine[i + 1].s - racingLine[i].s;
      if (ds <= 0) continue;
      const vNext = targetSpeeds[i + 1];
      const vFromBrake = Math.sqrt(vNext * vNext + 2 * maxBrakeDecel * ds);
      targetSpeeds[i] = Math.min(targetSpeeds[i], vFromBrake);
    }

    const points = racingLine.map((p, i) => ({
      ...p,
      targetSpeed: Math.max(5, targetSpeeds[i]),
    }));

    let lapTime = 0;
    for (let i = 1; i < points.length; i++) {
      const ds = points[i].s - points[i - 1].s;
      const avgSpeed = (points[i - 1].targetSpeed! + points[i].targetSpeed!) / 2;
      if (avgSpeed > 0) lapTime += ds / avgSpeed;
    }

    return { points, estimatedLapTime: lapTime };
  }

  private buildRacingLine(centerline: RacingLinePoint[]): RacingLinePoint[] {
    if (centerline.length < 3) return centerline;

    const points = centerline.map(point => ({ ...point }));
    const curvatures = this.computeCurvatures(centerline);

    for (let i = 1; i < points.length - 1; i++) {
      const curvature = curvatures[i];
      if (curvature < 0.01) continue;

      const start = Math.max(1, i - 6);
      const end = Math.min(points.length - 2, i + 6);
      const span = Math.max(1, end - start + 1);
      const progress = (i - start) / (span - 1);
      const weight = 1 - 2 * Math.abs(progress - 0.5);
      const turnSign = Math.sign(this.normalizeAngle(centerline[i + 1].heading - centerline[i - 1].heading)) || 1;
      const magnitude = Math.min(3.5, Math.max(1.2, curvature * 10));
      const offset = -turnSign * magnitude * Math.max(0, weight);
      const normal = { x: -Math.sin(points[i].heading), y: Math.cos(points[i].heading) };

      points[i] = {
        ...points[i],
        x: points[i].x + normal.x * offset,
        y: points[i].y + normal.y * offset,
      };
    }

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const current = points[i];
      current.s = prev.s + this.distance(prev, current);
    }

    return points;
  }

  private computeCurvatures(points: RacingLinePoint[]): number[] {
    return points.map((_, i) => {
      if (i === 0 || i === points.length - 1) return 0;

      const p0 = points[i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];

      const headingChange = Math.abs(this.normalizeAngle(p2.heading - p0.heading));
      const dist = (this.distance(p0, p1) + this.distance(p1, p2)) / 2;
      return headingChange / Math.max(dist, 0.01);
    });
  }

  private distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  }
}
