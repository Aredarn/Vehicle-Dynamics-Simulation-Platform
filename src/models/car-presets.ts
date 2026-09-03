import { CarSettings } from '../services/car-settings.service';

export interface CarPreset {
  id: string;
  name: string;
  description: string;
  color: [string, string];
  settings: Omit<CarSettings, 'name' | 'presetId'>;
}

export const CAR_PRESETS: CarPreset[] = [
  {
    id: 'city',
    name: 'City Car',
    description: 'Compact urban hatchback',
    color: ['#64748b', '#94a3b8'],
    settings: {
      mass: 1200,
      enginePower: 80,
      dragCoeff: 0.32,
      frontalArea: 2.1,
      tireGrip: 0.75,
      downforce: 0,
      finalDrive: 4.2,
      wheelbase: 2.5,
      drivetrain: 'fwd',
      differential: 'open',
      steeringLockDeg: 26,
    },
  },
  {
    id: 'sport',
    name: 'Sport Sedan',
    description: 'Performance road car',
    color: ['#dc2626', '#ef4444'],
    settings: {
      mass: 1450,
      enginePower: 280,
      dragCoeff: 0.28,
      frontalArea: 2.0,
      tireGrip: 0.95,
      downforce: 150,
      finalDrive: 3.6,
      wheelbase: 2.7,
      drivetrain: 'rwd',
      differential: 'lsd',
      steeringLockDeg: 26,
    },
  },
  {
    id: 'gt3',
    name: 'GT3 Race Car',
    description: 'GT3 endurance racer',
    color: ['#2563eb', '#3b82f6'],
    settings: {
      mass: 1300,
      enginePower: 405,
      dragCoeff: 0.35,
      frontalArea: 1.9,
      tireGrip: 1.4,
      downforce: 600,
      finalDrive: 3.4,
      wheelbase: 2.6,
      drivetrain: 'rwd',
      differential: 'lsd',
      steeringLockDeg: 26,
    },
  },
  {
    id: 'formula-student',
    name: 'Formula Student',
    description: 'Open-wheel student formula',
    color: ['#16a34a', '#22c55e'],
    settings: {
      mass: 230,
      enginePower: 60,
      dragCoeff: 0.85,
      frontalArea: 1.1,
      tireGrip: 1.6,
      downforce: 400,
      finalDrive: 3.0,
      wheelbase: 1.53,
      drivetrain: 'rwd',
      differential: 'lsd',
      steeringLockDeg: 26,
    },
  },
  {
    id: 'lmp1',
    name: 'LMP1 Prototype',
    description: 'Le Mans prototype',
    color: ['#7c3aed', '#a78bfa'],
    settings: {
      mass: 900,
      enginePower: 650,
      dragCoeff: 0.38,
      frontalArea: 1.7,
      tireGrip: 1.8,
      downforce: 1200,
      finalDrive: 3.2,
      wheelbase: 2.9,
      drivetrain: 'rwd',
      differential: 'lsd',
      steeringLockDeg: 26,
    },
  },
  {
    id: 'hypercar',
    name: 'Hypercar',
    description: 'Track-focused hypercar',
    color: ['#d97706', '#f59e0b'],
    settings: {
      mass: 1100,
      enginePower: 750,
      dragCoeff: 0.30,
      frontalArea: 1.85,
      tireGrip: 1.5,
      downforce: 900,
      finalDrive: 3.5,
      wheelbase: 2.65,
      drivetrain: 'awd',
      differential: 'lsd',
      steeringLockDeg: 26,
    },
  },
];

export function getPresetById(id: string): CarPreset | undefined {
  return CAR_PRESETS.find(p => p.id === id);
}
