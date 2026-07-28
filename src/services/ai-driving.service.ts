import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { CarAgent, AgentGenome, AI_INPUT_COUNT, AI_HIDDEN_SIZE } from '../models/CarAgent';
import { Segment } from '../models/Track';
import { buildTrackPath, getTrackLength } from '../utils/track-utils';
import { calculatePerformance } from '../utils/car-physics';
import { weightCount, outputBiasIndex } from '../utils/neural-policy';
import { RacingLineOptimizerService } from './racing-line-optimizer.service';

export interface AILearningConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
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
}

const GENOME_WEIGHT_COUNT = weightCount(AI_INPUT_COUNT, AI_HIDDEN_SIZE);

/** Default Gaussian step size for weight mutation, relative to typical weight magnitude (~0.25). */
const BASE_MUTATION_SIGMA = 0.12;

export function calculateSimulationSteps(
  trackLength: number,
  topSpeedMs: number,
  dt: number,
  minSteps = 1200
): number {
  const safeLength = Math.max(50, trackLength);
  const safeTopSpeed = Math.max(8, topSpeedMs);

  // Learning agents typically run ~35–55% of top speed while exploring.
  const learningSpeed = Math.max(4, safeTopSpeed * 0.45);
  const estimatedLapSeconds = safeLength / learningSpeed;
  const targetSeconds = Math.max(75, estimatedLapSeconds * 2.2);
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
  });

  private populationSubject = new BehaviorSubject<CarAgent[]>([]);
  stats$: Observable<AIGenerationStats> = this.statsSubject.asObservable();
  agents$: Observable<CarAgent[]> = this.populationSubject.asObservable();
  private runsSubject = new BehaviorSubject<AITrainingRun[]>([]);
  runs$: Observable<AITrainingRun[]> = this.runsSubject.asObservable();
  private selectedHistoryEntrySubject = new BehaviorSubject<AITrainingHistoryEntry | null>(null);
  selectedHistoryEntry$: Observable<AITrainingHistoryEntry | null> = this.selectedHistoryEntrySubject.asObservable();
  private stopRequested = false;

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
    segments: Segment[],
    config: AILearningConfig
  ): Promise<{ bestAgents: CarAgent[]; bestGenome: AgentGenome | null }> {
    this.stopRequested = false;
    this.clearHistory();

    const populationSize = Math.max(4, config.populationSize);
    const generations = Math.max(1, config.generations);
    const mutationRate = Math.max(0, Math.min(config.mutationRate, 1));

    let population: AgentGenome[] = Array.from({ length: populationSize }, () => this.createGenome());
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
      entries: [],
    };
    this.runsSubject.next([...existingRuns, currentRun]);

    let bestAgentSnapshot: { genome: AgentGenome; trajectory: CarAgent['trajectory']; state: CarAgent['state'] } | null = null;
    const centerline = buildTrackPath(segments, 2);
    const trackLength = getTrackLength(centerline);
    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(8, perf.topSpeed / 3.6);
    const dt = 1 / 30;
    const simulationSteps = calculateSimulationSteps(trackLength, topSpeedMs, dt);

    // Reference speed profile/lap time used to shape the reward (see CarAgent.updateFitness) —
    // reuses the same optimizer the UI's racing-line display uses, computed once per run since
    // the track/settings don't change mid-run.
    const optimalLine = this.racingLineOptimizer.optimize(centerline, settings);

    let bestFitnessEver = -Infinity;
    let stagnationCounter = 0;

    for (let generation = 1; generation <= generations; generation++) {
      if (this.stopRequested) break;

      const agents = population.map(genome => new CarAgent(this.cloneGenome(genome), settings));
      agents.forEach(agent => agent.reset(segments, optimalLine.points, optimalLine.estimatedLapTime));

      this.populationSubject.next(agents);
      await this.simulateAgents(agents, simulationSteps, dt);

      population = agents.map(agent => this.cloneGenome(agent.genome));
      population.sort((a, b) => this.compareGenomes(a, b));
      bestGenome = population[0];

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
      const stagnationLevel = Math.floor(stagnationCounter / 5);

      this.statsSubject.next({
        generation,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        bestProgress,
        aliveCount,
        averageFitness: roundedAverageFitness,
        active: true,
        carModel: settings.name,
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
      };

      currentRun = {
        ...currentRun,
        generationCount: currentRun.generationCount + 1,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        bestProgress,
        aliveCount,
        averageFitness: roundedAverageFitness,
        entries: [...currentRun.entries, entry],
      };
      this.updateRun(currentRun);

      if (generation === generations || this.stopRequested) break;

      population = this.evolvePopulation(population, mutationRate, stagnationLevel);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    let bestAgents: CarAgent[] = [];
    if (bestAgentSnapshot) {
      const agent = new CarAgent(this.cloneGenome(bestAgentSnapshot.genome), settings);
      agent.reset(segments, optimalLine.points, optimalLine.estimatedLapTime);
      agent.trajectory = bestAgentSnapshot.trajectory.map(point => ({ ...point }));
      agent.state = { ...bestAgentSnapshot.state };
      bestAgents = [agent];
    } else if (bestGenome) {
      bestAgents = [new CarAgent(this.cloneGenome(bestGenome), settings)];
      bestAgents[0].reset(segments, optimalLine.points, optimalLine.estimatedLapTime);
    }

    const lastEntry = currentRun.entries[currentRun.entries.length - 1];
    if (lastEntry) this.selectHistoryEntry(lastEntry);

    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });

    return { bestAgents, bestGenome };
  }

  /**
   * Finishers first, then straight fitness. Ranking on progressRatio ahead of fitness meant an
   * agent that got a centimetre further always beat a cleaner, faster one, so no amount of
   * reward shaping could express a preference for a better racing line. Progress still leads
   * in practice because it is the dominant term inside fitness.
   */
  private compareGenomes(a: AgentGenome, b: AgentGenome): number {
    if (a.completedLap !== b.completedLap) return a.completedLap ? -1 : 1;
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
    };
  }

  private async simulateAgents(agents: CarAgent[], steps: number, dt: number) {
    const renderEvery = 4;
    for (let step = 0; step < steps; step++) {
      if (this.stopRequested) break;

      let anyActive = false;
      agents.forEach(agent => {
        if (agent.state.alive) {
          agent.update(dt);
          anyActive = true;
        }
      });

      // Keep running the full budget so surviving agents have time to finish long tracks.
      if (!anyActive) break;

      if (step % renderEvery === 0) {
        this.populationSubject.next(agents);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    this.populationSubject.next(agents);
  }

  private evolvePopulation(population: AgentGenome[], mutationRate: number, stagnationLevel = 0): AgentGenome[] {
    const sorted = [...population].sort((a, b) => this.compareGenomes(a, b));
    const size = sorted.length;

    // Step size grows while a run is stuck so the search widens, but stays small by default so
    // the leaders can be refined in fine increments.
    const sigma = Math.min(0.5, BASE_MUTATION_SIGMA * (1 + stagnationLevel * 0.6));

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
    const leaderPool = Math.max(1, Math.floor(size * 0.2));
    const refineCount = Math.floor(size * 0.4);
    const scales = [0.25, 0.5, 1, 2];
    for (let i = 0; i < refineCount && next.length < size; i++) {
      const parent = sorted[i % leaderPool];
      const scale = scales[i % scales.length];
      next.push(this.spawnGenome(parent.weights.map(w => this.mutateWeight(w, 0.6, sigma * scale))));
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

    const mutationMultiplier = Math.min(4, 1 + stagnationLevel * 0.6);
    const effectiveMutationRate = Math.min(1, mutationRate * mutationMultiplier);

    while (next.length < size) {
      const parentA = this.selectParent(sorted);
      const parentB = this.selectParent(sorted);
      // Uniform (per-weight) crossover: each weight comes wholly from one parent or the other.
      // Arithmetic averaging tends to dilute both parents' successful patterns into a blend
      // that has neither — uniform crossover preserves each parent's actual "building blocks".
      const childWeights = parentA.weights.map((weight, i) => Math.random() < 0.5 ? weight : parentB.weights[i]);
      next.push(this.spawnGenome(childWeights.map(w => this.mutateWeight(w, effectiveMutationRate, sigma))));
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
