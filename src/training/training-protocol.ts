/**
 * The messages that cross the worker boundary. Everything in them is structured-clone safe:
 * plain objects, arrays, numbers (including `Infinity` for an unpaced run) and one
 * `Float32Array` of poses that is transferred rather than copied.
 */
import type { FieldSnapshot, GenerationOutcome, TrainingResult, TrainingRunInput } from './training-engine';

export type TrainingCommand =
  | { type: 'start'; input: TrainingRunInput; speed: number }
  | { type: 'speed'; speed: number }
  | { type: 'stop' };

export type TrainingEvent =
  /** The field as it stands. */
  | { type: 'field'; snapshot: FieldSnapshot }
  | { type: 'generation'; outcome: GenerationOutcome }
  | { type: 'done'; result: TrainingResult; stopped: boolean }
  | { type: 'error'; message: string };
