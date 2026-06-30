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
