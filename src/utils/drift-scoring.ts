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

/**
 * How long the angle may drop out before a run is considered broken.
 *
 * Long enough to cover a real transition, so swapping the slide from one side to the other on an
 * alternating track counts as one linked drift rather than two separate ones.
 */
export const DRIFT_STREAK_GRACE_SECONDS = 0.6;

/** Above this curvature the track is a corner with a direction, not effectively a straight. */
export const DRIFT_CORNER_CURVATURE = 0.008;

/**
 * What a slide going the *wrong way* for the corner is worth, as a fraction of full credit.
 *
 * Without this, sliding left through a right-hander scored exactly as much as sliding left
 * through a left-hander, so committing to a single direction and running out of road at the next
 * corner was a perfectly good strategy — and it is what the optimizer kept settling on. Drifting
 * a course means sliding *into* each corner, which forces the transitions that make the second
 * corner reachable at all.
 */
export const DRIFT_WRONG_WAY_CREDIT = 0.15;

/**
 * What a slide down a *straight* is worth, as a fraction of a proper corner drift.
 *
 * Drifting a course means drifting its corners. Paying full credit for angle held anywhere meant
 * a layout that is two-thirds straight could be farmed by sliding one way along the straights and
 * never dealing with a corner at all — which is exactly what kept being bred, and why a car would
 * slide beautifully in one direction and then simply run out of road at the first corner going
 * the other way. Kept well above zero because transitions happen on the short straights between
 * corners, and those should still pay.
 */
export const DRIFT_STRAIGHT_CREDIT = 0.35;

/**
 * How far the car's nose may stray from the track direction before a slide stops counting.
 *
 * Expressed as cos(heading error): full credit while the nose is within ~49 degrees of the way
 * the road goes, fading to nothing by ~84 degrees.
 *
 * This is what separates drifting from looping. Points are earned per metre of track advanced,
 * so a car that spirals slowly along a straight holds maximum angle for *every* metre it covers
 * — the best possible points-per-metre, which no honest lap can match, because a real lap has
 * straights where the car is not sideways. The difference is the nose: through a drift it keeps
 * pointing broadly down the road, while through a loop it sweeps across and back up the track.
 */
export const DRIFT_ALIGN_FULL = 0.65;
export const DRIFT_ALIGN_NONE = 0.1;

/** 0..1 credit for the car still facing down the track while it slides. */
export function driftHeadingFactor(forwardAlignment: number): number {
  const span = DRIFT_ALIGN_FULL - DRIFT_ALIGN_NONE;
  return Math.max(0, Math.min(1, (forwardAlignment - DRIFT_ALIGN_NONE) / span));
}

/** Points awarded for linking a drift into the opposite direction — the hard part. */
export const DRIFT_TRANSITION_BONUS = 12;

/**
 * How much credit a slide earns for going the right way into the corner it is in.
 *
 * On a straight there is no wrong way, so any direction scores fully; the factor tapers in as
 * the corner tightens. A left corner has positive curvature and is drifted with negative body
 * slip (the car points further left than it travels), which is the convention the physics
 * produces.
 */
export function driftDirectionFactor(bodySlipDeg: number, signedCurvature: number): number {
  const cornering = Math.min(1, Math.abs(signedCurvature) / DRIFT_CORNER_CURVATURE);
  const wantedSign = -Math.sign(signedCurvature);
  const goingTheRightWay = bodySlipDeg !== 0 && Math.sign(bodySlipDeg) === wantedSign;
  const cornerCredit = goingTheRightWay ? 1 : DRIFT_WRONG_WAY_CREDIT;
  // Blends from straight-line credit into full corner credit as the corner tightens.
  return DRIFT_STRAIGHT_CREDIT + cornering * (cornerCredit - DRIFT_STRAIGHT_CREDIT);
}
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
  /** Direction of the last scoring slide, so linking into the opposite one can be spotted. */
  lastActiveSign: number;
  /** Completed changes of direction while still drifting — the linked-corner count. */
  transitions: number;
}

export function createDriftScoreState(): DriftScoreState {
  return {
    score: 0, driftSeconds: 0, engagementSum: 0, samples: 0,
    streakSeconds: 0, sinceActive: 0, multiplier: 1, active: false, bestStreakSeconds: 0,
    lastActiveSign: 0, transitions: 0,
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
 * Points are angle quality times the metres of *track* the car covered this step — not the
 * metres it travelled. Those are the same thing when drifting down a road and wildly different
 * when spinning on the spot: a donut travels plenty of distance, advances nothing, and holds a
 * constant angle that also maxes out the streak multiplier. Scoring progress instead of distance
 * makes donuts worth nothing without needing a rule that special-cases them, and it keeps speed
 * rewarded, since a faster car covers more track per second.
 *
 * Going off track scores nothing at all — otherwise the quickest route to a high score would be
 * to spin in the run-off rather than drive the course.
 *
 * The brief grace period is what lets a transition between corners count as one linked drift
 * rather than resetting the multiplier every time the car passes through straight.
 */
export function accumulateDrift(
  state: DriftScoreState,
  bodySlipDeg: number,
  /** Metres of track advanced this step, already capped against corner-cutting. */
  advanceMetres: number,
  onTrack: boolean,
  dt: number,
  /** Signed curvature of the track here: positive turns left, negative right. */
  signedCurvature = 0,
  /** cos of the angle between where the car points and where the track goes. */
  forwardAlignment = 1
): number {
  const facingDownTrack = driftHeadingFactor(forwardAlignment);
  const quality = onTrack
    ? driftAngleQuality(bodySlipDeg)
      * driftDirectionFactor(bodySlipDeg, signedCurvature)
      * facingDownTrack
    : 0;

  state.samples++;
  // The shaping is gated the same way, or a looping car simply farms that instead.
  state.engagementSum += onTrack
    ? Math.min(1, Math.abs(bodySlipDeg) / DRIFT_MIN_ANGLE_DEG) * facingDownTrack
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

  // Linking into the opposite direction is the hard part of drifting a course, and the only way
  // to carry a slide through corners that alternate. It is worth points in its own right.
  const sign = Math.sign(bodySlipDeg);
  let bonus = 0;
  if (sign !== 0 && state.lastActiveSign !== 0 && sign !== state.lastActiveSign) {
    state.transitions++;
    bonus = DRIFT_TRANSITION_BONUS * quality;
  }
  if (sign !== 0) state.lastActiveSign = sign;

  const points = quality * Math.max(0, advanceMetres) * state.multiplier + bonus;
  state.score += points;
  return points;
}
