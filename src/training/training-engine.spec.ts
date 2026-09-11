import { DEFAULT_CAR_SETTINGS } from '../services/car-settings.service';
import { createTrackModel } from '../utils/track-geometry';
import {
  GenerationOutcome,
  POSE_STRIDE,
  TrainingEngine,
  TrainingIO,
  TrainingRunInput,
  driveTraining,
} from './training-engine';

/** A gentle S-bend, ~120 m long, with a cheap straight-line reference so no optimizer is needed. */
function runInput(populationSize: number, generations: number): TrainingRunInput {
  const raw = Array.from({ length: 60 }, (_, i) => ({ x: i * 2, y: Math.sin(i / 8) * 6 }));
  const track = createTrackModel(raw, { halfWidth: 5, closed: false, label: 'S-bend' });
  return {
    settings: { ...DEFAULT_CAR_SETTINGS },
    track,
    config: { populationSize, generations, mutationRate: 0.2, objective: 'grip', seedWeights: null },
    referenceLine: { points: track.points, estimatedLapTime: 8 },
  };
}

/** An IO that runs flat out, never yields for real, and records what it is told. */
function recordingIO(overrides: Partial<TrainingIO> = {}) {
  const outcomes: GenerationOutcome[] = [];
  const poseLengths: number[] = [];
  const io: TrainingIO = {
    speed: () => Number.POSITIVE_INFINITY,
    stopped: () => false,
    publish: snapshot => { poseLengths.push(snapshot.poses.length); },
    onGeneration: outcome => { outcomes.push(outcome); },
    yield: () => Promise.resolve(),
    ...overrides,
  };
  return { io, outcomes, poseLengths };
}

describe('TrainingEngine', () => {
  it('runs exactly the configured number of generations and reports each once', async () => {
    const engine = new TrainingEngine(runInput(8, 3));
    const { io, outcomes, poseLengths } = recordingIO();

    const stopped = await driveTraining(engine, io);

    expect(stopped).toBeFalse();
    expect(outcomes.map(o => o.generation)).toEqual([1, 2, 3]);
    expect(poseLengths.length).toBeGreaterThan(0);
    expect(poseLengths.every(n => n === 8 * POSE_STRIDE)).toBeTrue();
  });

  it('carries throughput telemetry that adds up', async () => {
    const engine = new TrainingEngine(runInput(6, 1));
    const { io, outcomes } = recordingIO();

    await driveTraining(engine, io);

    const [outcome] = outcomes;
    expect(outcome.steps).toBeGreaterThan(0);
    expect(outcome.steps).toBeLessThanOrEqual(engine.simulationSteps);
    // Dead cars are skipped, so car-steps can never exceed cars × steps.
    expect(outcome.agentUpdates).toBeGreaterThan(0);
    expect(outcome.agentUpdates).toBeLessThanOrEqual(6 * outcome.steps);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('hands back a champion whose weights match the last reported generation', async () => {
    const engine = new TrainingEngine(runInput(6, 2));
    const { io, outcomes } = recordingIO();

    await driveTraining(engine, io);
    const result = engine.result();

    expect(result.bestAgents.length).toBe(1);
    expect(result.bestGenome).not.toBeNull();
    expect(result.bestAgents[0].genome.weights).toEqual(outcomes[outcomes.length - 1].weights);
  });

  it('halts within the generation when stopped and never reports the cut-off one', async () => {
    const engine = new TrainingEngine(runInput(6, 5));
    let stop = false;
    const { io, outcomes } = recordingIO({
      stopped: () => stop,
      // Ask for the stop as soon as the first generation has been reported.
      onGeneration: outcome => { outcomes.push(outcome); stop = true; },
    });

    const stopped = await driveTraining(engine, io);

    expect(stopped).toBeTrue();
    expect(outcomes.length).toBe(1);
    // The next grid is never even built once a stop is in.
    expect(engine.currentGeneration).toBe(1);
  });

  it('slices a step across the grid so a yield never has to wait for every car', () => {
    const engine = new TrainingEngine(runInput(100, 1));
    engine.startGeneration();

    expect(engine.atStepBoundary).toBeTrue();
    expect(engine.advanceSlice(64)).toBe('more');
    expect(engine.atStepBoundary).toBeFalse();
    expect(engine.advanceSlice(64)).toBe('step');
    expect(engine.atStepBoundary).toBeTrue();
    expect(engine.currentStep).toBe(1);
  });

  it('writes poses as [x, y, heading, alive] runs the renderer can read straight off', () => {
    const engine = new TrainingEngine(runInput(4, 1));
    engine.startGeneration();
    for (let i = 0; i < 10; i++) engine.advanceSlice(1000);

    const { poses, alive, step } = engine.snapshot();
    expect(poses.length).toBe(4 * POSE_STRIDE);
    expect(step).toBe(10);
    expect(alive).toBe(Array.from({ length: 4 }, (_, i) => poses[i * POSE_STRIDE + 3]).filter(a => a === 1).length);
    for (let i = 0; i < 4; i++) {
      const alive = poses[i * POSE_STRIDE + 3];
      expect(alive === 0 || alive === 1).toBeTrue();
      expect(Number.isFinite(poses[i * POSE_STRIDE])).toBeTrue();
      expect(Number.isFinite(poses[i * POSE_STRIDE + 2])).toBeTrue();
    }
  });
});
