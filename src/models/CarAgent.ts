import { RacingLinePoint } from '../interfaces/car-state';
import { Segment } from './Track';
import { normalizeAngle, distance, isPointOnTrack, buildTrackPath, closestPointOnPath, rayDistanceToTrackEdge } from '../utils/track-utils';
import { CarSettings } from '../services/car-settings.service';
import { calculateCorneringSpeedLimit, calculateLongitudinalAcceleration, calculatePerformance, maxBrakingDeceleration, maxLateralAcceleration } from '../utils/car-physics';

export interface AgentGenome {
  weights: number[];
  fitness: number;
  distance: number;
  lapTime: number;
  alive: boolean;
}

export class CarAgent {
  state = {
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    alive: true,
    distance: 0,
    lapTime: 0,
  };

  size = 0.6;
  trackPath: RacingLinePoint[] = [];
  trackSegments: Segment[] = [];
  trackLength = 0;
  maxProgress = 0;
  completedLap = false;
  maxSpeed = 30;
  trajectory: RacingLinePoint[] = [];

  constructor(public genome: AgentGenome, private settings: CarSettings) {
    const perf = calculatePerformance(settings);
    this.maxSpeed = Math.max(5, perf.topSpeed / 3.6);
  }

  reset(segments: Segment[]) {
    this.trackSegments = segments;
    this.trackPath = buildTrackPath(segments, 2);
    this.trackLength = this.trackPath.length ? this.trackPath[this.trackPath.length - 1].s : 0;
    this.maxProgress = 0;
    this.completedLap = false;

    const start = this.trackPath[0] ?? { x: 0, y: 0, heading: 0, s: 0 };
    this.state = {
      x: start.x,
      y: start.y,
      heading: start.heading,
      speed: 0,
      alive: true,
      distance: 0,
      lapTime: 0,
    };
    this.trajectory = [{ x: start.x, y: start.y, heading: start.heading, s: start.s }];

    this.genome.fitness = 0;
    this.genome.distance = 0;
    this.genome.lapTime = 0;
    this.genome.alive = true;
  }

  update(dt: number) {
    if (!this.state.alive || this.completedLap || !this.trackSegments.length) return;

    const sensors = this.computeSensors();
    const closest = closestPointOnPath({ x: this.state.x, y: this.state.y }, this.trackPath);
    const curvatureAhead = this.computeLookaheadCurvature(closest.s);
    const speedNorm = this.state.speed / Math.max(this.maxSpeed, 0.1);
    const offsetNorm = this.clamp(closest.offset / 10, -1, 1);
    const speedTargetsAhead = this.computeLookaheadSpeedTargets(closest.s);
  const inputs = [...sensors, speedNorm, offsetNorm, ...speedTargetsAhead, 1]; // 5+1+1+3+1 = 11


    const steer = this.clamp(this.dot(inputs, this.genome.weights.slice(0, 11)), -1, 1);
    const throttle = this.clamp(this.dot(inputs, this.genome.weights.slice(11, 22)), 0, 1);
    const brake = this.clamp(this.dot(inputs, this.genome.weights.slice(22, 33)), 0, 1);

    // inside update(), replace the heading line:
    const baseSteerRate = 1.6; // rad/s, max steering angular rate input (not yaw rate)
    const desiredYawRate = steer * baseSteerRate;
    const maxLatAcc = maxLateralAcceleration(this.settings, this.state.speed, steer);
    const maxYawRateFromGrip = this.state.speed > 0.5
      ? maxLatAcc / this.state.speed
      : baseSteerRate;
    const yawRate = this.clamp(desiredYawRate, -maxYawRateFromGrip, maxYawRateFromGrip);
    const latAccUsed = Math.abs(yawRate) * this.state.speed;
    const gripUsedRatio = maxLatAcc > 0 ? Math.min(1, latAccUsed / maxLatAcc) : 0;
    const longGripScale = Math.sqrt(Math.max(0, 1 - gripUsedRatio * gripUsedRatio));

    const acceleration = calculateLongitudinalAcceleration(this.settings, this.state.speed, throttle, brake) * longGripScale;

    this.state.heading += yawRate * dt;
    this.state.speed = this.clamp(this.state.speed + acceleration * dt, 0, this.maxSpeed);
    this.state.x += Math.cos(this.state.heading) * this.state.speed * dt;
    this.state.y += Math.sin(this.state.heading) * this.state.speed * dt;
    this.state.lapTime += dt;
    this.state.distance += Math.abs(this.state.speed * dt);

    const closestAfter = closestPointOnPath({ x: this.state.x, y: this.state.y }, this.trackPath);
    this.trajectory.push({ x: this.state.x, y: this.state.y, heading: this.state.heading, s: closestAfter.s });

    if (!isPointOnTrack({ x: this.state.x, y: this.state.y }, this.trackSegments, this.size)) {
      this.state.alive = false;
      this.genome.alive = false;
    }

    const headingError = normalizeAngle(this.state.heading - closest.heading);
    const forwardAlignment = Math.cos(headingError);

    if (forwardAlignment > 0.5) {
      this.maxProgress = Math.max(this.maxProgress, closest.s);
    }

    if (this.trackLength > 0 && closest.s >= this.trackLength - 2 && forwardAlignment > 0.5) {
      this.completedLap = true;
      this.state.alive = false;
    }

    const directionalSpeed = Math.max(0, this.state.speed * forwardAlignment);
    const backwardPenalty = Math.max(0, -forwardAlignment) * this.state.speed * 50;
    const alignmentPenalty = Math.max(0, Math.abs(headingError) - Math.PI / 2) * 50;

    const minEdgeDistNorm = Math.min(...sensors); // 0..1, 1 = far from wall
    const edgePenalty = minEdgeDistNorm < 0.15 ? (0.15 - minEdgeDistNorm) * 300 : 0;

    const progressReward = this.maxProgress * 1000;
    const avgSpeed = this.state.distance / Math.max(this.state.lapTime, 0.001);

    this.genome.fitness =
      progressReward +
      avgSpeed * 15 +
      directionalSpeed * 3 -
      edgePenalty -
      backwardPenalty -
      alignmentPenalty;

    if (!this.state.alive) this.genome.fitness -= 250;
    if (this.completedLap) this.genome.fitness += 3000 - this.state.lapTime * 20;

        if (!this.state.alive) this.genome.fitness -= 250;
        this.genome.distance = this.state.distance;
        this.genome.lapTime = this.state.lapTime;
        this.genome.alive = this.state.alive;
      }

  private computeSensors(): number[] {
    const angles = [-0.75, -0.35, 0, 0.35, 0.75];
    return angles.map(angle => {
      const heading = this.state.heading + angle;
      const rawDistance = rayDistanceToTrackEdge({ x: this.state.x, y: this.state.y }, heading, this.trackSegments, 30, 0.5, this.size);
      return Math.max(0, Math.min(1, rawDistance / 30));
    });
  }

  private dot(a: number[], b: number[]) {
    return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  private sampleHeadingAtS(targetS: number): number {
  if (!this.trackPath.length) return 0;
  const wrapped = ((targetS % this.trackLength) + this.trackLength) % this.trackLength;
  let lo = 0, hi = this.trackPath.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (this.trackPath[mid].s < wrapped) lo = mid + 1; else hi = mid;
  }
  return this.trackPath[lo].heading;
  }

  private getLookaheadDistances(): number[] {
  const brakingDecel = maxBrakingDeceleration(this.settings); // m/s²
  const stoppingDistFromTop = (this.maxSpeed * this.maxSpeed) / (2 * Math.max(brakingDecel, 1));
  // scale three checkpoints relative to actual stopping capability
  return [
    Math.max(6, stoppingDistFromTop * 0.15),
    Math.max(15, stoppingDistFromTop * 0.4),
    Math.max(25, stoppingDistFromTop * 0.9),
  ];
}

  private sampleCurvatureAtS(targetS: number): number {
  // approximate curvature via heading change over a short arc
  const ds = 3;
  const h1 = this.sampleHeadingAtS(targetS);
  const h2 = this.sampleHeadingAtS(targetS + ds);
  const dHeading = Math.abs(normalizeAngle(h2 - h1));
  return dHeading / ds; // rad per meter ≈ curvature
}

private computeLookaheadSpeedTargets(currentS: number): number[] {
  const lookaheads = this.getLookaheadDistances();
  return lookaheads.map(dist => {
    const curvature = this.sampleCurvatureAtS(currentS + dist);
    const vLimit = calculateCorneringSpeedLimit(this.settings, curvature, this.state.speed, 0);
    return this.clamp(vLimit / Math.max(this.maxSpeed, 0.1), 0, 1);
  });
}

  private computeLookaheadCurvature(currentS: number): number[] {
    const lookaheads = [8, 20, 40]; // meters ahead
    const baseHeading = this.sampleHeadingAtS(currentS);
    return lookaheads.map(dist => {
      const diff = normalizeAngle(this.sampleHeadingAtS(currentS + dist) - baseHeading);
      return this.clamp(diff / (Math.PI / 2), -1, 1);
    });
  }
}
