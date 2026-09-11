import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { CarAgent } from '../models/CarAgent';
import { TrainingObjective } from '../utils/drift-scoring';
import { RacingLinePoint } from '../interfaces/car-state';
import { getTrackLength } from '../utils/track-utils';
import { TrackModel } from '../utils/track-geometry';
import { calculatePerformance } from '../utils/car-physics';
import { RacingLineOptimizerService } from './racing-line-optimizer.service';
import {
  AILearningConfig,
  AgentSnapshot,
  FieldSnapshot,
  GenerationOutcome,
  POSE_STRIDE,
  TrainingEngine,
  TrainingResult,
  TrainingRunInput,
  calculateSimulationSteps,
  driveTraining,
  spawnGenome,
} from '../training/training-engine';
import { TrainingCommand, TrainingEvent } from '../training/training-protocol';

export { calculateSimulationSteps };
export type { AILearningConfig, AgentSnapshot, TrainingResult };

export interface ModelRunResult {
  trajectory: RacingLinePoint[];
  lapTime: number;
  progress: number;
  completed: boolean;
}

export interface AIGenerationStats {
  generation: number;
  bestFitness: number;
  bestLapTime: number;
  bestProgress: number;
  aliveCount: number;
  averageFitness: number;
  active: boolean;
  carModel: string;
  /** Best drift score this generation. Meaningless (and zero) for grip runs. */
  bestDriftScore: number;
  objective: TrainingObjective;
}

export interface AITrainingHistoryEntry {
  runId: string;
  generation: number;
  bestFitness: number;
  bestLapTime: number;
  bestProgress: number;
  aliveCount: number;
  averageFitness: number;
  trajectory: Array<{ x: number; y: number; heading: number; s: number }>;
  /** The generation's best genome, kept small (~220 floats) so every checkpoint is extractable as a model. */
  weights: number[];
  bestDriftScore: number;
}

export interface AITrainingRun {
  id: string;
  label: string;
  startedAt: number;
  completedAt: number | null;
  generationCount: number;
  bestFitness: number;
  bestLapTime: number;
  bestProgress: number;
  aliveCount: number;
  averageFitness: number;
  entries: AITrainingHistoryEntry[];
  /** Provenance for anything extracted from this run as a model. */
  carSettings: CarSettings;
  trackLabel: string;
  trackLength: number;
  bestDriftScore: number;
  /** So a drift run is never silently compared against a grip one. */
  objective: TrainingObjective;
}

/**
 * Orchestrates training and publishes what the UI shows of it.
 *
 * The simulation itself runs in a Web Worker (`training.worker.ts`) so that a large grid never
 * competes with the renderer for the main thread: the service only relays poses, per-generation
 * outcomes and the two live knobs (speed, stop). Where workers are unavailable the same engine
 * runs inline, yielding between slices as before — slower to paint, but identical in result.
 */
@Injectable({ providedIn: 'root' })
export class AIDrivingService {
  private statsSubject = new BehaviorSubject<AIGenerationStats>({
    generation: 0,
    bestFitness: 0,
    bestLapTime: 0,
    bestProgress: 0,
    aliveCount: 0,
    averageFitness: 0,
    active: false,
    carModel: '',
    bestDriftScore: 0,
    objective: 'grip',
  });

  private populationSubject = new BehaviorSubject<AgentSnapshot[]>([]);
  stats$: Observable<AIGenerationStats> = this.statsSubject.asObservable();
  agents$: Observable<AgentSnapshot[]> = this.populationSubject.asObservable();
  private runsSubject = new BehaviorSubject<AITrainingRun[]>([]);
  runs$: Observable<AITrainingRun[]> = this.runsSubject.asObservable();
  private selectedHistoryEntrySubject = new BehaviorSubject<AITrainingHistoryEntry | null>(null);
  selectedHistoryEntry$: Observable<AITrainingHistoryEntry | null> = this.selectedHistoryEntrySubject.asObservable();
  private stopRequested = false;
  private trainingActive = false;
  /** The worker carrying the current run, if it is running off-thread. */
  private worker: Worker | null = null;

  /**
   * Pose views handed to the renderer. Reused across snapshots and mutated in place, so a
   * thirty-hertz stream of five thousand cars allocates nothing on the main thread.
   */
  private poseViews: AgentSnapshot[] = [];

  /**
   * The strip's Alive figure ticks down live during a generation, so a long one on a big grid
   * visibly makes progress. It goes through the zone (it is template-bound), so it is rate
   * limited well below the pose stream.
   */
  private lastLiveStatsAt = 0;
  private static readonly LIVE_STATS_INTERVAL_MS = 250;

  /**
   * How fast the simulation is allowed to run, as simulated seconds per real second.
   *
   * `Infinity` runs flat out, which is what a long training run wants — but with a handful of
   * cars a generation is then over before anything is visible on screen. Pacing the physics to
   * real time makes a small population watchable, and the value is read fresh on every step so
   * it can be changed while a run is in progress.
   */
  private speed = Number.POSITIVE_INFINITY;

  setTrainingSpeed(simulatedSecondsPerSecond: number) {
    this.speed = simulatedSecondsPerSecond > 0 ? simulatedSecondsPerSecond : Number.POSITIVE_INFINITY;
    this.send({ type: 'speed', speed: this.speed });
  }

  get trainingSpeed(): number {
    return this.speed;
  }

  constructor(
    private racingLineOptimizer: RacingLineOptimizerService,
    private ngZone: NgZone
  ) {}

  stopTraining() {
    this.stopRequested = true;
    this.send({ type: 'stop' });
    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });
  }

  clearHistory() {
    this.selectedHistoryEntrySubject.next(null);
  }

  async train(
    settings: CarSettings,
    trackModel: TrackModel,
    config: AILearningConfig,
    trackLabel = trackModel.label
  ): Promise<TrainingResult> {
    // A second concurrent run would interleave its generations into the same stats/population
    // streams as the first, making the reported progress of both incoherent.
    if (this.trainingActive) {
      return { bestAgents: [], bestGenome: null };
    }
    this.trainingActive = true;
    this.stopRequested = false;
    this.clearHistory();

    const objective: TrainingObjective = config.objective ?? 'grip';
    const centerline = trackModel.points;
    const trackLength = getTrackLength(centerline);

    // Reference speed profile/lap time used to shape the reward (see CarAgent.updateFitness) —
    // reuses the same optimizer the UI's racing-line display uses, computed once per run here
    // so the worker never needs the optimizer at all.
    const referenceLine = this.racingLineOptimizer.optimize(centerline, settings);

    const input: TrainingRunInput = {
      settings: { ...settings },
      track: { ...trackModel, points: trackModel.points.map(p => ({ ...p })) },
      config: { ...config, objective, seedWeights: config.seedWeights ? [...config.seedWeights] : null },
      referenceLine: { points: referenceLine.points.map(p => ({ ...p })), estimatedLapTime: referenceLine.estimatedLapTime },
    };

    const existingRuns = this.runsSubject.value;
    let currentRun: AITrainingRun = {
      id: crypto.randomUUID(),
      label: `${settings.name} · Run ${existingRuns.length + 1}`,
      startedAt: Date.now(),
      completedAt: null,
      generationCount: 0,
      bestFitness: 0,
      bestLapTime: 0,
      bestProgress: 0,
      aliveCount: 0,
      averageFitness: 0,
      bestDriftScore: 0,
      entries: [],
      carSettings: { ...settings },
      trackLabel,
      trackLength,
      objective,
    };
    this.runsSubject.next([...existingRuns, currentRun]);

    // The run is live from here, not from its first completed generation: the live alive count
    // republishes these stats during generation one, and must not flip the session back to idle.
    this.statsSubject.next({
      ...this.statsSubject.value,
      active: true,
      carModel: settings.name,
      objective,
    });

    const onGeneration = (outcome: GenerationOutcome) => {
      this.statsSubject.next({
        generation: outcome.generation,
        bestFitness: outcome.bestFitness,
        bestLapTime: outcome.bestLapTime,
        bestProgress: outcome.bestProgress,
        aliveCount: outcome.aliveCount,
        averageFitness: outcome.averageFitness,
        active: true,
        carModel: settings.name,
        bestDriftScore: outcome.bestDriftScore,
        objective,
      });

      const entry: AITrainingHistoryEntry = {
        runId: currentRun.id,
        generation: outcome.generation,
        bestFitness: outcome.bestFitness,
        bestLapTime: outcome.bestLapTime,
        bestProgress: outcome.bestProgress,
        aliveCount: outcome.aliveCount,
        averageFitness: outcome.averageFitness,
        trajectory: outcome.trajectory,
        weights: outcome.weights,
        bestDriftScore: outcome.bestDriftScore,
      };

      currentRun = {
        ...currentRun,
        generationCount: currentRun.generationCount + 1,
        bestFitness: outcome.bestFitness,
        bestLapTime: outcome.bestLapTime,
        bestProgress: outcome.bestProgress,
        aliveCount: outcome.aliveCount,
        averageFitness: outcome.averageFitness,
        // The headline drift figure is the best ever reached in the run, not the latest
        // generation's — a generation can regress without erasing what was achieved.
        bestDriftScore: Math.max(currentRun.bestDriftScore, outcome.bestDriftScore),
        entries: [...currentRun.entries, entry],
      };
      this.updateRun(currentRun);
    };

    let result: TrainingResult;
    try {
      result = await this.runOffThread(input, onGeneration)
        ?? await this.runInline(input, onGeneration);
    } finally {
      this.worker?.terminate();
      this.worker = null;
      this.trainingActive = false;
    }

    const lastEntry = currentRun.entries[currentRun.entries.length - 1];
    if (lastEntry) this.selectHistoryEntry(lastEntry);

    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });

    return result;
  }

  /**
   * Runs the session in a worker. Resolves to null — before any work has started — if the
   * environment has no workers, so the caller can fall back inline.
   */
  private runOffThread(
    input: TrainingRunInput,
    onGeneration: (outcome: GenerationOutcome) => void
  ): Promise<TrainingResult | null> {
    let worker: Worker;
    try {
      worker = createTrainingWorker();
    } catch {
      return Promise.resolve(null);
    }
    this.worker = worker;

    // Poses arrive tens of times a second and only feed the canvas, which repaints from its own
    // frame loop — so they are handled outside Angular and never trigger change detection.
    // Generation outcomes and completion do change what the templates show, so those re-enter.
    return this.ngZone.runOutsideAngular(() => new Promise<TrainingResult>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<TrainingEvent>) => {
        switch (data.type) {
          case 'field':
            this.publishField(data.snapshot);
            break;
          case 'generation':
            this.ngZone.run(() => onGeneration(data.outcome));
            break;
          case 'done':
            this.ngZone.run(() => resolve(data.result));
            break;
          case 'error':
            this.ngZone.run(() => reject(new Error(data.message)));
            break;
        }
      };
      worker.onerror = event => this.ngZone.run(() => reject(event.error ?? new Error(event.message)));

      const start: TrainingCommand = { type: 'start', input, speed: this.speed };
      worker.postMessage(start);
      // A stop asked for while the worker was still spinning up must not be lost.
      if (this.stopRequested) worker.postMessage({ type: 'stop' } satisfies TrainingCommand);
    }));
  }

  /** The same session on the main thread, for environments without workers. */
  private async runInline(
    input: TrainingRunInput,
    onGeneration: (outcome: GenerationOutcome) => void
  ): Promise<TrainingResult> {
    const engine = new TrainingEngine(input);
    await driveTraining(engine, {
      speed: () => this.speed,
      stopped: () => this.stopRequested,
      publish: snapshot => this.publishField(snapshot),
      onGeneration,
      yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    });
    return engine.result();
  }

  private send(command: TrainingCommand) {
    this.worker?.postMessage(command);
  }

  private publishField(snapshot: FieldSnapshot) {
    this.publishPoses(snapshot.poses);

    const now = performance.now();
    if (now - this.lastLiveStatsAt >= AIDrivingService.LIVE_STATS_INTERVAL_MS) {
      this.lastLiveStatsAt = now;
      const current = this.statsSubject.value;
      if (current.aliveCount !== snapshot.alive) {
        this.ngZone.run(() => this.statsSubject.next({ ...current, aliveCount: snapshot.alive }));
      }
    }
  }

  private publishPoses(poses: Float32Array) {
    const count = Math.floor(poses.length / POSE_STRIDE);
    if (this.poseViews.length !== count) {
      this.poseViews = Array.from({ length: count }, () => ({ state: { x: 0, y: 0, heading: 0, alive: true } }));
    }
    for (let i = 0; i < count; i++) {
      const base = i * POSE_STRIDE;
      const state = this.poseViews[i].state;
      state.x = poses[base];
      state.y = poses[base + 1];
      state.heading = poses[base + 2];
      state.alive = poses[base + 3] > 0.5;
    }
    this.populationSubject.next(this.poseViews);
  }

  /**
   * Drives one frozen genome (no evolution) around a track to completion or a timeout, for the
   * model comparer. Deliberately independent of `train()`'s stats/population streams — those
   * describe a live GA run, and interleaving a comparison pass into them while training is
   * active would corrupt what's reported for both. One car is cheap enough to stay on the main
   * thread, yielding occasionally so a long track doesn't block the UI.
   */
  async runGenomeOnTrack(
    weights: number[],
    settings: CarSettings,
    trackModel: TrackModel,
    objective: TrainingObjective = 'grip'
  ): Promise<ModelRunResult> {
    const track: TrackModel = { ...trackModel, points: trackModel.points.map(p => ({ ...p })) };
    const centerline = track.points;
    const trackLength = getTrackLength(centerline);
    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(8, perf.topSpeed / 3.6);
    const dt = 1 / 30;

    const optimalLine = this.racingLineOptimizer.optimize(centerline, settings);
    const steps = calculateSimulationSteps(trackLength, topSpeedMs, dt, optimalLine.estimatedLapTime);

    const agent = new CarAgent(spawnGenome([...weights]), settings, objective);
    agent.reset(track, optimalLine.points, optimalLine.estimatedLapTime);

    // Replay honours the same speed slider as training. At Max this runs flat out and only the
    // finished line is drawn, which is what a bulk comparison wants; at a real-time setting the
    // car is published as it goes, so a trained model can actually be watched driving instead of
    // only leaving a line behind.
    const runStart = performance.now();
    let lastSnapshot = 0;

    for (let step = 0; step < steps && agent.state.alive; step++) {
      agent.update(dt);

      const speed = this.speed;
      if (Number.isFinite(speed)) {
        const dueAt = runStart + ((step + 1) * dt * 1000) / speed;
        let waitMs = dueAt - performance.now();
        while (waitMs > 1) {
          const now = performance.now();
          if (now - lastSnapshot >= 40) {
            this.populationSubject.next([agent]);
            lastSnapshot = now;
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 16)));
          waitMs = dueAt - performance.now();
        }
      } else if (step % 500 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    this.populationSubject.next([agent]);

    return {
      trajectory: agent.trajectory,
      lapTime: agent.completedLap ? agent.state.lapTime : 0,
      progress: Math.round((agent.genome.progressRatio ?? 0) * 1000) / 10,
      completed: agent.completedLap,
    };
  }

  private updateRun(run: AITrainingRun) {
    this.runsSubject.next(this.runsSubject.value.map(existing => existing.id === run.id ? run : existing));
  }

  selectHistoryEntry(entry: AITrainingHistoryEntry) {
    this.selectedHistoryEntrySubject.next(entry);
  }
}

/**
 * Spins up the training worker. The `new URL(..., import.meta.url)` form is what the Angular
 * builder recognises to bundle the worker as its own entry point. Throws where workers do not
 * exist, which `train()` treats as "run inline".
 */
function createTrainingWorker(): Worker {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available');
  }
  return new Worker(new URL('../training/training.worker', import.meta.url), { type: 'module' });
}
