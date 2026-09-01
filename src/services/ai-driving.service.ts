import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { CarAgent, AgentGenome, AI_INPUT_COUNT, AI_HIDDEN_SIZE } from '../models/CarAgent';
import { TrainingObjective } from '../utils/drift-scoring';
import { RacingLinePoint } from '../interfaces/car-state';
import { getTrackLength } from '../utils/track-utils';
import { TrackModel } from '../utils/track-geometry';
import { calculatePerformance } from '../utils/car-physics';
import { weightCount, outputBiasIndex } from '../utils/neural-policy';
import { RacingLineOptimizerService } from './racing-line-optimizer.service';

export interface AILearningConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
  /** What the population is being scored for. Defaults to the existing grip behaviour. */
  objective?: TrainingObjective;
  /** Start the population from a previously trained model instead of random weights. */
  seedWeights?: number[] | null;
}

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

const GENOME_WEIGHT_COUNT = weightCount(AI_INPUT_COUNT, AI_HIDDEN_SIZE);

/** Default Gaussian step size for weight mutation, relative to typical weight magnitude (~0.25). */
const BASE_MUTATION_SIGMA = 0.12;

/**
 * Time budget per generation, in steps.
 *
 * Prefer `referenceLapSeconds` (the optimizer's near-ideal lap time), because it accounts for
 * how slow the actual corners are. Deriving the budget from a fraction of straight-line top
 * speed badly overestimates average pace on a twisty layout, so on larger tracks the clock ran
 * out mid-lap: agents were still alive at the end having never crossed the line, which made a
 * completed lap — and therefore any lap-time optimization — impossible to ever observe.
 */
export function calculateSimulationSteps(
  trackLength: number,
  topSpeedMs: number,
  dt: number,
  referenceLapSeconds = 0,
  minSteps = 1200,
  /**
   * Drifting a lap takes far longer than driving it quickly. On the grip budget a drift agent
   * simply ran out of clock mid-lap, so completing the course — and every term that depends on
   * progress — stayed out of reach no matter how well it drifted.
   */
  budgetMultiplier = 1
): number {
  const safeLength = Math.max(50, trackLength);
  const safeTopSpeed = Math.max(8, topSpeedMs);

  // A learning agent laps well off the ideal pace, so allow a generous multiple of it.
  const estimatedLapSeconds = referenceLapSeconds > 0
    ? referenceLapSeconds * 3
    : (safeLength / Math.max(4, safeTopSpeed * 0.45)) * 2.2;

  const targetSeconds = Math.max(75, estimatedLapSeconds) * Math.max(1, budgetMultiplier);
  return Math.max(minSteps, Math.ceil(targetSeconds / dt));
}

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

  /** What the current run is being ranked for. Set for the duration of `train()`. */
  private rankingObjective: TrainingObjective = 'grip';

  private populationSubject = new BehaviorSubject<CarAgent[]>([]);
  stats$: Observable<AIGenerationStats> = this.statsSubject.asObservable();
  agents$: Observable<CarAgent[]> = this.populationSubject.asObservable();
  private runsSubject = new BehaviorSubject<AITrainingRun[]>([]);
  runs$: Observable<AITrainingRun[]> = this.runsSubject.asObservable();
  private selectedHistoryEntrySubject = new BehaviorSubject<AITrainingHistoryEntry | null>(null);
  selectedHistoryEntry$: Observable<AITrainingHistoryEntry | null> = this.selectedHistoryEntrySubject.asObservable();
  private stopRequested = false;
  private trainingActive = false;

  constructor(private racingLineOptimizer: RacingLineOptimizerService) {}

  stopTraining() {
    this.stopRequested = true;
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
  ): Promise<{ bestAgents: CarAgent[]; bestGenome: AgentGenome | null }> {
    // A second concurrent run would interleave its generations into the same stats/population
    // streams as the first, making the reported progress of both incoherent.
    if (this.trainingActive) {
      return { bestAgents: [], bestGenome: null };
    }
    this.trainingActive = true;
    this.stopRequested = false;
    this.clearHistory();

    const populationSize = Math.max(4, config.populationSize);
    const generations = Math.max(1, config.generations);
    const mutationRate = Math.max(0, Math.min(config.mutationRate, 1));
    const objective: TrainingObjective = config.objective ?? 'grip';
    this.rankingObjective = objective;

    // Freeze the layout for the whole run. The editor rebuilds its model on every change, but
    // snapshotting here keeps a run immune to edits regardless: an edit mid-run would otherwise
    // change trackLength underneath the agents, and because progressRatio is measured against
    // that length the same driving would suddenly score far lower.
    const track: TrackModel = { ...trackModel, points: trackModel.points.map(p => ({ ...p })) };

    const centerline = track.points;
    const trackLength = getTrackLength(centerline);
    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(8, perf.topSpeed / 3.6);
    const dt = 1 / 30;

    // Reference speed profile/lap time used to shape the reward (see CarAgent.updateFitness) —
    // reuses the same optimizer the UI's racing-line display uses, computed once per run.
    const optimalLine = this.racingLineOptimizer.optimize(centerline, settings);
    const simulationSteps = calculateSimulationSteps(
      trackLength, topSpeedMs, dt, optimalLine.estimatedLapTime, 1200,
      objective === 'drift' ? 1.8 : 1
    );

    // Seeding from a saved model starts the population at (and around) an already-competent
    // driver instead of from scratch, so training the same model on a different track adapts it
    // rather than relearning it — this is what makes "teach on different tracks" meaningfully
    // faster than a fresh run.
    let population: AgentGenome[] = config.seedWeights && config.seedWeights.length === GENOME_WEIGHT_COUNT
      ? this.buildSeededPopulation(config.seedWeights, populationSize)
      : Array.from({ length: populationSize }, () => this.createGenome());
    let bestGenome: AgentGenome | null = null;

    const existingRuns = this.runsSubject.value;
    const runLabel = `${settings.name} · Run ${existingRuns.length + 1}`;
    let currentRun: AITrainingRun = {
      id: crypto.randomUUID(),
      label: runLabel,
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

    let bestAgentSnapshot: { genome: AgentGenome; trajectory: CarAgent['trajectory']; state: CarAgent['state'] } | null = null;
    let bestFitnessEver = -Infinity;
    let stagnationCounter = 0;
    // Carried forward every generation so the best genome found can never be lost.
    let hallOfFame: AgentGenome | null = null;

    for (let generation = 1; generation <= generations; generation++) {
      if (this.stopRequested) break;

      const agents = population.map(genome => new CarAgent(this.cloneGenome(genome), settings, objective));
      agents.forEach(agent => agent.reset(track, optimalLine.points, optimalLine.estimatedLapTime));

      this.populationSubject.next(agents);
      await this.simulateAgents(agents, simulationSteps, dt);

      // Stopping cuts the simulation short part-way through the generation, so every agent is
      // frozen mid-lap: none have finished, most are still "alive", and their fitness reflects
      // however far they happened to get. Recording that as a generation made a stopped run
      // look like it had collapsed — the exported history ended on a truncated result far worse
      // than anything the run actually produced.
      if (this.stopRequested) break;

      population = agents.map(agent => this.cloneGenome(agent.genome));
      population.sort((a, b) => this.compareGenomes(a, b));
      bestGenome = population[0];

      if (bestGenome && (!hallOfFame || this.compareGenomes(bestGenome, hallOfFame) < 0)) {
        hallOfFame = this.cloneGenome(bestGenome);
      }

      const bestAgent = agents.reduce((best, agent) =>
        this.compareGenomes(agent.genome, best.genome) < 0 ? agent : best, agents[0]);

      if (bestAgent) {
        bestAgentSnapshot = {
          genome: this.cloneGenome(bestAgent.genome),
          trajectory: bestAgent.trajectory.map(point => ({ ...point })),
          state: { ...bestAgent.state },
        };
      }

      const averageFitness = population.reduce((sum, g) => sum + g.fitness, 0) / population.length;
      const aliveCount = population.filter(g => g.alive).length;
      const bestLapTime = bestGenome.completedLap ? bestGenome.lapTime : 0;
      const bestProgress = Math.round((bestGenome.progressRatio ?? 0) * 1000) / 10;
      const roundedBestFitness = Math.round(bestGenome.fitness * 100) / 100;
      const roundedAverageFitness = Math.round(averageFitness * 100) / 100;
      const roundedBestLapTime = Math.round(bestLapTime * 100) / 100;
      const bestDriftScore = Math.round((bestGenome.driftScore ?? 0) * 10) / 10;

      if (roundedBestFitness > bestFitnessEver + 1) {
        bestFitnessEver = roundedBestFitness;
        stagnationCounter = 0;
      } else {
        stagnationCounter++;
      }
      // Escalates the longer fitness stays flat, instead of firing one boosted generation every
      // 5 stagnant generations and immediately reverting regardless of whether it worked — a
      // stubborn plateau now gets a progressively stronger push rather than the same weak nudge
      // repeated. Only resets on a genuine improvement, above.
      //
      // Capped: an uncapped level ratchets up for as long as the run is stuck, and since the
      // incumbent is preserved and re-scored deterministically it can never be dislodged by the
      // resulting noise, so the escalation never stands down. Beyond a few levels more randomness
      // does not buy more exploration, it just erases the population.
      const stagnationLevel = Math.min(3, Math.floor(stagnationCounter / 5));

      this.statsSubject.next({
        generation,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        bestProgress,
        aliveCount,
        averageFitness: roundedAverageFitness,
        active: true,
        carModel: settings.name,
        bestDriftScore,
        objective,
      });

      const entry: AITrainingHistoryEntry = {
        runId: currentRun.id,
        generation,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        bestProgress,
        aliveCount,
        averageFitness: roundedAverageFitness,
        trajectory: bestAgentSnapshot?.trajectory ?? [],
        weights: bestAgentSnapshot ? [...bestAgentSnapshot.genome.weights] : [],
        bestDriftScore,
      };

      currentRun = {
        ...currentRun,
        generationCount: currentRun.generationCount + 1,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        bestProgress,
        aliveCount,
        averageFitness: roundedAverageFitness,
        // The headline drift figure is the best ever reached in the run, not the latest
        // generation's — a generation can regress without erasing what was achieved.
        bestDriftScore: Math.max(currentRun.bestDriftScore, bestDriftScore),
        entries: [...currentRun.entries, entry],
      };
      this.updateRun(currentRun);

      if (generation === generations || this.stopRequested) break;

      population = this.evolvePopulation(population, mutationRate, stagnationLevel);
      // Re-seat the all-time best. Ordinary elitism already preserves it while the inputs hold
      // still, but this makes "the best never regresses" true by construction.
      if (hallOfFame && population.length) {
        population[population.length - 1] = this.cloneGenome(hallOfFame);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    let bestAgents: CarAgent[] = [];
    if (bestAgentSnapshot) {
      const agent = new CarAgent(this.cloneGenome(bestAgentSnapshot.genome), settings, objective);
      agent.reset(track, optimalLine.points, optimalLine.estimatedLapTime);
      agent.trajectory = bestAgentSnapshot.trajectory.map(point => ({ ...point }));
      agent.state = { ...bestAgentSnapshot.state };
      bestAgents = [agent];
    } else if (bestGenome) {
      bestAgents = [new CarAgent(this.cloneGenome(bestGenome), settings, objective)];
      bestAgents[0].reset(track, optimalLine.points, optimalLine.estimatedLapTime);
    }

    const lastEntry = currentRun.entries[currentRun.entries.length - 1];
    if (lastEntry) this.selectHistoryEntry(lastEntry);

    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });

    this.trainingActive = false;
    return { bestAgents, bestGenome };
  }

  /**
   * Drives one frozen genome (no evolution) around a track to completion or a timeout, for the
   * model comparer. Deliberately independent of `train()`'s stats/population streams — those
   * describe a live GA run, and interleaving a comparison pass into them while training is
   * active would corrupt what's reported for both. It also doesn't need the time-sliced yielding
   * `simulateAgents` uses for large populations; one agent per call is cheap enough to just run
   * to completion, yielding occasionally so a long track doesn't block the UI.
   */
  async runGenomeOnTrack(weights: number[], settings: CarSettings, trackModel: TrackModel): Promise<ModelRunResult> {
    const track: TrackModel = { ...trackModel, points: trackModel.points.map(p => ({ ...p })) };
    const centerline = track.points;
    const trackLength = getTrackLength(centerline);
    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(8, perf.topSpeed / 3.6);
    const dt = 1 / 30;

    const optimalLine = this.racingLineOptimizer.optimize(centerline, settings);
    const steps = calculateSimulationSteps(trackLength, topSpeedMs, dt, optimalLine.estimatedLapTime);

    const agent = new CarAgent(this.spawnGenome([...weights]), settings);
    agent.reset(track, optimalLine.points, optimalLine.estimatedLapTime);

    for (let step = 0; step < steps && agent.state.alive; step++) {
      agent.update(dt);
      if (step % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }

    return {
      trajectory: agent.trajectory,
      lapTime: agent.completedLap ? agent.state.lapTime : 0,
      progress: Math.round((agent.genome.progressRatio ?? 0) * 1000) / 10,
      completed: agent.completedLap,
    };
  }

  /**
   * Finishers first, then straight fitness. Ranking on progressRatio ahead of fitness meant an
   * agent that got a centimetre further always beat a cleaner, faster one, so no amount of
   * reward shaping could express a preference for a better racing line. Progress still leads
   * in practice because it is the dominant term inside fitness.
   */
  /**
   * Ranking used for the champion, the hall of fame and elite selection alike.
   *
   * Completing the lap is an absolute tie-break for GRIP: finishing is the objective, and the
   * reward already scores a finisher above a non-finisher, so the two agree.
   *
   * For DRIFT they disagree, and letting completion win overrode the entire objective. A car
   * that completed a lap without ever going sideways outranked one that drifted superbly and
   * ran out of road — so the moment any agent finished, it became champion, displaced the far
   * better drifter from the hall of fame, and could never be displaced back, because the
   * drifter does not finish. The population was then bred toward completing laps rather than
   * drifting, and the reported best fitness fell generation after generation. Drift runs are
   * therefore ranked on fitness alone, which already accounts for finishing: the completion
   * bonus is paid in proportion to how much of the lap was actually spent sideways.
   */
  private compareGenomes(a: AgentGenome, b: AgentGenome): number {
    if (this.rankingObjective !== 'drift' && a.completedLap !== b.completedLap) {
      return a.completedLap ? -1 : 1;
    }
    return b.fitness - a.fitness;
  }

  private cloneGenome(genome: AgentGenome): AgentGenome {
    return {
      ...genome,
      weights: [...genome.weights],
    };
  }

  private updateRun(run: AITrainingRun) {
    this.runsSubject.next(this.runsSubject.value.map(existing => existing.id === run.id ? run : existing));
  }

  selectHistoryEntry(entry: AITrainingHistoryEntry) {
    this.selectedHistoryEntrySubject.next(entry);
  }

  private createGenome(): AgentGenome {
    const weights = Array.from({ length: GENOME_WEIGHT_COUNT }, () => (Math.random() * 2 - 1) * 0.4);

    // Bias the throttle/brake output neurons toward "go" so early generations explore
    // forward motion instead of idling. Output order from runPolicy is [steer, throttle, brake].
    weights[outputBiasIndex(AI_INPUT_COUNT, AI_HIDDEN_SIZE, 1)] += 1;
    weights[outputBiasIndex(AI_INPUT_COUNT, AI_HIDDEN_SIZE, 2)] -= 1;

    return {
      weights,
      fitness: 0,
      distance: 0,
      lapTime: 0,
      alive: true,
      maxProgress: 0,
      progressRatio: 0,
      completedLap: false,
      driftScore: 0,
    };
  }

  private async simulateAgents(agents: CarAgent[], steps: number, dt: number) {
    // Yielding on a step count breaks down as the population grows: with a thousand cars a
    // single step is tens of milliseconds, so any fixed number of steps between yields locks
    // the main thread for hundreds of milliseconds and the UI drops to a few frames a second.
    //
    // Budget by elapsed time instead, and — because agents never interact — advance a step in
    // slices, yielding part-way through when the budget is spent. Results are identical; only
    // the interleaving changes.
    const FRAME_BUDGET_MS = 8;
    const SNAPSHOT_INTERVAL_MS = 60;
    const SLICE = 64;

    let sliceStart = performance.now();
    let lastSnapshot = 0;

    for (let step = 0; step < steps; step++) {
      if (this.stopRequested) break;

      let anyActive = false;

      for (let i = 0; i < agents.length;) {
        const end = Math.min(agents.length, i + SLICE);
        for (; i < end; i++) {
          const agent = agents[i];
          if (agent.state.alive) {
            agent.update(dt);
            anyActive = true;
          }
        }

        if (performance.now() - sliceStart >= FRAME_BUDGET_MS) {
          // Repainting the field is far cheaper than simulating it, but each push runs change
          // detection, so cap it well below the yield rate.
          const now = performance.now();
          if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
            this.populationSubject.next(agents);
            lastSnapshot = now;
          }
          await new Promise(resolve => setTimeout(resolve, 0));
          sliceStart = performance.now();
        }
      }

      // Keep running the full budget so surviving agents have time to finish long tracks.
      if (!anyActive) break;
    }

    this.populationSubject.next(agents);
  }

  /**
   * Starts a run from a previously trained model instead of random weights: the seed itself
   * plus mutated variants of it at a few step sizes, rather than `populationSize` independent
   * random points. The new track's evolutionary pressure then adapts an already-competent
   * driver instead of relearning one from scratch.
   */
  private buildSeededPopulation(seedWeights: number[], size: number): AgentGenome[] {
    const population: AgentGenome[] = [this.spawnGenome([...seedWeights])];
    const scales = [0.15, 0.3, 0.6, 1];
    for (let i = 1; i < size; i++) {
      const scale = scales[i % scales.length];
      population.push(this.spawnGenome(
        seedWeights.map(w => this.mutateWeight(w, 0.5, BASE_MUTATION_SIGMA * scale))
      ));
    }
    return population;
  }

  private evolvePopulation(population: AgentGenome[], mutationRate: number, stagnationLevel = 0): AgentGenome[] {
    const sorted = [...population].sort((a, b) => this.compareGenomes(a, b));
    const size = sorted.length;

    // Only the *exploration* step size grows while a run is stuck, and only modestly. Typical
    // weight magnitude is ~0.25, so a sigma near or above that randomizes a weight rather than
    // adjusting it — the previous ceiling of 0.5 (and up to 1.0 once the refine band's ×2 scale
    // was applied) turned the whole grid into noise on a long plateau. Since noise can never
    // beat the incumbent, stagnation then fed on itself: more flat generations produced more
    // noise, which guaranteed more flat generations, and the population average fell steadily
    // while the same elite sat on top.
    const exploreSigma = Math.min(0.25, BASE_MUTATION_SIGMA * (1 + stagnationLevel * 0.4));

    // Only a couple of untouched clones. The simulation is deterministic, so an exact elite
    // re-drives a bit-identical lap every generation — keeping 20% of the grid as exact copies
    // meant a fifth of the field was visibly frozen and burning compute on a known result.
    const eliteCount = Math.max(1, Math.floor(size * 0.08));
    const next: AgentGenome[] = sorted.slice(0, eliteCount).map(g => this.cloneGenome(g));

    // Hill-climbing band: mutants of the current leaders across several step sizes at once.
    // This is the gradual refinement path — without it the only route to a better genome was a
    // large lucky mutation, which is why gains arrived as sudden jumps rather than steady
    // improvement. Probing multiple scales together means a plateau gets both fine polish and
    // bolder nudges in the same generation, instead of betting the whole grid on one step size.
    // Deliberately independent of stagnationLevel: local search has to stay local to work. It is
    // the mechanism that produces steady gains, so scaling it up on a plateau destroyed the one
    // thing capable of escaping the plateau. A lower per-weight rate also keeps each child a
    // small edit of its parent rather than a wholesale rewrite.
    const leaderPool = Math.max(1, Math.floor(size * 0.2));
    const refineCount = Math.floor(size * 0.4);
    const scales = [0.25, 0.5, 1, 1.5];
    for (let i = 0; i < refineCount && next.length < size; i++) {
      const parent = sorted[i % leaderPool];
      const scale = scales[i % scales.length];
      next.push(this.spawnGenome(
        parent.weights.map(w => this.mutateWeight(w, 0.35, BASE_MUTATION_SIGMA * scale))
      ));
    }

    // Fresh blood keeps some diversity, but stays a small minority: a random point in a
    // ~220-dimensional weight space essentially never drives well, so scaling this up on a
    // plateau just replaced working genetic material with noise and dragged the population
    // average down without ever helping the leader.
    const injectFraction = Math.min(0.15, 0.05 + stagnationLevel * 0.03);
    const injectCount = Math.floor(size * injectFraction);
    for (let i = 0; i < injectCount && next.length < size; i++) {
      next.push(this.createGenome());
    }

    // Capped well below 1: at a rate of 1 every weight of every child is perturbed at once, which
    // is a new random genome wearing its parents' name rather than a recombination of them.
    const mutationMultiplier = Math.min(2, 1 + stagnationLevel * 0.25);
    const effectiveMutationRate = Math.min(0.6, mutationRate * mutationMultiplier);

    while (next.length < size) {
      const parentA = this.selectParent(sorted);
      const parentB = this.selectParent(sorted);
      // Uniform (per-weight) crossover: each weight comes wholly from one parent or the other.
      // Arithmetic averaging tends to dilute both parents' successful patterns into a blend
      // that has neither — uniform crossover preserves each parent's actual "building blocks".
      const childWeights = parentA.weights.map((weight, i) => Math.random() < 0.5 ? weight : parentB.weights[i]);
      next.push(this.spawnGenome(childWeights.map(w => this.mutateWeight(w, effectiveMutationRate, exploreSigma))));
    }

    return next;
  }

  private selectParent(sorted: AgentGenome[]): AgentGenome {
    const tournamentSize = 3;
    let best = sorted[Math.floor(Math.random() * sorted.length)];
    for (let i = 1; i < tournamentSize; i++) {
      const candidate = sorted[Math.floor(Math.random() * sorted.length)];
      if (this.compareGenomes(candidate, best) < 0) best = candidate;
    }
    return best;
  }

  private spawnGenome(weights: number[]): AgentGenome {
    return {
      weights,
      fitness: 0,
      distance: 0,
      lapTime: 0,
      alive: true,
      maxProgress: 0,
      progressRatio: 0,
      completedLap: false,
      driftScore: 0,
    };
  }

  /**
   * Gaussian perturbation, mostly in small steps. The previous uniform ±0.6 kick was 2–3x the
   * typical weight magnitude (mean |w| ≈ 0.25), so a "mutation" effectively randomized the
   * weight rather than adjusting it — there was no way to fine-tune a nearly-good policy, only
   * to destroy it or get lucky. Occasional large jumps preserve the ability to escape a basin.
   */
  private mutateWeight(value: number, mutationRate: number, sigma = BASE_MUTATION_SIGMA): number {
    if (Math.random() >= mutationRate) return value;
    const scale = Math.random() < 0.1 ? sigma * 5 : sigma;
    return value + this.gaussianRandom() * scale;
  }

  private gaussianRandom(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
