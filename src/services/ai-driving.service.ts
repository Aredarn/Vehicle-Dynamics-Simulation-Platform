import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { CarAgent, AgentGenome } from '../models/CarAgent';
import { Segment } from '../models/Track';
import { buildTrackPath, getTrackLength } from '../utils/track-utils';
import { calculatePerformance } from '../utils/car-physics';

export interface AILearningConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
}

export interface AIGenerationStats {
  generation: number;
  bestFitness: number;
  bestLapTime: number;
  aliveCount: number;
  averageFitness: number;
  active: boolean;
}

export interface AITrainingHistoryEntry {
  runId: string;
  generation: number;
  bestFitness: number;
  bestLapTime: number;
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
  aliveCount: number;
  averageFitness: number;
  entries: AITrainingHistoryEntry[];
}

export function calculateSimulationSteps(trackLength: number, averageSpeed: number, dt: number, minSteps = 900): number {
  const safeTrackLength = Math.max(0, trackLength);
  const safeAverageSpeed = Math.max(1, averageSpeed);
  const targetDurationSeconds = Math.max(20, safeTrackLength / safeAverageSpeed);
  return Math.max(minSteps, Math.ceil(targetDurationSeconds / dt));
}

@Injectable({ providedIn: 'root' })
export class AIDrivingService {
  private statsSubject = new BehaviorSubject<AIGenerationStats>({
    generation: 0,
    bestFitness: 0,
    bestLapTime: 0,
    aliveCount: 0,
    averageFitness: 0,
    active: false,
  });

  private populationSubject = new BehaviorSubject<CarAgent[]>([]);
  stats$: Observable<AIGenerationStats> = this.statsSubject.asObservable();
  agents$: Observable<CarAgent[]> = this.populationSubject.asObservable();
  private runsSubject = new BehaviorSubject<AITrainingRun[]>([]);
  runs$: Observable<AITrainingRun[]> = this.runsSubject.asObservable();
  private selectedHistoryEntrySubject = new BehaviorSubject<AITrainingHistoryEntry | null>(null);
  selectedHistoryEntry$: Observable<AITrainingHistoryEntry | null> = this.selectedHistoryEntrySubject.asObservable();
  private stopRequested = false;

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
    const runLabel = `Run ${existingRuns.length + 1}`;
    let currentRun: AITrainingRun = {
      id: crypto.randomUUID(),
      label: runLabel,
      startedAt: Date.now(),
      completedAt: null,
      generationCount: 0,
      bestFitness: 0,
      bestLapTime: 0,
      aliveCount: 0,
      averageFitness: 0,
      entries: []
    };
    this.runsSubject.next([...existingRuns, currentRun]);

    let bestAgentSnapshot: { genome: AgentGenome; trajectory: any[]; state: any } | null = null;
    const trackLength = getTrackLength(buildTrackPath(segments, 2));
    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(5, perf.topSpeed / 3.6);
    
    const pessimisticAvgSpeed = Math.max(2, topSpeedMs * 0.15);
    const dt = 1 / 30;
    const rawSteps = calculateSimulationSteps(trackLength, pessimisticAvgSpeed, dt);

    // hard safety floor: guarantee at least e.g. 45 seconds of sim time regardless of track length calc
    const minTimeSeconds = 45;
    const simulationSteps = Math.max(rawSteps, Math.ceil(minTimeSeconds / dt));;

    for (let generation = 1; generation <= generations; generation++) {
      if (this.stopRequested) break;

      const agents = population.map(genome => new CarAgent({ ...genome }, settings));
      agents.forEach(agent => agent.reset(segments));

      this.populationSubject.next(agents);
      await this.simulateAgents(agents, simulationSteps, 1 / 30);

      agents.forEach(agent => {
        const genome = agent.genome;
        genome.fitness = agent.genome.fitness;
        genome.lapTime = agent.genome.lapTime;
        genome.alive = agent.state.alive;
      });

      // snapshot genomes for next generation
      population = agents.map(agent => ({ ...agent.genome, weights: [...agent.genome.weights] }));
      population.sort((a, b) => b.fitness - a.fitness);
      bestGenome = population[0];

      // capture the actual best agent (with its trajectory) from this generation
      const bestAgent = agents.reduce((best, a) => (a.genome.fitness > (best?.genome.fitness ?? -Infinity) ? a : best), agents[0]);
      if (bestAgent) {
        bestAgentSnapshot = {
          genome: { ...bestAgent.genome, weights: [...bestAgent.genome.weights] },
          trajectory: bestAgent.trajectory ? [...bestAgent.trajectory] : [],
          state: { ...bestAgent.state }
        };
      }

      const averageFitness = population.reduce((sum, g) => sum + g.fitness, 0) / population.length;
      const aliveCount = population.filter(g => g.alive).length;
      const bestLapTime = bestGenome.lapTime === Infinity ? 0 : bestGenome.lapTime;
      const roundedBestFitness = Math.round(bestGenome.fitness * 100) / 100;
      const roundedAverageFitness = Math.round(averageFitness * 100) / 100;
      const roundedBestLapTime = Math.round(bestLapTime * 100) / 100;

      let bestFitnessEver = -Infinity;
      let stagnationCounter = 0;

      // inside the generation loop, after computing roundedBestFitness:
      if (roundedBestFitness > bestFitnessEver + 1) {
        bestFitnessEver = roundedBestFitness;
        stagnationCounter = 0;
      } else {
        stagnationCounter++;
      }
      const stagnationBoost = stagnationCounter >= 6; // no improvement for 6 gens → shake things up
      if (stagnationBoost) stagnationCounter = 0; // reset after boosting

      population = this.evolvePopulation(population, mutationRate, stagnationBoost);

      this.statsSubject.next({
        generation,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        aliveCount,
        averageFitness: roundedAverageFitness,
        active: true,
      });

      const entry: AITrainingHistoryEntry = {
        runId: currentRun.id,
        generation,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        aliveCount,
        averageFitness: roundedAverageFitness,
        trajectory: bestAgentSnapshot?.trajectory ?? [],
      };

      currentRun = {
        ...currentRun,
        generationCount: currentRun.generationCount + 1,
        bestFitness: roundedBestFitness,
        bestLapTime: roundedBestLapTime,
        aliveCount,
        averageFitness: roundedAverageFitness,
        entries: [...currentRun.entries, entry],
      };

      this.updateRun(currentRun);

      if (generation === generations || this.stopRequested) break;

      population = this.evolvePopulation(population, mutationRate);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    

    let bestAgents: CarAgent[] = [];
    if (bestAgentSnapshot) {
      const agent = new CarAgent({ ...bestAgentSnapshot.genome }, settings);
      agent.reset(segments);
      // replace trajectory and state with snapshot so UI can render the actual learned path
      agent.trajectory = bestAgentSnapshot.trajectory.map(p => ({ ...p }));
      agent.state = { ...bestAgentSnapshot.state };
      bestAgents = [agent];
    } else if (bestGenome) {
      bestAgents = [new CarAgent({ ...bestGenome }, settings)];
      if (bestAgents.length) bestAgents[0].reset(segments);
    }

    if (bestAgentSnapshot) {
      const lastEntry = currentRun.entries[currentRun.entries.length - 1];
      if (lastEntry) {
        this.selectHistoryEntry(lastEntry);
      }
    }

    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });

    return { bestAgents, bestGenome };
  }

  private updateRun(run: AITrainingRun) {
    const updatedRuns = this.runsSubject.value.map(existing => existing.id === run.id ? run : existing);
    this.runsSubject.next(updatedRuns);
  }

  selectHistoryEntry(entry: AITrainingHistoryEntry) {
    this.selectedHistoryEntrySubject.next(entry);
  }

  private createGenome(): AgentGenome {
  return {
      weights: Array.from({ length: 33 }, () => (Math.random() * 2 - 1)),
      fitness: 0,
      distance: 0,
      lapTime: Infinity,
      alive: true,
    };
  }

  private async simulateAgents(agents: CarAgent[], steps: number, dt: number) {
  const renderEvery = 5;
  for (let step = 0; step < steps; step++) {
    if (this.stopRequested) break;

    let anyAlive = false;
    agents.forEach(agent => {
      agent.update(dt);
      if (agent.state.alive) anyAlive = true;
    });

    if (!anyAlive) break; // everyone either crashed or completed the lap — no point continuing

    if (step % renderEvery === 0) {
      this.populationSubject.next(agents);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  this.populationSubject.next(agents);
}

  private evolvePopulation(population: AgentGenome[], mutationRate: number, stagnationBoost = false): AgentGenome[] {
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
    const eliteCount = Math.max(1, Math.floor(sorted.length * 0.15));
    const next: AgentGenome[] = sorted.slice(0, eliteCount).map(g => ({ ...g, weights: [...g.weights], alive: g.alive }));

    // inject fresh random genomes to escape local optima
    const injectCount = stagnationBoost ? Math.floor(sorted.length * 0.15) : Math.floor(sorted.length * 0.05);
    for (let i = 0; i < injectCount && next.length < sorted.length; i++) {
      next.push(this.createGenome());
    }

    const effectiveMutationRate = stagnationBoost ? Math.min(1, mutationRate * 3) : mutationRate;

    while (next.length < sorted.length) {
      const parentA = this.selectParent(sorted);
      const parentB = this.selectParent(sorted);
      const childWeights = parentA.weights.map((weight, i) => (weight + parentB.weights[i]) / 2);
      next.push({
        weights: childWeights.map(weight => this.mutateWeight(weight, effectiveMutationRate)),
        fitness: 0,
        distance: 0,
        lapTime: Infinity,
        alive: true,
      });
    }

    return next;
  }

  private selectParent(sorted: AgentGenome[]): AgentGenome {
    const index = Math.floor(Math.pow(Math.random(), 2) * sorted.length);
    return sorted[index];
  }

  private mutateWeight(value: number, mutationRate: number): number {
    if (Math.random() >= mutationRate) return value;
    const mutation = (Math.random() * 2 - 1) * 0.5;
    return value + mutation;
  }
}
