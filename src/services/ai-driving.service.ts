import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { CarAgent, AgentGenome } from '../models/CarAgent';
import { Segment } from '../models/Track';

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
  private stopRequested = false;

  stopTraining() {
    this.stopRequested = true;
    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });
  }

  async train(
    settings: CarSettings,
    segments: Segment[],
    config: AILearningConfig
  ): Promise<{ bestAgents: CarAgent[]; bestGenome: AgentGenome | null }> {
    this.stopRequested = false;

    const populationSize = Math.max(4, config.populationSize);
    const generations = Math.max(1, config.generations);
    const mutationRate = Math.max(0, Math.min(config.mutationRate, 1));

    let population: AgentGenome[] = Array.from({ length: populationSize }, () => this.createGenome());
    let bestGenome: AgentGenome | null = null;

    let bestAgentSnapshot: { genome: AgentGenome; trajectory: any[]; state: any } | null = null;

    for (let generation = 1; generation <= generations; generation++) {
      if (this.stopRequested) break;

      const agents = population.map(genome => new CarAgent({ ...genome }, settings));
      agents.forEach(agent => agent.reset(segments));

      this.populationSubject.next(agents);
      await this.simulateAgents(agents, 900, 1 / 30);

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

      this.statsSubject.next({
        generation,
        bestFitness: Math.round(bestGenome.fitness * 100) / 100,
        bestLapTime: Math.round(bestLapTime * 100) / 100,
        aliveCount,
        averageFitness: Math.round(averageFitness * 100) / 100,
        active: true,
      });

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

    this.statsSubject.next({
      ...this.statsSubject.value,
      active: false,
    });

    return { bestAgents, bestGenome };
  }

  private createGenome(): AgentGenome {
    return {
      weights: Array.from({ length: 24 }, () => (Math.random() * 2 - 1)),
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
      agents.forEach(agent => agent.update(dt));
      if (step % renderEvery === 0) {
        this.populationSubject.next(agents);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    this.populationSubject.next(agents);
  }

  private evolvePopulation(population: AgentGenome[], mutationRate: number): AgentGenome[] {
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
    const eliteCount = Math.max(1, Math.floor(sorted.length * 0.15));
    const next: AgentGenome[] = sorted.slice(0, eliteCount).map(g => ({ ...g, weights: [...g.weights], alive: g.alive }));

    while (next.length < sorted.length) {
      const parentA = this.selectParent(sorted);
      const parentB = this.selectParent(sorted);
      const childWeights = parentA.weights.map((weight, i) => (weight + parentB.weights[i]) / 2);
      next.push({
        weights: childWeights.map(weight => this.mutateWeight(weight, mutationRate)),
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
