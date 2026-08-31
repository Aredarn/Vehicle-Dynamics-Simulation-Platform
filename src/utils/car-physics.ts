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

export function calculatePerformance(settings: CarSettings): PerformanceMetrics {
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
  const normalForce = mass * g + downforce;
  const dragConst = 0.5 * rho * Cd * A;
  const rollingRes = 0.015 * normalForce;
  const tractionLimit = mu * normalForce;

  let vTop = 0;
  for (let v = 0; v < 120; v += 0.25) {
    const dragForce = dragConst * v * v;
    const maxPowerForce = v > 1 ? effectivePower / v : effectivePower;
    const engineForce = Math.min(maxPowerForce * driveRatio, tractionLimit);
    const netForce = engineForce - dragForce - rollingRes;
    if (netForce <= 0) break;
    vTop = v;
  }

  const targetSpeed = 100 / 3.6;
  let v = 0;
  let t = 0;
  const dt = 0.05;

  while (v < targetSpeed) {
    const dragForce = dragConst * v * v;
    const maxPowerForce = v > 1 ? effectivePower / v : effectivePower;
    const driveForce = Math.min(maxPowerForce * driveRatio, tractionLimit);
    const netForce = driveForce - dragForce - rollingRes;
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
  return grip * (toNumber(settings.mass) * g + toNumber(settings.downforce)) / Math.max(toNumber(settings.mass), 1);
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
  speed: number;
  yawRate: number;
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
  /** Steering asked for more yaw than grip allowed, so the car ran wide instead: understeer. */
  gripLimited: boolean;
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

const BASE_STEER_RATE = 2.2; // rad/s, max commanded yaw rate at full steering lock and no grip limit
const BRAKE_BIAS_FRONT = 0.6;
const CG_HEIGHT = 0.5; // m, fixed assumption — CarSettings carries no CG field

/**
 * Advances the car by dt, mutating `state` in place. Longitudinal weight transfer shifts load
 * between axles under braking/acceleration — this is what makes trail braking (extra front
 * grip while turning in, at the cost of some of the front tire's braking budget) a real
 * physical trade-off rather than a scripted bonus, and what makes trading off throttle/brake
 * against steering angle matter at all.
 *
 * Yaw is integrated kinematically (heading follows a commanded yaw rate, clamped by whatever
 * lateral grip the axles have left after their longitudinal demands) rather than as a free
 * dynamic slip-angle state — a full 2-DOF dynamic bicycle model is notoriously sensitive to
 * tuning (cornering stiffness, yaw inertia, damping) and easily diverges into an unrecoverable
 * spin from a near-straight input once tires saturate; that instability made the GA's reward
 * landscape a cliff instead of a slope. This keeps the physically real part (grip is a shared,
 * load-dependent budget between braking/accelerating and turning) without that failure mode.
 * `gripMultiplier` scales tire friction for both axles — used to model reduced grip when off
 * the track surface (grass/gravel) instead of an arbitrary speed decay.
 */
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
  const downforce = toNumber(settings.downforce);
  const staticLoad = mass * g + downforce;
  const loadFloor = staticLoad * 0.05;

  const grip = Math.max(0.05, toNumber(settings.tireGrip)) * clamp(gripMultiplier, 0.05, 1);

  const vx = Math.max(state.speed, 0);

  const powerW = toNumber(settings.enginePower) * 1000;
  const efficiency = 0.9;
  const driveRatio = toNumber(settings.finalDrive) / 3.8;
  const effectivePower = powerW * efficiency;
  const dragConst = 0.5 * rho * toNumber(settings.dragCoeff) * toNumber(settings.frontalArea);
  const dragForce = dragConst * vx * vx;
  const rollingRes = 0.015 * staticLoad;
  const wholeCarLimit = grip * staticLoad;
  const maxPowerForce = vx > 1 ? effectivePower / vx : effectivePower;

  // Pass 1: rough accel estimate against the whole car's traction budget, just to size the
  // weight transfer below. Using this (rather than static 50/50 load) for the *actual* axle
  // force budgets in pass 2 would let the drive axle's own request inflate its own budget.
  const prelimEngineForce = controls.throttle > 0
    ? Math.min(maxPowerForce * driveRatio, wholeCarLimit) * controls.throttle
    : 0;
  const prelimBrakeForce = controls.brake > 0 ? Math.min(controls.brake * wholeCarLimit, wholeCarLimit) : 0;
  const prelimAx = (prelimEngineForce - dragForce - rollingRes - prelimBrakeForce) / mass;

  // Braking (ax < 0) transfers load to the front axle; accelerating loads the rear.
  const transfer = mass * prelimAx * CG_HEIGHT / wheelbase;
  const frontLoad = clamp(staticLoad / 2 - transfer, loadFloor, staticLoad);
  const rearLoad = clamp(staticLoad / 2 + transfer, loadFloor, staticLoad);

  // Pass 2: clamp drive/brake force to what each axle's own (transfer-adjusted) grip budget
  // allows — this is what lets braking-induced front load actually buy extra front braking
  // capacity, and rear load under acceleration buy extra traction, instead of the whole-car
  // budget being consumed entirely by one axle and starving its lateral grip.
  const frontBrakeLimit = grip * frontLoad;
  const rearBrakeLimit = grip * rearLoad;

  const engineForce = controls.throttle > 0
    ? Math.min(maxPowerForce * driveRatio, rearBrakeLimit) * controls.throttle
    : 0;
  const frontBrakeForce = controls.brake > 0
    ? Math.min(controls.brake * BRAKE_BIAS_FRONT * wholeCarLimit, frontBrakeLimit)
    : 0;
  const rearBrakeForce = controls.brake > 0
    ? Math.min(controls.brake * (1 - BRAKE_BIAS_FRONT) * wholeCarLimit, rearBrakeLimit)
    : 0;
  const brakeForce = frontBrakeForce + rearBrakeForce;

  const netLongForce = engineForce - dragForce - rollingRes - brakeForce;
  const ax = netLongForce / mass;

  const frontLongForce = frontBrakeForce;
  const rearLongForce = engineForce + rearBrakeForce;

  const frontLongUsage = frontLongForce / Math.max(frontBrakeLimit, 1);
  const rearLongUsage = rearLongForce / Math.max(rearBrakeLimit, 1);

  const frontLatCapacity = Math.sqrt(Math.max(0, 1 - frontLongUsage * frontLongUsage)) * grip * frontLoad;
  const rearLatCapacity = Math.sqrt(Math.max(0, 1 - rearLongUsage * rearLongUsage)) * grip * rearLoad;

  // Available lateral grip (both axles, net of whatever braking/traction is already using)
  // bounds how fast the car can actually rotate at this speed — this is the friction-circle
  // coupling: the same weight-transfer-boosted front load that helps trail braking only helps
  // if there's grip left over after braking to spend on turning.
  const maxLatAcc = (frontLatCapacity + rearLatCapacity) / mass;
  const desiredYawRate = clamp(controls.steer, -1, 1) * BASE_STEER_RATE;
  const maxYawRateFromGrip = vx > 0.5 ? maxLatAcc / vx : BASE_STEER_RATE;
  const yawRate = clamp(desiredYawRate, -maxYawRateFromGrip, maxYawRateFromGrip);

  const latAccUsed = Math.abs(yawRate) * vx;
  const gripUsedRatio = maxLatAcc > 0 ? clamp(latAccUsed / maxLatAcc, 0, 1) : 0;
  const longGripScale = Math.sqrt(Math.max(0, 1 - gripUsedRatio * gripUsedRatio));

  const nextVx = clamp(vx + ax * longGripScale * dt, 0, maxSpeed);
  const nextHeading = state.heading + yawRate * dt;

  state.x += nextVx * Math.cos(nextHeading) * dt;
  state.y += nextVx * Math.sin(nextHeading) * dt;
  state.heading = nextHeading;
  state.speed = nextVx;
  state.yawRate = yawRate;

  // Usage relative to each axle's *original* (un-reduced) circular grip budget: lateral usage
  // is measured against the capacity already left over after longitudinal use, so combining
  // the two via a plain hypot would double-count and could exceed 1 even within the limit.
  const frontUsage = Math.sqrt(frontLongUsage * frontLongUsage + gripUsedRatio * gripUsedRatio * (1 - frontLongUsage * frontLongUsage));
  const rearUsage = Math.sqrt(rearLongUsage * rearLongUsage + gripUsedRatio * gripUsedRatio * (1 - rearLongUsage * rearLongUsage));

  return {
    frontUsage,
    rearUsage,
    longitudinalAccel: ax * longGripScale,
    lateralAccel: latAccUsed,
    maxLateralAccel: maxLatAcc,
    frontLoad,
    rearLoad,
    engineForce,
    brakeForce,
    dragForce,
    gripLimited: Math.abs(desiredYawRate) > maxYawRateFromGrip + 1e-9,
  };
}
