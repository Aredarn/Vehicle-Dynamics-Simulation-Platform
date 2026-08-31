import { RacingLinePoint } from '../interfaces/car-state';
import { normalizeAngle, closestPointOnPathNear } from '../utils/track-utils';
import { TrackModel, distanceBeyondEdge } from '../utils/track-geometry';
import { CarSettings } from '../services/car-settings.service';
import {
  calculatePerformance,
  getDrivingCharacteristics,
  stepVehicleDynamics,
  offTrackGripMultiplier,
  TRACK_LIMITS,
  DrivingCharacteristics,
  VehicleStepResult,
} from '../utils/car-physics';

/**
 * Where the driver wants the controls, not where they are.
 *
 * Values are targets in the same units the vehicle model consumes, so a gamepad or wheel can
 * feed them straight through while a keyboard supplies the extremes.
 */
export interface DriverInput {
  /** -1 = full left, +1 = full right. */
  steer: number;
  throttle: number;
  brake: number;
}

export type RunStatus = 'ready' | 'running' | 'finished' | 'retired';

/** Everything the HUD reads. All of it is measured from the physics step, none of it invented. */
export interface PlayerTelemetry {
  speedMs: number;
  speedKmh: number;
  /** Fraction of the car's own top speed — drives the speedo sweep. */
  speedRatio: number;
  topSpeedKmh: number;

  longitudinalG: number;
  lateralG: number;
  combinedG: number;
  /** The lateral g the tires could still deliver — the radius of the friction circle right now. */
  maxLateralAccelG: number;

  frontUsage: number;
  rearUsage: number;
  /** The front tires are past their peak slip angle: the car is running wide. */
  gripLimited: boolean;
  /** The rear tires are past their peak: the back is stepping out. */
  oversteering: boolean;
  /** Angle between where the car points and where it is going, in degrees. A slide. */
  bodySlipDeg: number;
  frontSlipDeg: number;
  rearSlipDeg: number;
  /** Aerodynamic downforce at the current speed (N) — grows with the square of speed. */
  downforce: number;

  frontLoad: number;
  rearLoad: number;
  /** 0..1 share of total load on the front axle — shows weight transfer under braking. */
  frontLoadShare: number;

  engineForce: number;
  brakeForce: number;
  dragForce: number;
  /** Power actually reaching the road (kW) — reveals traction- vs power-limited acceleration. */
  powerKw: number;

  steer: number;
  throttle: number;
  brake: number;
  yawRate: number;

  onTrack: boolean;
  /** How far past the track edge the car is (m), and the grip left because of it. */
  beyondEdge: number;
  surfaceGrip: number;
  offTrackTime: number;
  offTrackGrace: number;

  lapTime: number;
  distance: number;
  progressRatio: number;
  status: RunStatus;
}

/**
 * How fast the driver's controls can move, in units per second.
 *
 * A steering rack and a pedal have finite travel speed, so a keypress cannot teleport the front
 * wheels to full lock. This is a model of the *controls*, not an assist: it never adds grip,
 * never corrects the car's line, and never overrides what the driver asked for. Release is
 * quicker than application in both cases — self-aligning torque returns the wheel, and a foot
 * comes off a pedal faster than it presses one.
 */
const STEER_APPLY_RATE = 3.4;
const STEER_RETURN_RATE = 5.0;
const THROTTLE_APPLY_RATE = 4.0;
const THROTTLE_RELEASE_RATE = 8.0;
const BRAKE_APPLY_RATE = 6.0;
const BRAKE_RELEASE_RATE = 9.0;

/** Match CarAgent's trajectory sampling so the player's line and the AI's are drawn alike. */
const TRAIL_SAMPLE_EVERY = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Moves `current` toward `target` without exceeding `rate` per second. */
function slew(current: number, target: number, rate: number, dt: number): number {
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/**
 * A human-driven car.
 *
 * It runs the *same* `stepVehicleDynamics` as every AI agent, with the same `CarSettings`, the
 * same off-track grip ramp and the same `TRACK_LIMITS`. The only difference between this and a
 * `CarAgent` is where the three control values come from — a keyboard instead of a neural
 * policy. That is deliberate: a lap time is only worth comparing against the AI's if both cars
 * obeyed identical physics and identical track limits.
 */
export class PlayerCar {
  state = { x: 0, y: 0, heading: 0, speed: 0, yawRate: 0, lateralVelocity: 0 };

  /** Actual control positions, after rate limiting — what the physics actually receives. */
  controls = { steer: 0, throttle: 0, brake: 0 };

  status: RunStatus = 'ready';
  lapTime = 0;
  distance = 0;
  maxProgress = 0;
  trackLength = 0;
  /** The line actually driven, for drawing against the AI's. */
  trail: RacingLinePoint[] = [];

  private track: TrackModel | null = null;
  private trackPath: RacingLinePoint[] = [];
  private driving: DrivingCharacteristics;
  private maxSpeed = 30;
  private topSpeedKmh = 100;
  private offTrackTime = 0;
  private projectionIndex = 0;
  private stepIndex = 0;
  private lastStep: VehicleStepResult | null = null;
  private lastBeyondEdge = 0;

  constructor(private settings: CarSettings) {
    this.driving = getDrivingCharacteristics(settings);
    const perf = calculatePerformance(settings);
    this.topSpeedKmh = perf.topSpeed;
    this.maxSpeed = Math.max(8, perf.topSpeed / 3.6);
  }

  /** Re-reads the car's stats. Every number below is derived from CarSettings, nothing is fixed. */
  updateSettings(settings: CarSettings) {
    this.settings = settings;
    this.driving = getDrivingCharacteristics(settings);
    const perf = calculatePerformance(settings);
    this.topSpeedKmh = perf.topSpeed;
    this.maxSpeed = Math.max(8, perf.topSpeed / 3.6);
  }

  /** Places the car at the start line, exactly where an agent begins its lap. */
  reset(track: TrackModel) {
    this.track = track;
    this.trackPath = track.points;
    this.trackLength = this.trackPath.length ? this.trackPath[this.trackPath.length - 1].s : 0;

    const start = this.trackPath[0] ?? { x: 0, y: 0, heading: 0, s: 0 };
    this.state = { x: start.x, y: start.y, heading: start.heading, speed: 0, yawRate: 0, lateralVelocity: 0 };
    this.controls = { steer: 0, throttle: 0, brake: 0 };

    this.status = 'ready';
    this.lapTime = 0;
    this.distance = 0;
    this.maxProgress = 0;
    this.offTrackTime = 0;
    this.projectionIndex = 0;
    this.stepIndex = 0;
    this.lastStep = null;
    this.lastBeyondEdge = 0;
    this.trail = [{ x: start.x, y: start.y, heading: start.heading, s: start.s }];
  }

  /**
   * Advances one fixed timestep. Returns true when the run ended on this step, so the caller
   * can record the lap.
   */
  update(dt: number, input: DriverInput): boolean {
    if (!this.track || !this.trackPath.length) return false;
    if (this.status === 'finished' || this.status === 'retired') return false;

    this.applyDriverInput(dt, input);

    // The clock starts on the first real input, so a standing start is not penalised by however
    // long the driver spends looking at the track before setting off.
    if (this.status === 'ready') {
      if (this.controls.throttle > 0.01 || this.controls.brake > 0.01 || Math.abs(this.controls.steer) > 0.01) {
        this.status = 'running';
      } else {
        return false;
      }
    }

    const beyondEdgeBefore = this.lastBeyondEdge;
    const gripMultiplier = offTrackGripMultiplier(beyondEdgeBefore);

    const prevX = this.state.x;
    const prevY = this.state.y;

    this.lastStep = stepVehicleDynamics(
      this.state,
      this.settings,
      this.controls,
      dt,
      gripMultiplier,
      this.maxSpeed
    );

    const distMoved = Math.hypot(this.state.x - prevX, this.state.y - prevY);
    this.lapTime += dt;
    this.distance += Math.hypot(this.state.speed, this.state.lateralVelocity ?? 0) * dt;

    const closest = closestPointOnPathNear(
      { x: this.state.x, y: this.state.y },
      this.trackPath,
      this.projectionIndex
    );
    this.projectionIndex = closest.index;

    this.stepIndex++;
    if (this.stepIndex % TRAIL_SAMPLE_EVERY === 0) {
      this.trail.push({ x: this.state.x, y: this.state.y, heading: this.state.heading, s: closest.s });
    }

    const beyondEdge = distanceBeyondEdge(
      { x: this.state.x, y: this.state.y },
      this.track,
      this.driving.carRadius
    );
    this.lastBeyondEdge = beyondEdge;
    const onTrack = beyondEdge <= 0.01;

    if (!onTrack) {
      this.offTrackTime += dt;
    } else {
      this.offTrackTime = Math.max(0, this.offTrackTime - dt * 2);
    }

    const forwardAlignment = Math.cos(normalizeAngle(this.state.heading - closest.heading));

    // Judged before the off-track test, for the same reason the agent is: on an open layout
    // there is no tarmac past the final point, so driving *through* the finish would otherwise
    // register as leaving the track rather than completing the lap.
    const nearFinishLine = this.trackLength > 0
      && this.maxProgress >= this.trackLength * 0.85
      && Math.max(this.maxProgress, closest.s) >= this.trackLength - TRACK_LIMITS.finishToleranceMetres;

    if (nearFinishLine && forwardAlignment > 0.3) {
      this.maxProgress = this.trackLength;
      this.status = 'finished';
      return true;
    }

    if (beyondEdge > TRACK_LIMITS.hardCutoffMetres || this.offTrackTime >= this.driving.offTrackGraceSeconds) {
      this.status = 'retired';
      return true;
    }

    if (onTrack && (forwardAlignment > 0.15 || closest.distance < 2)) {
      // Same cap the agent gets: arc-length progress may not outrun the distance actually
      // covered, so cutting across an apex cannot claim track the car never drove.
      const rawCandidate = Math.max(this.maxProgress, closest.s);
      const candidate = Math.min(rawCandidate, this.maxProgress + distMoved * TRACK_LIMITS.progressSlack);
      if (candidate > this.maxProgress) this.maxProgress = candidate;
    }

    return false;
  }

  /**
   * Moves the controls toward what the driver is asking for. Steering returns to centre on its
   * own when nothing is pressed, which is the rack unwinding, not a correction being applied.
   */
  private applyDriverInput(dt: number, input: DriverInput) {
    const steerTarget = clamp(input.steer, -1, 1);
    const returning = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(this.controls.steer);
    this.controls.steer = slew(
      this.controls.steer,
      steerTarget,
      returning ? STEER_RETURN_RATE : STEER_APPLY_RATE,
      dt
    );

    const throttleTarget = clamp(input.throttle, 0, 1);
    this.controls.throttle = slew(
      this.controls.throttle,
      throttleTarget,
      throttleTarget > this.controls.throttle ? THROTTLE_APPLY_RATE : THROTTLE_RELEASE_RATE,
      dt
    );

    const brakeTarget = clamp(input.brake, 0, 1);
    this.controls.brake = slew(
      this.controls.brake,
      brakeTarget,
      brakeTarget > this.controls.brake ? BRAKE_APPLY_RATE : BRAKE_RELEASE_RATE,
      dt
    );
  }

  /** The track this car was placed on, so a caller can tell when it has gone stale. */
  get boundTrack(): TrackModel | null {
    return this.track;
  }

  get progressRatio(): number {
    return this.trackLength > 0 ? clamp(this.maxProgress / this.trackLength, 0, 1) : 0;
  }

  /** A snapshot for the HUD. Every field comes from the physics step or the track query. */
  telemetry(): PlayerTelemetry {
    const g = 9.81;
    const step = this.lastStep;
    const longG = step ? step.longitudinalAccel / g : 0;
    const latG = step ? step.lateralAccel / g : 0;
    const totalLoad = step ? step.frontLoad + step.rearLoad : 1;

    const groundSpeed = Math.hypot(this.state.speed, this.state.lateralVelocity ?? 0);

    return {
      speedMs: groundSpeed,
      speedKmh: groundSpeed * 3.6,
      speedRatio: clamp(groundSpeed / Math.max(this.maxSpeed, 0.1), 0, 1),
      topSpeedKmh: this.topSpeedKmh,

      longitudinalG: longG,
      lateralG: latG,
      combinedG: Math.hypot(longG, latG),
      maxLateralAccelG: step ? step.maxLateralAccel / g : 0,

      frontUsage: step ? step.frontUsage : 0,
      rearUsage: step ? step.rearUsage : 0,
      gripLimited: step ? step.gripLimited : false,
      oversteering: step ? step.oversteering : false,
      bodySlipDeg: step ? (step.bodySlipAngle * 180) / Math.PI : 0,
      frontSlipDeg: step ? (step.frontSlipAngle * 180) / Math.PI : 0,
      rearSlipDeg: step ? (step.rearSlipAngle * 180) / Math.PI : 0,
      downforce: step ? step.downforce : 0,

      frontLoad: step ? step.frontLoad : 0,
      rearLoad: step ? step.rearLoad : 0,
      frontLoadShare: step && totalLoad > 0 ? step.frontLoad / totalLoad : 0.5,

      engineForce: step ? step.engineForce : 0,
      brakeForce: step ? step.brakeForce : 0,
      dragForce: step ? step.dragForce : 0,
      powerKw: step ? (step.engineForce * this.state.speed) / 1000 : 0,

      steer: this.controls.steer,
      throttle: this.controls.throttle,
      brake: this.controls.brake,
      yawRate: this.state.yawRate,

      onTrack: this.lastBeyondEdge <= 0.01,
      beyondEdge: this.lastBeyondEdge,
      surfaceGrip: offTrackGripMultiplier(this.lastBeyondEdge),
      offTrackTime: this.offTrackTime,
      offTrackGrace: this.driving.offTrackGraceSeconds,

      lapTime: this.lapTime,
      distance: this.distance,
      progressRatio: this.progressRatio,
      status: this.status,
    };
  }
}
