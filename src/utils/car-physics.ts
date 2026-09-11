import { CarSettings } from '../services/car-settings.service';

export interface PerformanceMetrics {
  acceleration: number;
  topSpeed: number;
}

function toNumber(value: number | string | undefined, fallback = 0): number {
  const numericValue = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Everything the performance sweep depends on, as a key. The sweep integrates a 0-100 run and
 * a top-speed search, ~50 µs a call, and used to be re-run for every one of thousands of agents
 * on the grid; keyed by value rather than by object so an edited copy of a preset can never hit
 * a stale answer.
 */
function performanceKey(settings: CarSettings): string {
  return `${settings.mass}|${settings.enginePower}|${settings.dragCoeff}|${settings.frontalArea}|` +
    `${settings.tireGrip}|${settings.downforce}|${settings.finalDrive}|${settings.wheelbase}|` +
    `${settings.drivetrain}|${settings.differential}`;
}

const performanceCache = new Map<string, PerformanceMetrics>();

export function calculatePerformance(settings: CarSettings): PerformanceMetrics {
  const key = performanceKey(settings);
  const cached = performanceCache.get(key);
  if (cached) return cached;
  const metrics = computePerformance(settings);
  // A handful of presets and their edits; bounded so a slider sweep cannot grow it forever.
  if (performanceCache.size > 256) performanceCache.clear();
  performanceCache.set(key, metrics);
  return metrics;
}

function computePerformance(settings: CarSettings): PerformanceMetrics {
  const mass = toNumber(settings.mass);
  const powerW = toNumber(settings.enginePower) * 1000;
  const rho = 1.225;
  const Cd = toNumber(settings.dragCoeff);
  const A = toNumber(settings.frontalArea);
  const mu = Math.max(0.05, toNumber(settings.tireGrip));
  const downforce = toNumber(settings.downforce);
  const g = 9.81;
  const efficiency = 0.9;
  const driveRatio = toNumber(settings.finalDrive) / 3.8;

  const effectivePower = powerW * efficiency;
  const dragConst = 0.5 * rho * Cd * A;
  // Downforce grows with speed, so load, rolling drag and the traction limit all follow it.
  const loadAt = (v: number) => mass * g + downforce * Math.pow(v / (200 / 3.6), 2);

  /**
   * How much force the driven axle(s) can put down, allowing for the load that shifts rearward
   * as the car accelerates. This is why a front-driven car launches worse than a rear-driven one
   * with identical power: the axle doing the work is the one going light.
   *
   * The transfer depends on the acceleration it is limiting, so it is solved by a few passes.
   */
  const split = driveSplit(settings);
  const wheelbase = Math.max(1.2, toNumber(settings.wheelbase, 2.5));
  const tractionAt = (normalForce: number) => {
    let accel = 0;
    let limit = mu * normalForce;
    for (let pass = 0; pass < 4; pass++) {
      const transfer = mass * accel * 0.5 / wheelbase;
      const frontLoad = clamp(normalForce / 2 - transfer, normalForce * 0.05, normalForce);
      const rearLoad = clamp(normalForce / 2 + transfer, normalForce * 0.05, normalForce);
      const fromFront = split.front > 0 ? (mu * frontLoad) / split.front : Infinity;
      const fromRear = split.rear > 0 ? (mu * rearLoad) / split.rear : Infinity;
      limit = Math.min(fromFront, fromRear);
      accel = limit / Math.max(mass, 1);
    }
    return limit;
  };

  let vTop = 0;
  for (let v = 0; v < 120; v += 0.25) {
    const normalForce = loadAt(v);
    const dragForce = dragConst * v * v;
    const maxPowerForce = v > 1 ? effectivePower / v : effectivePower;
    const engineForce = Math.min(maxPowerForce * driveRatio, tractionAt(normalForce));
    const netForce = engineForce - dragForce - 0.015 * normalForce;
    if (netForce <= 0) break;
    vTop = v;
  }

  const targetSpeed = 100 / 3.6;
  let v = 0;
  let t = 0;
  const dt = 0.05;

  while (v < targetSpeed) {
    const normalForce = loadAt(v);
    const dragForce = dragConst * v * v;
    const maxPowerForce = v > 1 ? effectivePower / v : effectivePower;
    const driveForce = Math.min(maxPowerForce * driveRatio, tractionAt(normalForce));
    const netForce = driveForce - dragForce - 0.015 * normalForce;
    const accel = netForce > 0 ? netForce / Math.max(mass, 1) : 0;
    v += accel * dt;
    t += dt;
    if (t > 60) break;
  }

  return { acceleration: t, topSpeed: vTop * 3.6 };
}

export function getEffectiveGrip(settings: CarSettings, speed = 0, steeringInput = 0): number {
  const baseGrip = Math.max(0.05, toNumber(settings.tireGrip));
  const speedFactor = 1 - clamp((toNumber(speed) - 15) / 220, 0, 0.2);
  const steeringFactor = 1 - clamp(Math.abs(toNumber(steeringInput)) * 0.12, 0, 0.2);
  return baseGrip * speedFactor * steeringFactor;
}

export function maxLateralAcceleration(settings: CarSettings, speed = 0, steeringInput = 0): number {
  const g = 9.81;
  const grip = getEffectiveGrip(settings, speed, steeringInput);
  // Aero has to be read the same way here as in the physics step, or the optimizer's reference
  // lap describes a car that does not exist and every speed target is wrong at speed.
  const load = toNumber(settings.mass) * g + aeroDownforce(settings, speed);
  return grip * load / Math.max(toNumber(settings.mass), 1);
}

export function maxLongitudinalForce(settings: CarSettings, speed: number, throttle: number): number {
  const g = 9.81;
  const rho = 1.225;
  const normalForce = toNumber(settings.mass) * g + toNumber(settings.downforce);
  const maxTraction = getEffectiveGrip(settings, speed, 0) * normalForce;
  const powerW = toNumber(settings.enginePower) * 1000;
  const efficiency = 0.9;
  const driveRatio = toNumber(settings.finalDrive) / 3.8;
  const effectivePower = powerW * efficiency;
  const dragForce = 0.5 * rho * toNumber(settings.dragCoeff) * toNumber(settings.frontalArea) * speed * speed;
  const rollingResistance = 0.015 * normalForce;
  const engineForce = throttle * (speed > 1 ? effectivePower / speed : effectivePower) * driveRatio;
  return Math.max(0, Math.min(engineForce, maxTraction) - dragForce - rollingResistance);
}

export function calculateLongitudinalAcceleration(settings: CarSettings, speed: number, throttle: number, brake: number = 0): number {
  const g = 9.81;
  const rho = 1.225;
  const normalForce = toNumber(settings.mass) * g + toNumber(settings.downforce);
  const effectiveGrip = getEffectiveGrip(settings, speed, 0);
  const maxTraction = effectiveGrip * normalForce;
  const powerW = toNumber(settings.enginePower) * 1000;
  const efficiency = 0.9;
  const driveRatio = toNumber(settings.finalDrive) / 3.8;
  const effectivePower = powerW * efficiency;
  const dragForce = 0.5 * rho * toNumber(settings.dragCoeff) * toNumber(settings.frontalArea) * speed * speed;
  const rollingResistance = 0.015 * normalForce;
  const engineForce = throttle > 0 ? Math.min((speed > 1 ? effectivePower / speed : effectivePower) * driveRatio, maxTraction) * throttle : 0;
  const brakeForce = brake > 0 ? Math.min(brake * maxTraction, maxTraction) : 0;
  const netForce = engineForce - dragForce - rollingResistance - brakeForce;
  return netForce / Math.max(toNumber(settings.mass), 1);
}

export function calculateCorneringSpeedLimit(settings: CarSettings, curvature: number, speed = 0, steeringInput = 0): number {
  const maxLatAcc = maxLateralAcceleration(settings, speed, steeringInput);
  return Math.sqrt(maxLatAcc / Math.max(curvature, 0.0001));
}

export function maxBrakingDeceleration(settings: CarSettings): number {
  const g = 9.81;
  const normalForce = toNumber(settings.mass) * g + toNumber(settings.downforce);
  return getEffectiveGrip(settings, 0, 0) * normalForce / Math.max(toNumber(settings.mass), 1) * 0.85;
}

/** Physics traits derived from car model stats — used by AI agents during learning. */
export interface DrivingCharacteristics {
  offTrackGraceSeconds: number;
  carRadius: number;
  sensorRange: number;
}

export function getDrivingCharacteristics(settings: CarSettings): DrivingCharacteristics {
  const mass = Math.max(200, toNumber(settings.mass));
  const grip = Math.max(0.05, toNumber(settings.tireGrip));
  const downforce = toNumber(settings.downforce);
  const powerKw = toNumber(settings.enginePower);

  const carRadius = clamp(0.35 + mass / 3500, 0.32, 0.8);
  const offTrackGraceSeconds = clamp(1.5 + grip * 0.6 + mass / 10000, 1.5, 2.5);
  const sensorRange = clamp(22 + powerKw / 40 + downforce / 200, 22, 45);

  return {
    offTrackGraceSeconds,
    carRadius,
    sensorRange,
  };
}

/** Controls fed into the per-step vehicle dynamics integration. */
export interface VehicleControls {
  steer: number;   // -1..1, mapped to front wheel steer angle
  throttle: number; // 0..1
  brake: number;    // 0..1
}

/** Mutable state integrated by stepVehicleDynamics. */
export interface VehicleDynamicsState {
  x: number;
  y: number;
  heading: number;
  /** Forward (body-frame) velocity. Not the same as total speed once the car is sliding. */
  speed: number;
  yawRate: number;
  /**
   * Sideways (body-frame) velocity. This is the state that makes a slide possible: with it the
   * car can point somewhere other than where it is travelling.
   */
  lateralVelocity?: number;
}

export interface VehicleStepResult {
  frontUsage: number; // combined front-axle grip usage, ~1 = at the limit
  rearUsage: number;  // combined rear-axle grip usage, ~1 = at the limit
  longitudinalAccel: number;
  /** Lateral acceleration actually produced this step (m/s^2). */
  lateralAccel: number;
  /** The most lateral acceleration the tires could have produced, after longitudinal demands. */
  maxLateralAccel: number;
  /** Axle loads after longitudinal weight transfer (N) — what makes trail braking pay. */
  frontLoad: number;
  rearLoad: number;
  /** Longitudinal force contributions (N), for readouts that need the actual force split. */
  engineForce: number;
  brakeForce: number;
  dragForce: number;
  /** The front tires are past their peak: the car is running wide. */
  gripLimited: boolean;
  /** The rear tires are past their peak: the back is coming round. */
  oversteering: boolean;
  /** Angle between where the car points and where it is actually going (rad). A slide. */
  bodySlipAngle: number;
  /** Slip angles at each axle (rad) — the inputs the tires actually respond to. */
  frontSlipAngle: number;
  rearSlipAngle: number;
  /** Aerodynamic downforce at this speed (N). */
  downforce: number;
  /** Drive force actually reaching each axle (N) — shows what the layout and diff are doing. */
  frontDriveForce: number;
  rearDriveForce: number;
}

/**
 * Track-limit rules shared by the AI and the human driver.
 *
 * Both sides read these same numbers so a player's lap is judged exactly as an agent's is.
 * Duplicating them would let one side be tuned without the other, which would silently
 * invalidate every lap-time comparison between them.
 */
export const TRACK_LIMITS = {
  /** Grip falls from 1.0 to this floor across `gripRampMetres` beyond the edge. */
  offTrackGripFloor: 0.35,
  gripRampMetres: 0.5,
  /** Retired once this far past the edge — clearly in the barriers, not just a wide exit. */
  hardCutoffMetres: 8,
  /** A lap counts when the car is within this of the end and still pointing forward. */
  finishToleranceMetres: 6,
  /** Arc-length progress may not outrun distance actually travelled by more than this factor. */
  progressSlack: 1.4,
} as const;

/** Grip scale for a car this far beyond the edge — grass and gravel, not an instant stop. */
export function offTrackGripMultiplier(beyondEdge: number): number {
  if (beyondEdge <= 0) return 1;
  const t = clamp(beyondEdge / TRACK_LIMITS.gripRampMetres, 0, 1);
  return 1 - t * (1 - TRACK_LIMITS.offTrackGripFloor);
}

/** Fallback front-wheel steering angle at full lock (rad), for settings that predate the field. */
export const STEER_LOCK = 0.46;

/** This car's steering lock in radians — a real rack, not a yaw-rate request. */
export function steerLockOf(settings: CarSettings): number {
  const deg = toNumber(settings.steeringLockDeg, 0);
  if (!(deg > 0)) return STEER_LOCK;
  return clamp((deg * Math.PI) / 180, 0.15, 1.4);
}
const BRAKE_BIAS_FRONT = 0.6;
const CG_HEIGHT = 0.5; // m, fixed assumption — CarSettings carries no CG field

/**
 * Tire lateral-force curve shape (a reduced Pacejka "magic formula").
 *
 * Force rises steeply with slip angle, peaks around 8 degrees, then falls away. That falling
 * region is the whole point: past the peak a tire gives *less* grip the harder you ask, which is
 * what turns a slide into something you have to catch rather than something that self-corrects.
 */
const TIRE_STIFFNESS = 9.5;
const TIRE_SHAPE = 1.9;
/** Slip angle at which a tire peaks, used to report that an axle has let go. */
const TIRE_PEAK_SLIP = Math.atan(Math.tan(Math.PI / (2 * TIRE_SHAPE)) / TIRE_STIFFNESS);

/**
 * Grip still available once a tire is fully sliding, as a fraction of its peak.
 *
 * The shaped curve alone keeps falling with slip angle and is near zero by 90 degrees, which
 * makes a spun car frictionless — nothing is left to arrest the rotation, so every slide runs
 * away to a full spin and opposite lock does nothing. A tire sliding sideways is really just
 * skidding, and a skidding tire still returns most of its friction opposing the slide. Blending
 * the peaky curve into that plateau is what makes a slide catchable instead of terminal.
 */
const TIRE_SLIDE_GRIP = 0.78;
const SLIDE_BLEND_START = 0.30; // rad (~17 deg)
const SLIDE_BLEND_END = 0.70;   // rad (~40 deg)

/**
 * The dynamics are integrated at this many substeps per call.
 *
 * Tire forces are stiff: at 30 Hz a single explicit Euler step overshoots badly once the tires
 * saturate, and the car spirals into a spin no input can recover — which is how an earlier
 * attempt at a dynamic model failed. Substepping is what makes this stable.
 */
const PHYSICS_SUBSTEPS = 8;

/**
 * Slip angles are meaningless at a standstill (velocity divided by ~zero), so below
 * `KINEMATIC_FULL` the car steers geometrically and blends into the full dynamic model by
 * `DYNAMIC_FULL`. This also removes the standstill pirouette the previous model allowed.
 */
const KINEMATIC_FULL = 2.0;  // m/s
const DYNAMIC_FULL = 6.0;    // m/s

/**
 * Torque split for all-wheel drive. Performance AWD is normally rear-biased rather than 50/50,
 * so the car still rotates on throttle instead of ploughing straight on.
 */
const AWD_FRONT_TORQUE_SHARE = 0.4;

/**
 * How firmly a limited-slip diff ties an axle's two wheels together. 0 is an open diff, 1 a
 * solid spool; a road/race clutch-pack LSD sits around here.
 */
const LSD_LOCK = 0.6;

/**
 * Yaw moment an LSD produces per newton of drive force, scaled by track width.
 *
 * Tying the driven wheels together makes the inner wheel push as hard as the outer one, and the
 * corner wants them turning at different speeds. The resulting force imbalance across the axle
 * resists the turn — the planted, mildly understeering feel an LSD gives on power, and the thing
 * an open diff conspicuously does not do.
 */
const DIFF_YAW_COEFFICIENT = 0.12;

/** Track width, assumed from wheelbase — CarSettings carries no track measurement. */
const TRACK_WIDTH_RATIO = 0.58;

/** Fraction of engine torque reaching each axle for a given layout. */
export function driveSplit(settings: CarSettings): { front: number; rear: number } {
  switch (settings.drivetrain ?? 'rwd') {
    case 'fwd': return { front: 1, rear: 0 };
    case 'awd': return { front: AWD_FRONT_TORQUE_SHARE, rear: 1 - AWD_FRONT_TORQUE_SHARE };
    default: return { front: 0, rear: 1 };
  }
}

/** 0 for an open diff, LSD_LOCK for a limited-slip one. */
export function diffLocking(settings: CarSettings): number {
  return (settings.differential ?? 'lsd') === 'lsd' ? LSD_LOCK : 0;
}

/**
 * How much drive force an axle can actually put down, given that cornering has unloaded its
 * inner wheel.
 *
 * An open diff feeds both wheels equal torque, so the lightly loaded inner wheel spins first and
 * caps the whole axle at twice *its* grip. A limited-slip diff lets the loaded outer wheel take
 * up the slack, which is why an LSD car can get on the power so much earlier out of a corner.
 * At `lock` = 1 the axle uses its full load; at 0 it is limited by the inner wheel alone.
 */
export function axleTraction(mu: number, axleLoad: number, lateralTransfer: number, lock: number): number {
  const inner = Math.max(0, axleLoad / 2 - lateralTransfer / 2);
  const outer = Math.min(axleLoad, axleLoad / 2 + lateralTransfer / 2);
  return mu * (2 * inner + lock * (outer - inner));
}

/** Downforce in CarSettings is the figure produced at this speed; aero scales with v^2. */
const AERO_REFERENCE_SPEED = 200 / 3.6; // m/s

/** Lateral force from one axle at a given slip angle, saturating at mu*Fz. */
function tireLateralForce(slipAngle: number, mu: number, load: number): number {
  const shaped = Math.sin(TIRE_SHAPE * Math.atan(TIRE_STIFFNESS * slipAngle));
  const magnitude = Math.abs(slipAngle);
  const sliding = clamp(
    (magnitude - SLIDE_BLEND_START) / (SLIDE_BLEND_END - SLIDE_BLEND_START),
    0,
    1
  );
  const skid = Math.sign(slipAngle) * TIRE_SLIDE_GRIP;
  return -mu * load * (shaped * (1 - sliding) + skid * sliding);
}

/**
 * The largest steering angle still worth asking for at this speed.
 *
 * Past its peak slip angle a tire returns *less* force, so winding on more lock at speed turns
 * the car less, not more. A driver with a wheel never applies full lock at 140 km/h; they apply
 * the few degrees the front tire can still use. This returns that angle — roughly the tire's
 * peak slip plus the geometric steer the corner itself needs.
 *
 * It exists for input devices that only offer "pressed" or "not pressed". It caps what a key
 * press *asks for*; it adds no grip and changes no physics, and the AI, which commands a
 * continuous steering value, never goes near it.
 */
export function usefulSteerAngle(settings: CarSettings, speed: number): number {
  const wheelbase = Math.max(1.2, toNumber(settings.wheelbase, 2.5));
  const lateralLimit = Math.max(1, maxLateralAcceleration(settings, speed));
  const v = Math.max(speed, 1);
  return TIRE_PEAK_SLIP + (wheelbase * lateralLimit) / (v * v);
}

/**
 * Aerodynamic downforce at this speed.
 *
 * The `downforce` setting was previously added as a constant load at every speed, so a car had
 * exactly the same cornering grip at 30 km/h as at 300 and aero was effectively decorative.
 * Real downforce grows with the square of speed, which is why a fast car corners far harder in
 * a quick corner than a slow one. The setting is read as the downforce produced at 200 km/h.
 */
export function aeroDownforce(settings: CarSettings, speed: number): number {
  const rated = toNumber(settings.downforce);
  if (rated <= 0) return 0;
  const ratio = speed / AERO_REFERENCE_SPEED;
  return rated * ratio * ratio;
}

export function stepVehicleDynamics(
  state: VehicleDynamicsState,
  settings: CarSettings,
  controls: VehicleControls,
  dt: number,
  gripMultiplier = 1,
  maxSpeed = 120
): VehicleStepResult {
  const g = 9.81;
  const rho = 1.225;
  const mass = Math.max(200, toNumber(settings.mass));
  const wheelbase = Math.max(1.2, toNumber(settings.wheelbase, 2.5));
  // CG assumed centred, so each axle sits half a wheelbase away.
  const lengthFront = wheelbase / 2;
  const lengthRear = wheelbase / 2;
  // Yaw inertia from a radius of gyration of ~0.46 x wheelbase, the usual passenger-car figure.
  const yawInertia = mass * Math.pow(0.46 * wheelbase, 2);

  const grip = Math.max(0.05, toNumber(settings.tireGrip)) * clamp(gripMultiplier, 0.05, 1);
  const powerW = toNumber(settings.enginePower) * 1000;
  const efficiency = 0.9;
  const driveRatio = toNumber(settings.finalDrive) / 3.8;
  const effectivePower = powerW * efficiency;
  const dragConst = 0.5 * rho * toNumber(settings.dragCoeff) * toNumber(settings.frontalArea);
  const steerAngle = clamp(controls.steer, -1, 1) * steerLockOf(settings);

  let vx = Math.max(state.speed, 0);
  let vy = state.lateralVelocity ?? 0;
  let yawRate = state.yawRate;

  const sub = dt / PHYSICS_SUBSTEPS;

  // Reported values come from the final substep, which is the state the caller ends up with.
  let frontLoad = 0, rearLoad = 0, engineForce = 0, brakeForce = 0, dragForce = 0;
  let frontUsage = 0, rearUsage = 0, latAcc = 0, maxLatAcc = 0, longAccel = 0;
  let frontSlip = 0, rearSlip = 0, downforce = 0;
  let frontDrive = 0, rearDrive = 0;

  const split = driveSplit(settings);
  const lock = diffLocking(settings);
  const trackWidth = Math.max(1, wheelbase * TRACK_WIDTH_RATIO);
  // Seeded from the incoming state so the first substep already knows the car is cornering.
  let lateralAccelEstimate = Math.abs(yawRate * vx);

  for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
    const speed = Math.hypot(vx, vy);
    downforce = aeroDownforce(settings, speed);
    const staticLoad = mass * g + downforce;
    const loadFloor = staticLoad * 0.05;

    dragForce = dragConst * speed * speed;
    const rollingRes = 0.015 * staticLoad;
    // Resistances oppose the direction of travel rather than always pointing backwards along
    // the body, which matters the moment the car is no longer going where it is pointing.
    const dragX = -dragConst * speed * vx;
    const dragY = -dragConst * speed * vy;
    const rollX = -Math.sign(vx) * rollingRes * Math.min(1, Math.abs(vx));
    const wholeCarLimit = grip * staticLoad;
    const maxPowerForce = vx > 1 ? effectivePower / vx : effectivePower;

    // Pass 1: a rough longitudinal acceleration, only to size the weight transfer. Using the
    // result of pass 2 here would let an axle's own demand inflate its own load budget.
    const prelimEngine = controls.throttle > 0
      ? Math.min(maxPowerForce * driveRatio, wholeCarLimit) * controls.throttle
      : 0;
    const prelimBrake = controls.brake > 0 ? Math.min(controls.brake * wholeCarLimit, wholeCarLimit) : 0;
    const prelimAx = (prelimEngine - dragForce - rollingRes - prelimBrake) / mass;

    // Braking pitches load onto the front axle, accelerating onto the rear.
    const transfer = mass * prelimAx * CG_HEIGHT / wheelbase;
    frontLoad = clamp(staticLoad / 2 - transfer, loadFloor, staticLoad);
    rearLoad = clamp(staticLoad / 2 + transfer, loadFloor, staticLoad);

    const frontGripLimit = grip * frontLoad;
    const rearGripLimit = grip * rearLoad;

    // Lateral load transfer unloads the inside wheels, which is what makes the differential
    // matter at all. Taken from the previous substep's lateral acceleration, which at 8
    // substeps per frame is a close enough estimate and avoids a circular dependency.
    const lateralTransfer = mass * lateralAccelEstimate * CG_HEIGHT / trackWidth;
    const totalLoad = Math.max(frontLoad + rearLoad, 1);
    const frontLateralTransfer = lateralTransfer * (frontLoad / totalLoad);
    const rearLateralTransfer = lateralTransfer * (rearLoad / totalLoad);

    const frontTractionLimit = axleTraction(grip, frontLoad, frontLateralTransfer, lock);
    const rearTractionLimit = axleTraction(grip, rearLoad, rearLateralTransfer, lock);

    // Engine torque goes to whichever axles the layout drives, each capped by what that axle
    // can actually put down.
    const driveDemand = controls.throttle > 0 ? maxPowerForce * driveRatio * controls.throttle : 0;
    frontDrive = Math.min(driveDemand * split.front, frontTractionLimit);
    rearDrive = Math.min(driveDemand * split.rear, rearTractionLimit);
    engineForce = frontDrive + rearDrive;

    const frontBrake = controls.brake > 0
      ? Math.min(controls.brake * BRAKE_BIAS_FRONT * wholeCarLimit, frontGripLimit)
      : 0;
    const rearBrake = controls.brake > 0
      ? Math.min(controls.brake * (1 - BRAKE_BIAS_FRONT) * wholeCarLimit, rearGripLimit)
      : 0;
    brakeForce = frontBrake + rearBrake;

    // Longitudinal force each axle puts through its contact patch. Brakes resist whichever way
    // the car is actually rolling; they cannot drive it backwards.
    const rollDirection = Math.sign(vx) || 1;
    const brakeFade = Math.min(1, Math.abs(vx));
    // Front-driven axles spend their grip on traction as well as steering, which is exactly why
    // a front-wheel-drive car pushes wide when you get greedy with the throttle mid-corner.
    const frontLongForce = frontDrive - rollDirection * frontBrake * brakeFade;
    const rearLongForce = rearDrive - rollDirection * rearBrake * brakeFade;

    // Slip angles: the difference between where each axle points and where it is travelling.
    // The denominator is floored so the angle stays finite as the car comes to a stop.
    const vxSafe = Math.max(vx, 0.8);
    const alphaFront = Math.atan2(vy + lengthFront * yawRate, vxSafe) - steerAngle;
    const alphaRear = Math.atan2(vy - lengthRear * yawRate, vxSafe);

    // Friction ellipse: grip already spent going forwards or stopping cannot also be used to turn.
    const frontLongRatio = clamp(Math.abs(frontLongForce) / Math.max(frontGripLimit, 1), 0, 1);
    const rearLongRatio = clamp(Math.abs(rearLongForce) / Math.max(rearGripLimit, 1), 0, 1);
    const muFront = grip * Math.sqrt(Math.max(0, 1 - frontLongRatio * frontLongRatio));
    const muRear = grip * Math.sqrt(Math.max(0, 1 - rearLongRatio * rearLongRatio));

    const frontLatForce = tireLateralForce(alphaFront, muFront, frontLoad);
    const rearLatForce = tireLateralForce(alphaRear, muRear, rearLoad);

    const frontLatComponent = frontLatForce * Math.cos(steerAngle);
    const netLongForce = rearLongForce + frontLongForce
      - frontLatForce * Math.sin(steerAngle)
      + dragX + rollX;

    // Body-frame accelerations, including the centripetal cross terms.
    const ax = netLongForce / mass + yawRate * vy;
    const ay = (frontLatComponent + rearLatForce + dragY) / mass - yawRate * vx;
    // A limited-slip diff resists the wheel-speed difference a corner demands, which shows up
    // as a yaw moment opposing the turn. An open diff (lock = 0) contributes nothing here.
    const diffYawMoment = -Math.sign(yawRate) * lock * engineForce * trackWidth * DIFF_YAW_COEFFICIENT;
    const yawAcc =
      (lengthFront * frontLatComponent - lengthRear * rearLatForce + diffYawMoment) / yawInertia;

    // vx is NOT floored at zero: a car rotated past sideways is genuinely travelling backwards
    // along its own axis, and pinning it to zero deletes that momentum — which turned every
    // slide into a car that simply stopped and kept rotating, unable to be caught.
    vx += ax * sub;
    vy += ay * sub;
    yawRate += yawAcc * sub;

    // The speed ceiling applies to how fast the car is actually going, not to one component.
    const newSpeed = Math.hypot(vx, vy);
    if (newSpeed > maxSpeed) {
      vx *= maxSpeed / newSpeed;
      vy *= maxSpeed / newSpeed;
    }

    // Below walking pace a slip angle carries no information, so hand over to plain steering
    // geometry. This is also what stops a stationary car from spinning on the spot.
    const blend = clamp((Math.hypot(vx, vy) - KINEMATIC_FULL) / (DYNAMIC_FULL - KINEMATIC_FULL), 0, 1);
    if (blend < 1) {
      const kinematicYaw = (vx * Math.tan(steerAngle)) / wheelbase;
      yawRate = blend * yawRate + (1 - blend) * kinematicYaw;
      vy *= blend;
    }

    frontSlip = alphaFront;
    rearSlip = alphaRear;
    latAcc = Math.abs(frontLatComponent + rearLatForce) / mass;
    lateralAccelEstimate = latAcc;
    maxLatAcc = (muFront * frontLoad + muRear * rearLoad) / mass;
    longAccel = ax;
    frontUsage = Math.hypot(frontLongForce, frontLatForce) / Math.max(frontGripLimit, 1);
    rearUsage = Math.hypot(rearLongForce, rearLatForce) / Math.max(rearGripLimit, 1);
  }

  const heading = state.heading + yawRate * dt;
  // Velocity is in body coordinates, so a sliding car partly travels sideways.
  state.x += (vx * Math.cos(heading) - vy * Math.sin(heading)) * dt;
  state.y += (vx * Math.sin(heading) + vy * Math.cos(heading)) * dt;
  state.heading = heading;
  state.speed = vx;
  state.lateralVelocity = vy;
  state.yawRate = yawRate;

  return {
    frontUsage,
    rearUsage,
    longitudinalAccel: longAccel,
    lateralAccel: latAcc,
    maxLateralAccel: maxLatAcc,
    frontLoad,
    rearLoad,
    engineForce,
    brakeForce,
    dragForce,
    gripLimited: Math.abs(frontSlip) > TIRE_PEAK_SLIP,
    oversteering: Math.abs(rearSlip) > TIRE_PEAK_SLIP,
    bodySlipAngle: Math.atan2(vy, Math.max(vx, 0.1)),
    frontSlipAngle: frontSlip,
    rearSlipAngle: rearSlip,
    downforce,
    frontDriveForce: frontDrive,
    rearDriveForce: rearDrive,
  };
}
