import { RacingLinePoint } from '../interfaces/car-state';
import { Segment } from './Track';
import { normalizeAngle, distance, isPointOnTrack, buildTrackPath, closestPointOnPath, rayDistanceToTrackEdge } from '../utils/track-utils';
import { CarSettings } from '../services/car-settings.service';
import { calculatePerformance, maxLongitudinalForce, maxBrakingDeceleration } from '../utils/car-physics';

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
    const speedNorm = this.state.speed / Math.max(this.maxSpeed, 0.1);
    const closest = closestPointOnPath({ x: this.state.x, y: this.state.y }, this.trackPath);
    const offsetNorm = Math.max(-1, Math.min(1, closest.offset / 10));
    const inputs = [...sensors, speedNorm, offsetNorm, 1];

    const steer = this.clamp(this.dot(inputs, this.genome.weights.slice(0, 8)), -1, 1);
    const throttle = this.clamp(this.dot(inputs, this.genome.weights.slice(8, 16)), 0, 1);
    const brake = this.clamp(this.dot(inputs, this.genome.weights.slice(16, 24)), 0, 1);

    const tractionForce = maxLongitudinalForce(this.settings, this.state.speed, throttle);
    const brakingForce = brake > 0 ? maxBrakingDeceleration(this.settings) * brake : 0;
    const acceleration = (tractionForce - brakingForce) / this.settings.mass;

    this.state.heading += steer * dt * 2.7;
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
    const progressReward = closest.s * 1000;
    const alignmentPenalty = Math.max(0, Math.abs(headingError) - Math.PI / 2) * 50;

    this.genome.fitness =
      progressReward +
      directionalSpeed * 5 -
      this.state.lapTime * 3 -
      closest.distance * 10 -
      backwardPenalty -
      alignmentPenalty;

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
}
