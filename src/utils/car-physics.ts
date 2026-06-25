import { CarSettings } from '../services/car-settings.service';

export interface PerformanceMetrics {
  acceleration: number;
  topSpeed: number;
}

export function calculatePerformance(settings: CarSettings): PerformanceMetrics {
  const mass = settings.mass;
  const powerW = settings.enginePower * 1000;
  const rho = 1.225;
  const Cd = settings.dragCoeff;
  const A = settings.frontalArea;
  const mu = settings.tireGrip;
  const downforce = settings.downforce;
  const g = 9.81;
  const efficiency = 0.9;
  const driveRatio = settings.finalDrive / 3.8;

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
    const accel = netForce > 0 ? netForce / mass : 0;
    v += accel * dt;
    t += dt;
    if (t > 60) break;
  }

  return { acceleration: t, topSpeed: vTop * 3.6 };
}

export function maxLateralAcceleration(settings: CarSettings): number {
  const g = 9.81;
  return settings.tireGrip * (settings.mass * g + settings.downforce) / settings.mass;
}

export function maxLongitudinalForce(settings: CarSettings, speed: number, throttle: number): number {
  const g = 9.81;
  const rho = 1.225;
  const normalForce = settings.mass * g + settings.downforce;
  const maxTraction = settings.tireGrip * normalForce;
  const powerW = settings.enginePower * 1000;
  const efficiency = 0.9;
  const driveRatio = settings.finalDrive / 3.8;
  const effectivePower = powerW * efficiency;
  const dragForce = 0.5 * rho * settings.dragCoeff * settings.frontalArea * speed * speed;
  const rollingResistance = 0.015 * normalForce;
  const engineForce = throttle * (speed > 1 ? effectivePower / speed : effectivePower) * driveRatio;
  return Math.max(0, Math.min(engineForce, maxTraction) - dragForce - rollingResistance);
}

export function maxBrakingDeceleration(settings: CarSettings): number {
  const g = 9.81;
  const normalForce = settings.mass * g + settings.downforce;
  return settings.tireGrip * normalForce / settings.mass * 0.85;
}
