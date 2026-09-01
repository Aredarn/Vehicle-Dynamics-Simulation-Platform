/**
 * Drift scoring, shared by the AI and the human driver.
 *
 * A drift run is judged the way a real one is: angle, held at speed, for as long as possible.
 * Both sides read this same module so a player's drift score means the same thing as an agent's,
 * exactly as their lap times already do.
 */

/** What the AI is being asked to learn. */
export type TrainingObjective = 'grip' | 'drift';

/** Below this the car is just running a little loose, not drifting. Scores nothing. */
export const DRIFT_MIN_ANGLE_DEG = 15;
/** The angle worth the most — a committed, controlled slide. */
export const DRIFT_IDEAL_ANGLE_DEG = 45;
/** Past this the car is spinning rather than drifting, and the score falls back to zero. */
export const DRIFT_MAX_ANGLE_DEG = 70;

/** How long the angle may drop out before a run is considered broken. */
export const DRIFT_STREAK_GRACE_SECONDS = 0.35;
/** A sustained drift builds toward this multiplier; linking corners is worth more than flicks. */
export const DRIFT_MAX_MULTIPLIER = 2;
/** Seconds of continuous drifting needed to reach the full multiplier. */
export const DRIFT_MULTIPLIER_RAMP_SECONDS = 4;

/**
 * How much a given body slip angle is worth, 0..1.
 *
 * Zero below the threshold, rising to 1 at the ideal angle, then falling away again — so the
 * best score comes from holding a big angle under control, not from spinning. Without that
 * upper falloff the optimizer would discover that a permanent spin scores highest.
 */
export function driftAngleQuality(bodySlipDeg: number): number {
  const angle = Math.abs(bodySlipDeg);
  if (angle < DRIFT_MIN_ANGLE_DEG || angle >= DRIFT_MAX_ANGLE_DEG) return 0;
  if (angle <= DRIFT_IDEAL_ANGLE_DEG) {
    return (angle - DRIFT_MIN_ANGLE_DEG) / (DRIFT_IDEAL_ANGLE_DEG - DRIFT_MIN_ANGLE_DEG);
  }
  return 1 - (angle - DRIFT_IDEAL_ANGLE_DEG) / (DRIFT_MAX_ANGLE_DEG - DRIFT_IDEAL_ANGLE_DEG);
}

/** Running state for one drift run. Reset it when the car is reset. */
export interface DriftScoreState {
  score: number;
  /** Seconds actually spent above the scoring angle — how much of a run was a drift. */
  driftSeconds: number;
  /**
   * Shaping signal, 0..1 per step, averaged by the caller.
   *
   * Quality is exactly zero below the threshold, which leaves the whole 0-15 degree range flat:
   * a car sliding at 9 degrees gets no indication that 10 would be better, so hill-climbing can
   * never find its way into the scoring zone. This ramps smoothly from 0 to 1 across that dead
   * band, giving the optimizer something to follow before any points are on offer.
   */
  engagementSum: number;
  samples: number;
  /** Seconds the current drift has been held without dropping below the threshold. */
  streakSeconds: number;
  /** Seconds since the angle last fell away, used to forgive brief transitions. */
  sinceActive: number;
  multiplier: number;
  active: boolean;
  bestStreakSeconds: number;
}

export function createDriftScoreState(): DriftScoreState {
  return {
    score: 0, driftSeconds: 0, engagementSum: 0, samples: 0,
    streakSeconds: 0, sinceActive: 0, multiplier: 1, active: false, bestStreakSeconds: 0,
  };
}

/** Average of the shaping signal over the run, 0..1. */
export function driftEngagement(state: DriftScoreState): number {
  return state.samples > 0 ? state.engagementSum / state.samples : 0;
}

/** Share of the run spent above the scoring angle, 0..1. */
export function driftTimeFraction(state: DriftScoreState, elapsedSeconds: number): number {
  return elapsedSeconds > 0 ? Math.min(1, state.driftSeconds / elapsedSeconds) : 0;
}

/**
 * Accumulates one step of drift score and returns the points earned.
 *
 * Points are angle quality times speed, so a slow slide is worth little and a fast one a lot.
 * Going off track scores nothing at all — otherwise the quickest route to a high score would be
 * to spin in the run-off rather than drive the course.
 *
 * The brief grace period is what lets a transition between corners count as one linked drift
 * rather than resetting the multiplier every time the car passes through straight.
 */
export function accumulateDrift(
  state: DriftScoreState,
  bodySlipDeg: number,
  speedMs: number,
  onTrack: boolean,
  dt: number
): number {
  const quality = onTrack ? driftAngleQuality(bodySlipDeg) : 0;

  state.samples++;
  state.engagementSum += onTrack
    ? Math.min(1, Math.abs(bodySlipDeg) / DRIFT_MIN_ANGLE_DEG)
    : 0;
  if (quality > 0) state.driftSeconds += dt;

  if (quality > 0) {
    state.streakSeconds += dt;
    state.sinceActive = 0;
    state.active = true;
  } else {
    state.sinceActive += dt;
    state.active = false;
    if (state.sinceActive > DRIFT_STREAK_GRACE_SECONDS) {
      state.streakSeconds = 0;
    }
  }

  state.bestStreakSeconds = Math.max(state.bestStreakSeconds, state.streakSeconds);
  const ramp = Math.min(1, state.streakSeconds / DRIFT_MULTIPLIER_RAMP_SECONDS);
  state.multiplier = 1 + ramp * (DRIFT_MAX_MULTIPLIER - 1);

  if (quality <= 0) return 0;

  const points = quality * speedMs * state.multiplier * dt;
  state.score += points;
  return points;
}
