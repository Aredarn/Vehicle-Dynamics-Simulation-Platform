import { RacingLinePoint } from '../interfaces/car-state';
import {
  normalizeAngle,
  closestPointOnPath,
  closestPointOnPathNear,
} from '../utils/track-utils';
import { TrackModel, distanceBeyondEdge, rayDistanceToEdge } from '../utils/track-geometry';
import { CarSettings } from '../services/car-settings.service';
import {
  calculateCorneringSpeedLimit,
  calculatePerformance,
  maxBrakingDeceleration,
  getDrivingCharacteristics,
  stepVehicleDynamics,
  DrivingCharacteristics,
  TRACK_LIMITS,
  offTrackGripMultiplier,
} from '../utils/car-physics';
import { runPolicy } from '../utils/neural-policy';
import {
  TrainingObjective,
  DriftScoreState,
  createDriftScoreState,
  accumulateDrift,
} from '../utils/drift-scoring';

export const AI_INPUT_COUNT = 14;
export const AI_HIDDEN_SIZE = 12;

/** Record one trajectory point per N simulation steps (rendering needs far less than 30Hz). */
const TRAJECTORY_SAMPLE_EVERY = 3;

export interface AgentGenome {
  weights: number[];
  fitness: number;
  distance: number;
  lapTime: number;
  alive: boolean;
  maxProgress: number;
  progressRatio: number;
  completedLap: boolean;
  /** Total drift points. Zero for grip runs, which are ranked on lap time instead. */
  driftScore: number;
}

export class CarAgent {
  state = {
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    yawRate: 0,
    lateralVelocity: 0,
    alive: true,
    distance: 0,
    lapTime: 0,
  };

  trackPath: RacingLinePoint[] = [];
  track!: TrackModel;
  trackLength = 0;
  maxProgress = 0;
  completedLap = false;
  maxSpeed = 30;
  trajectory: RacingLinePoint[] = [];

  private driving!: DrivingCharacteristics;
  private optimalLine: RacingLinePoint[] = [];
  private optimalLapTime = 0;
  private offTrackTime = 0;
  private lastProgressS = 0;
  private stagnationTime = 0;
  private lastFrontUsage = 0;
  private lastRearUsage = 0;
  private lastBeyondEdge: number | null = null;
  private stepIndex = 0;

  private overspeedSum = 0;
  private gripRewardSum = 0;
  private gripSamples = 0;
  private spinPenaltySum = 0;
  private edgeSum = 0;
  private backwardSum = 0;
  private qualitySamples = 0;
  /** Rolling hint for the local path projection search. */
  private projectionIndex = 0;
  private lastProjection: ReturnType<typeof closestPointOnPathNear> | null = null;

  /** What this agent is being scored for. Grip is the default and is unchanged by drift mode. */
  private drift: DriftScoreState = createDriftScoreState();

  constructor(
    public genome: AgentGenome,
    private settings: CarSettings,
    public objective: TrainingObjective = 'grip'
  ) {
    this.driving = getDrivingCharacteristics(settings);
    const perf = calculatePerformance(settings);
    this.maxSpeed = Math.max(8, perf.topSpeed / 3.6);
  }

  reset(track: TrackModel, optimalLine: RacingLinePoint[] = [], optimalLapTime = 0) {
    this.driving = getDrivingCharacteristics(this.settings);
    this.track = track;
    this.trackPath = track.points;
    this.trackLength = this.trackPath.length ? this.trackPath[this.trackPath.length - 1].s : 0;
    this.optimalLine = optimalLine;
    this.optimalLapTime = optimalLapTime;
    this.maxProgress = 0;
    this.lastProgressS = 0;
    this.completedLap = false;
    this.offTrackTime = 0;
    this.stagnationTime = 0;
    this.lastFrontUsage = 0;
    this.lastRearUsage = 0;
    this.lastBeyondEdge = null;
    this.stepIndex = 0;
    this.overspeedSum = 0;
    this.gripRewardSum = 0;
    this.gripSamples = 0;
    this.spinPenaltySum = 0;
    this.edgeSum = 0;
    this.backwardSum = 0;
    this.qualitySamples = 0;
    this.projectionIndex = 0;
    this.lastProjection = null;
    this.drift = createDriftScoreState();

    const start = this.trackPath[0] ?? { x: 0, y: 0, heading: 0, s: 0 };
    this.state = {
      x: start.x,
      y: start.y,
      heading: start.heading,
      speed: 0,
      yawRate: 0,
      lateralVelocity: 0,
      alive: true,
      distance: 0,
      lapTime: 0,
    };
    this.trajectory = [{ x: start.x, y: start.y, heading: start.heading, s: start.s }];

    this.genome.fitness = 0;
    this.genome.distance = 0;
    this.genome.lapTime = 0;
    this.genome.alive = true;
    this.genome.maxProgress = 0;
    this.genome.progressRatio = 0;
    this.genome.completedLap = false;
    this.genome.driftScore = 0;
  }

  update(dt: number) {
    if (!this.state.alive || this.completedLap || !this.trackPath.length) return;

    const sensors = this.computeSensors();
    // The car has not moved since the previous step ended, so that step's projection is still
    // valid here — reusing it halves the number of path projections per step.
    const closest = this.lastProjection
      ?? closestPointOnPathNear({ x: this.state.x, y: this.state.y }, this.trackPath, this.projectionIndex);
    this.projectionIndex = closest.index;
    const speedNorm = this.state.speed / Math.max(this.maxSpeed, 0.1);
    const offsetNorm = this.clamp(closest.offset / 8, -1, 1);
    const speedTargetsAhead = this.computeLookaheadSpeedTargets(closest.s);
    const progressNorm = this.trackLength > 0 ? closest.s / this.trackLength : 0;
    const yawRateNorm = this.clamp(this.state.yawRate / 3, -1, 1);
    const slipNorm = this.clamp(Math.max(this.lastFrontUsage, this.lastRearUsage), 0, 1.5) / 1.5;
    const inputs = [
      ...sensors,
      speedNorm,
      offsetNorm,
      ...speedTargetsAhead,
      progressNorm,
      yawRateNorm,
      slipNorm,
      1,
    ];

    const [steerOut, throttleOut, brakeOut] = runPolicy(this.genome.weights, inputs, AI_HIDDEN_SIZE);
    const steer = this.clamp(steerOut, -1, 1);
    const throttle = this.clamp(throttleOut, 0, 1);
    const brake = this.clamp(brakeOut, 0, 1);

    // The car has not moved since the previous step measured this exact position, so reuse that
    // result instead of re-scanning the whole track.
    const beyondEdgeBefore = this.lastBeyondEdge ?? distanceBeyondEdge(
      { x: this.state.x, y: this.state.y },
      this.track,
      this.driving.carRadius
    );
    const gripMultiplier = offTrackGripMultiplier(beyondEdgeBefore);
    const prevX = this.state.x;
    const prevY = this.state.y;

    const dynResult = stepVehicleDynamics(
      this.state,
      this.settings,
      { steer, throttle, brake },
      dt,
      gripMultiplier,
      this.maxSpeed
    );
    this.lastFrontUsage = dynResult.frontUsage;
    this.lastRearUsage = dynResult.rearUsage;
    const distMoved = Math.hypot(this.state.x - prevX, this.state.y - prevY);

    this.state.lapTime += dt;
    this.state.distance += Math.abs(this.state.speed * dt);

    const closestAfter = closestPointOnPathNear(
      { x: this.state.x, y: this.state.y },
      this.trackPath,
      this.projectionIndex
    );
    this.projectionIndex = closestAfter.index;
    // Carried into the next step, where this position is the starting position.
    this.lastProjection = closestAfter;
    // Subsampled: one point per step is far finer than anything the rendered line needs, and
    // every generation's best trajectory is retained in the run history — at the longer budgets
    // a large track requires that grew into hundreds of thousands of retained points.
    this.stepIndex++;
    if (this.stepIndex % TRAJECTORY_SAMPLE_EVERY === 0) {
      this.trajectory.push({ x: this.state.x, y: this.state.y, heading: this.state.heading, s: closestAfter.s });
    }

    const beyondEdgeAfter = distanceBeyondEdge(
      { x: this.state.x, y: this.state.y },
      this.track,
      this.driving.carRadius
    );
    const onTrack = beyondEdgeAfter <= 0.01;
    this.lastBeyondEdge = beyondEdgeAfter;

    if (!onTrack) {
      this.offTrackTime += dt;
    } else {
      this.offTrackTime = Math.max(0, this.offTrackTime - dt * 2);
    }

    if (this.objective === 'drift') {
      const slipDeg = (dynResult.bodySlipAngle * 180) / Math.PI;
      const groundSpeed = Math.hypot(this.state.speed, this.state.lateralVelocity ?? 0);
      accumulateDrift(this.drift, slipDeg, groundSpeed, onTrack, dt);
    }

    const headingError = normalizeAngle(this.state.heading - closest.heading);
    const forwardAlignment = Math.cos(headingError);

    // Crossing the finish has to be judged before the off-track check. On an open layout there
    // is no tarmac past the final segment, so a car that drives *through* the finish is outside
    // every segment on the next step and was being scored as a crash. That made finishing a
    // knife-edge — the car had to stop inside a few metres of the end rather than drive over it,
    // so laps were never completed and the whole lap-time incentive stayed dormant.
    const nearFinishLine = this.trackLength > 0
      && this.maxProgress >= this.trackLength * 0.85
      && Math.max(this.maxProgress, closestAfter.s) >= this.trackLength - TRACK_LIMITS.finishToleranceMetres;

    if (nearFinishLine && forwardAlignment > 0.3) {
      this.maxProgress = this.trackLength;
      this.completedLap = true;
      this.state.alive = false;
      this.genome.alive = false;
      this.accumulateDrivingQuality(closestAfter.s, steer, brake, dynResult, Math.min(...sensors), forwardAlignment);
      this.updateFitness(0);
      return;
    }

    if (beyondEdgeAfter > TRACK_LIMITS.hardCutoffMetres || this.offTrackTime >= this.driving.offTrackGraceSeconds) {
      this.state.alive = false;
      this.genome.alive = false;
    }

    let progressDelta = 0;
    if (onTrack && (forwardAlignment > 0.15 || closest.distance < 2)) {
      // Cap how far arc-length progress can jump per step relative to distance actually
      // covered. Without this, cutting straight across a corner's apex projects onto a much
      // later point on the centerline than the car really earned, rewarding illegitimate
      // corner-cutting as if it were genuine progress. The slack factor still lets a real
      // racing line (legitimately shorter than the raw centerline) advance a bit faster.
      const rawCandidate = Math.max(this.maxProgress, closestAfter.s);
      const progressCandidate = Math.min(rawCandidate, this.maxProgress + distMoved * TRACK_LIMITS.progressSlack);
      if (progressCandidate > this.maxProgress + 0.02) {
        progressDelta = progressCandidate - this.maxProgress;
        this.lastProgressS = this.maxProgress;
        this.maxProgress = progressCandidate;
        this.stagnationTime = 0;
      } else {
        this.stagnationTime += dt;
      }
    }

    this.accumulateDrivingQuality(
      closestAfter.s,
      steer,
      brake,
      dynResult,
      Math.min(...sensors),
      forwardAlignment
    );
    this.updateFitness(progressDelta);
  }

  private accumulateDrivingQuality(
    currentS: number,
    steer: number,
    brake: number,
    dynResult: ReturnType<typeof stepVehicleDynamics>,
    minSensor: number,
    forwardAlignment: number
  ) {
    // The optimizer's profile is a speed *limit*, not a setpoint: only carrying more speed than
    // the corner supports is a driving error, and it is what makes a car run wide. Being under
    // the limit is already discouraged by the lap-time term, so penalizing both double-counted
    // it — and punished the physically unavoidable case of accelerating away from a standstill.
    // Normalized by top speed so this stays dimensionless; squaring a raw m/s error instead put
    // this single term in the tens of thousands, dwarfing every other signal in the reward.
    const targetSpeed = this.sampleOptimalSpeedAtS(currentS);
    if (targetSpeed !== null) {
      const overspeed = Math.max(0, this.state.speed - targetSpeed) / Math.max(this.maxSpeed, 1);
      this.overspeedSum += overspeed * overspeed;
    }

    // Time-averaged line-quality samples. These were previously read only from the final
    // simulation step, so they described one arbitrary instant rather than the whole lap.
    this.edgeSum += this.clamp((0.15 - minSensor) / 0.15, 0, 1);
    this.backwardSum += Math.max(0, -forwardAlignment);
    this.qualitySamples++;

    const combinedUsage = Math.max(dynResult.frontUsage, dynResult.rearUsage);

    // Trail braking = braking and turning at once. Reward sitting near the grip limit there
    // instead of rewarding raw speed, so under-driving the corner isn't "safe" for fitness.
    if (brake > 0.1 && Math.abs(steer) > 0.15) {
      const utilization = this.clamp(combinedUsage, 0, 1.15);
      const reward = utilization <= 1 ? utilization : Math.max(0, 1 - (utilization - 1) * 3);
      this.gripRewardSum += reward;
      this.gripSamples++;
    }

    const curvature = this.sampleCurvatureAtS(currentS);
    const impliedYawRate = curvature * this.state.speed;
    const yawExcess = Math.max(0, Math.abs(this.state.yawRate) - Math.abs(impliedYawRate) - 0.3);
    this.spinPenaltySum += yawExcess;
  }

  private updateFitness(progressDelta: number) {
    if (this.objective === 'drift') {
      this.updateDriftFitness(progressDelta);
      return;
    }
    this.updateGripFitness(progressDelta);
  }

  /**
   * Drift scoring.
   *
   * The grip reward is not reusable here, and not by a small margin: it penalises yaw beyond
   * what the corner's curvature implies, and penalises carrying more speed than the corner
   * supports. Those two terms describe a drift almost exactly, so a drift agent trained on the
   * grip reward would be punished precisely for succeeding.
   *
   * What survives from the grip reward is everything about *driving the course*: progress round
   * the lap, staying on the road, and facing the right way. Track limits are identical, so a
   * drift lap and a grip lap on the same layout are held to the same standard.
   */
  private updateDriftFitness(progressDelta: number) {
    const progressRatio = this.trackLength > 0 ? this.maxProgress / this.trackLength : 0;
    const samples = Math.max(1, this.qualitySamples);

    // Progress still matters — otherwise the best strategy is to sit at the start line doing
    // donuts forever, which scores angle at speed without ever driving the track.
    const progressScore = progressRatio * 6000;
    const momentumScore = progressDelta * 200;
    const driftScore = this.drift.score * 12;

    const backwardPenalty = (this.backwardSum / samples) * 600;
    const offTrackPenalty = this.offTrackTime * 200;

    let fitness = progressScore + momentumScore + driftScore - backwardPenalty - offTrackPenalty;

    if (!this.state.alive && !this.completedLap) {
      fitness -= (1 - progressRatio) * 1500;
    }

    // Flat, unlike the grip bonus: a drift lap is not judged on how quickly it was completed.
    if (this.completedLap) fitness += 8000;

    if (this.stagnationTime > 4 && progressRatio < 0.15) fitness -= 800;

    this.commitGenome(fitness, progressRatio);
  }

  private updateGripFitness(progressDelta: number) {
    const progressRatio = this.trackLength > 0 ? this.maxProgress / this.trackLength : 0;

    const progressScore = progressRatio * 10000;
    const momentumScore = progressDelta * 400;
    const timePenalty = this.state.lapTime * 12;

    const samples = Math.max(1, this.qualitySamples);
    const overspeedPenalty = (this.overspeedSum / samples) * 3000;
    // No centerline term: a racing line is *defined* by leaving the centerline — running wide on
    // entry, clipping the apex, opening the exit, and straightening a chicane into one line.
    // Penalizing lateral offset rewarded tracing the centerline's curvature instead, which is
    // exactly why a chicane came out as a wiggle rather than being straightened out. Staying on
    // the road is enforced by the hard track limits; the line itself is shaped by lap time.
    // The edge term is likewise only a light wall-scrape deterrent now, not a "keep to the
    // middle" prior, since using the full track width is correct.
    const edgePenalty = (this.edgeSum / samples) * 150;
    const backwardPenalty = (this.backwardSum / samples) * 1200;
    const spinPenalty = (this.spinPenaltySum / samples) * 400;

    // Bounded as a group so line quality can rank comparable agents without ever swamping the
    // progress term. Previously an unbounded penalty (a squared raw m/s speed error) reached
    // ~53000 against a progress score of ~250, forcing every agent onto the old
    // `max(fitness, progressScore * 0.4)` floor — which made fitness a pure function of
    // progress and silently discarded every line-quality signal below.
    const qualityPenalty = Math.min(
      3000,
      overspeedPenalty + edgePenalty + backwardPenalty + spinPenalty
    );

    const avgGripReward = this.gripSamples > 0 ? this.gripRewardSum / this.gripSamples : 0;
    const gripUtilizationScore = avgGripReward * 800 * progressRatio;

    const offTrackPenalty = this.offTrackTime * 200;

    let fitness =
      progressScore +
      momentumScore +
      gripUtilizationScore -
      timePenalty -
      qualityPenalty -
      offTrackPenalty;

    if (!this.state.alive && !this.completedLap) {
      const crashPenalty = (1 - progressRatio) * 2000;
      fitness -= crashPenalty;
    }

    if (this.completedLap) {
      const referenceLapTime = this.optimalLapTime > 0 ? this.optimalLapTime : this.state.lapTime;
      // Cap well above 1 so a lap quicker than the reference keeps earning more. The reference
      // is a quasi-static estimate over the smoothed centerline, and a real racing line can
      // legitimately beat it — a tight cap would flatten the incentive to keep sharpening.
      const timeRatio = this.clamp(referenceLapTime / Math.max(this.state.lapTime, 0.01), 0.2, 3);
      fitness += 12000 * timeRatio;
    }

    if (this.stagnationTime > 4 && progressRatio < 0.15) {
      fitness -= 800;
    }

    this.commitGenome(fitness, progressRatio);
  }

  private commitGenome(fitness: number, progressRatio: number) {
    this.genome.fitness = fitness;
    this.genome.distance = this.state.distance;
    this.genome.lapTime = this.state.lapTime;
    this.genome.alive = this.state.alive;
    this.genome.maxProgress = this.maxProgress;
    this.genome.progressRatio = progressRatio;
    this.genome.completedLap = this.completedLap;
    this.genome.driftScore = this.drift.score;
  }

  private sampleOptimalSpeedAtS(targetS: number): number | null {
    if (!this.optimalLine.length || this.trackLength <= 0) return null;
    const wrapped = ((targetS % this.trackLength) + this.trackLength) % this.trackLength;
    let lo = 0;
    let hi = this.optimalLine.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.optimalLine[mid].s < wrapped) lo = mid + 1;
      else hi = mid;
    }
    return this.optimalLine[lo].targetSpeed ?? null;
  }

  private computeSensors(): number[] {
    const angles = [-0.75, -0.35, 0, 0.35, 0.75];
    const maxDist = this.driving.sensorRange;
    return angles.map(angle => {
      const heading = this.state.heading + angle;
      const rawDistance = rayDistanceToEdge(
        { x: this.state.x, y: this.state.y },
        heading,
        this.track,
        maxDist,
        0.5,
        this.driving.carRadius
      );
      return Math.max(0, Math.min(1, rawDistance / maxDist));
    });
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  private sampleHeadingAtS(targetS: number): number {
    if (!this.trackPath.length) return 0;
    const wrapped = ((targetS % this.trackLength) + this.trackLength) % this.trackLength;
    let lo = 0;
    let hi = this.trackPath.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.trackPath[mid].s < wrapped) lo = mid + 1;
      else hi = mid;
    }
    return this.trackPath[lo].heading;
  }

  private getLookaheadDistances(): number[] {
    const brakingDecel = maxBrakingDeceleration(this.settings);
    const stoppingDist = (this.maxSpeed * this.maxSpeed) / (2 * Math.max(brakingDecel, 1));
    return [
      Math.max(8, stoppingDist * 0.12),
      Math.max(18, stoppingDist * 0.35),
      Math.max(30, stoppingDist * 0.75),
    ];
  }

  private sampleCurvatureAtS(targetS: number): number {
    const ds = 4;
    const h1 = this.sampleHeadingAtS(targetS);
    const h2 = this.sampleHeadingAtS(targetS + ds);
    return Math.abs(normalizeAngle(h2 - h1)) / ds;
  }

  private computeLookaheadSpeedTargets(currentS: number): number[] {
    return this.getLookaheadDistances().map(dist => {
      const curvature = this.sampleCurvatureAtS(currentS + dist);
      const vLimit = calculateCorneringSpeedLimit(this.settings, curvature, this.state.speed, 0);
      return this.clamp(vLimit / Math.max(this.maxSpeed, 0.1), 0, 1);
    });
  }
}
