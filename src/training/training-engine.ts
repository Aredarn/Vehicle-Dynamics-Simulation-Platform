/**
 * The genetic-algorithm training loop, with no Angular and no DOM in it.
 *
 * Everything here runs identically on the main thread and inside a Web Worker: the worker is
 * where a real run lives (five thousand cars stepping thirty times a simulated second is far too
 * much work to share a thread with the renderer), and the main thread keeps a fallback for
 * environments without workers. Both drive the same `TrainingEngine` through `driveTraining`,
 * so the two paths cannot drift apart in behaviour — only in where the work happens.
 */
import type { CarSettings } from '../services/car-settings.service';
import { CarAgent, AgentGenome, AI_INPUT_COUNT, AI_HIDDEN_SIZE } from '../models/CarAgent';
import type { TrainingObjective } from '../utils/drift-scoring';
import type { RacingLinePoint } from '../interfaces/car-state';
import { getTrackLength } from '../utils/track-utils';
import type { TrackModel } from '../utils/track-geometry';
import { calculatePerformance } from '../utils/car-physics';
import { weightCount, outputBiasIndex } from '../utils/neural-policy';

export interface AILearningConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
  /** What the population is being scored for. Defaults to the existing grip behaviour. */
  objective?: TrainingObjective;
  /** Start the population from a previously trained model instead of random weights. */
  seedWeights?: number[] | null;
}

/** The racing-line optimizer's output, computed once per run on the main thread and handed over. */
export interface ReferenceLine {
  points: RacingLinePoint[];
  estimatedLapTime: number;
}

/** Everything a run needs, as plain data so it survives `postMessage` unchanged. */
export interface TrainingRunInput {
  settings: CarSettings;
  track: TrackModel;
  config: AILearningConfig;
  referenceLine: ReferenceLine;
}

/** What the field renderer needs per car, and nothing more. */
export interface AgentPose {
  x: number;
  y: number;
  heading: number;
  alive: boolean;
}

/** A car as the renderer sees it; a live `CarAgent` satisfies this too. */
export interface AgentSnapshot {
  state: AgentPose;
}

/** The field mid-generation: poses for the renderer, plus the two figures worth reading live. */
export interface FieldSnapshot {
  /** [x, y, heading, alive] per car. */
  poses: Float32Array;
  alive: number;
  /** Steps into the generation, out of `simulationSteps`. */
  step: number;
}

/** One finished generation, reduced to what the history and the stats strip report. */
export interface GenerationOutcome {
  generation: number;
  bestFitness: number;
  bestLapTime: number;
  bestProgress: number;
  aliveCount: number;
  averageFitness: number;
  bestDriftScore: number;
  /** The generation's best line, sampled as the agent drove it. */
  trajectory: RacingLinePoint[];
  /** The generation's best genome, kept small (~230 floats) so every checkpoint is extractable. */
  weights: number[];
  /** Physics steps the generation ran before its budget or its last car ran out. */
  steps: number;
  /** Car-steps actually simulated (dead cars are skipped), so throughput can be read honestly. */
  agentUpdates: number;
  /** Wall-clock time the generation took, pacing and yields included. */
  durationMs: number;
}

export interface BestAgentRecord {
  genome: AgentGenome;
  trajectory: RacingLinePoint[];
  state: CarAgent['state'];
}

export interface TrainingResult {
  bestAgents: BestAgentRecord[];
  bestGenome: AgentGenome | null;
}

export const GENOME_WEIGHT_COUNT = weightCount(AI_INPUT_COUNT, AI_HIDDEN_SIZE);

/** Default Gaussian step size for weight mutation, relative to typical weight magnitude (~0.25). */
const BASE_MUTATION_SIGMA = 0.12;

/** Floats per car in a pose buffer: x, y, heading, alive. */
export const POSE_STRIDE = 4;

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

// ---------- Genome helpers ----------

export function spawnGenome(weights: number[]): AgentGenome {
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

export function createGenome(): AgentGenome {
  const weights = Array.from({ length: GENOME_WEIGHT_COUNT }, () => (Math.random() * 2 - 1) * 0.4);

  // Bias the throttle/brake output neurons toward "go" so early generations explore
  // forward motion instead of idling. Output order from runPolicy is [steer, throttle, brake].
  weights[outputBiasIndex(AI_INPUT_COUNT, AI_HIDDEN_SIZE, 1)] += 1;
  weights[outputBiasIndex(AI_INPUT_COUNT, AI_HIDDEN_SIZE, 2)] -= 1;

  return spawnGenome(weights);
}

export function cloneGenome(genome: AgentGenome): AgentGenome {
  return { ...genome, weights: [...genome.weights] };
}

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
export function compareGenomes(a: AgentGenome, b: AgentGenome, objective: TrainingObjective): number {
  if (objective !== 'drift' && a.completedLap !== b.completedLap) {
    return a.completedLap ? -1 : 1;
  }
  return b.fitness - a.fitness;
}

function gaussianRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gaussian perturbation, mostly in small steps. The previous uniform ±0.6 kick was 2–3x the
 * typical weight magnitude (mean |w| ≈ 0.25), so a "mutation" effectively randomized the
 * weight rather than adjusting it — there was no way to fine-tune a nearly-good policy, only
 * to destroy it or get lucky. Occasional large jumps preserve the ability to escape a basin.
 */
function mutateWeight(value: number, mutationRate: number, sigma = BASE_MUTATION_SIGMA): number {
  if (Math.random() >= mutationRate) return value;
  const scale = Math.random() < 0.1 ? sigma * 5 : sigma;
  return value + gaussianRandom() * scale;
}

function selectParent(sorted: AgentGenome[], objective: TrainingObjective): AgentGenome {
  const tournamentSize = 3;
  let best = sorted[Math.floor(Math.random() * sorted.length)];
  for (let i = 1; i < tournamentSize; i++) {
    const candidate = sorted[Math.floor(Math.random() * sorted.length)];
    if (compareGenomes(candidate, best, objective) < 0) best = candidate;
  }
  return best;
}

/**
 * Starts a run from a previously trained model instead of random weights: the seed itself
 * plus mutated variants of it at a few step sizes, rather than `populationSize` independent
 * random points. The new track's evolutionary pressure then adapts an already-competent
 * driver instead of relearning one from scratch.
 */
export function buildSeededPopulation(seedWeights: number[], size: number): AgentGenome[] {
  const population: AgentGenome[] = [spawnGenome([...seedWeights])];
  const scales = [0.15, 0.3, 0.6, 1];
  for (let i = 1; i < size; i++) {
    const scale = scales[i % scales.length];
    population.push(spawnGenome(
      seedWeights.map(w => mutateWeight(w, 0.5, BASE_MUTATION_SIGMA * scale))
    ));
  }
  return population;
}

export function evolvePopulation(
  population: AgentGenome[],
  mutationRate: number,
  objective: TrainingObjective,
  stagnationLevel = 0
): AgentGenome[] {
  const sorted = [...population].sort((a, b) => compareGenomes(a, b, objective));
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
  const next: AgentGenome[] = sorted.slice(0, eliteCount).map(g => cloneGenome(g));

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
    next.push(spawnGenome(
      parent.weights.map(w => mutateWeight(w, 0.35, BASE_MUTATION_SIGMA * scale))
    ));
  }

  // Fresh blood keeps some diversity, but stays a small minority: a random point in a
  // ~220-dimensional weight space essentially never drives well, so scaling this up on a
  // plateau just replaced working genetic material with noise and dragged the population
  // average down without ever helping the leader.
  const injectFraction = Math.min(0.15, 0.05 + stagnationLevel * 0.03);
  const injectCount = Math.floor(size * injectFraction);
  for (let i = 0; i < injectCount && next.length < size; i++) {
    next.push(createGenome());
  }

  // Capped well below 1: at a rate of 1 every weight of every child is perturbed at once, which
  // is a new random genome wearing its parents' name rather than a recombination of them.
  const mutationMultiplier = Math.min(2, 1 + stagnationLevel * 0.25);
  const effectiveMutationRate = Math.min(0.6, mutationRate * mutationMultiplier);

  while (next.length < size) {
    const parentA = selectParent(sorted, objective);
    const parentB = selectParent(sorted, objective);
    // Uniform (per-weight) crossover: each weight comes wholly from one parent or the other.
    // Arithmetic averaging tends to dilute both parents' successful patterns into a blend
    // that has neither — uniform crossover preserves each parent's actual "building blocks".
    const childWeights = parentA.weights.map((weight, i) => Math.random() < 0.5 ? weight : parentB.weights[i]);
    next.push(spawnGenome(childWeights.map(w => mutateWeight(w, effectiveMutationRate, exploreSigma))));
  }

  return next;
}

// ---------- The engine ----------

/**
 * One training run, advanced a generation at a time by whoever owns the thread.
 *
 * The engine never waits and never yields: `startGeneration` builds the grid, `advance` moves
 * every live car one step, `finishGeneration` ranks, records and breeds. Pacing, yielding and
 * publishing are the driver's business (see `driveTraining`), which is what lets the same
 * engine sit inside a worker or on the main thread.
 */
export class TrainingEngine {
  readonly objective: TrainingObjective;
  readonly populationSize: number;
  readonly generations: number;
  readonly simulationSteps: number;
  readonly dt = 1 / 30;
  readonly trackLength: number;

  private readonly settings: CarSettings;
  private readonly track: TrackModel;
  private readonly referenceLine: ReferenceLine;
  private readonly mutationRate: number;

  private population: AgentGenome[];
  private agents: CarAgent[] = [];
  private generation = 0;
  private stepIndex = 0;
  private agentUpdates = 0;
  private generationStartedAt = 0;
  /** Where the current step has got to through the grid; 0 means a step boundary. */
  private cursor = 0;
  private anyActiveThisStep = false;

  private bestGenome: AgentGenome | null = null;
  private bestAgentSnapshot: BestAgentRecord | null = null;
  private bestFitnessEver = -Infinity;
  private stagnationCounter = 0;
  /** Carried forward every generation so the best genome found can never be lost. */
  private hallOfFame: AgentGenome | null = null;

  constructor(input: TrainingRunInput) {
    const { settings, config, referenceLine } = input;
    this.settings = settings;
    this.referenceLine = referenceLine;
    this.populationSize = Math.max(4, config.populationSize);
    this.generations = Math.max(1, config.generations);
    this.mutationRate = Math.max(0, Math.min(config.mutationRate, 1));
    this.objective = config.objective ?? 'grip';

    // Freeze the layout for the whole run. The editor rebuilds its model on every change, but
    // snapshotting here keeps a run immune to edits regardless: an edit mid-run would otherwise
    // change trackLength underneath the agents, and because progressRatio is measured against
    // that length the same driving would suddenly score far lower.
    this.track = { ...input.track, points: input.track.points.map(p => ({ ...p })) };
    this.trackLength = getTrackLength(this.track.points);

    const perf = calculatePerformance(settings);
    const topSpeedMs = Math.max(8, perf.topSpeed / 3.6);
    this.simulationSteps = calculateSimulationSteps(
      this.trackLength, topSpeedMs, this.dt, referenceLine.estimatedLapTime, 1200,
      this.objective === 'drift' ? 1.8 : 1
    );

    // Seeding from a saved model starts the population at (and around) an already-competent
    // driver instead of from scratch, so training the same model on a different track adapts it
    // rather than relearning it — this is what makes "teach on different tracks" meaningfully
    // faster than a fresh run.
    this.population = config.seedWeights && config.seedWeights.length === GENOME_WEIGHT_COUNT
      ? buildSeededPopulation(config.seedWeights, this.populationSize)
      : Array.from({ length: this.populationSize }, () => createGenome());
  }

  /** The generation currently on the grid (1-based); 0 before the first one starts. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Steps taken so far in the current generation. */
  get currentStep(): number {
    return this.stepIndex;
  }

  get agentCount(): number {
    return this.agents.length;
  }

  /** Puts the next generation on the grid. Returns false once the run has used all of them. */
  startGeneration(): boolean {
    if (this.generation >= this.generations) return false;
    this.generation++;
    this.stepIndex = 0;
    this.cursor = 0;
    this.anyActiveThisStep = false;
    this.agentUpdates = 0;
    this.generationStartedAt = performance.now();
    this.agents = this.population.map(genome => new CarAgent(cloneGenome(genome), this.settings, this.objective));
    this.agents.forEach(agent => agent.reset(this.track, this.referenceLine.points, this.referenceLine.estimatedLapTime));
    return true;
  }

  /** True between steps — the only place pacing may wait without splitting a step. */
  get atStepBoundary(): boolean {
    return this.cursor === 0;
  }

  /**
   * Moves up to `maxAgents` cars on through the current step. Cars never interact, so a step
   * can be cut anywhere: a grid of thousands then still lets the driver publish poses and hand
   * the event loop a turn every few milliseconds instead of once per step.
   *
   * Returns 'more' while the step is unfinished, 'step' when it just completed, and 'end' when
   * the generation is over — the budget is spent or nobody is left driving. The full budget is
   * kept running while anyone is alive so survivors have time to finish long tracks.
   */
  advanceSlice(maxAgents: number): 'more' | 'step' | 'end' {
    if (this.cursor === 0) {
      if (this.stepIndex >= this.simulationSteps) return 'end';
      this.anyActiveThisStep = false;
    }

    const end = Math.min(this.agents.length, this.cursor + Math.max(1, maxAgents));
    for (; this.cursor < end; this.cursor++) {
      const agent = this.agents[this.cursor];
      if (agent.state.alive) {
        agent.update(this.dt);
        this.agentUpdates++;
        this.anyActiveThisStep = true;
      }
    }
    if (this.cursor < this.agents.length) return 'more';

    this.cursor = 0;
    this.stepIndex++;
    return this.anyActiveThisStep && this.stepIndex < this.simulationSteps ? 'step' : 'end';
  }

  /**
   * Every car's pose as [x, y, heading, alive] runs — all the renderer reads, and cheap to hand
   * across a thread boundary — with the live alive count and step alongside.
   */
  snapshot(): FieldSnapshot {
    const poses = new Float32Array(this.agents.length * POSE_STRIDE);
    let alive = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const state = this.agents[i].state;
      const base = i * POSE_STRIDE;
      poses[base] = state.x;
      poses[base + 1] = state.y;
      poses[base + 2] = state.heading;
      poses[base + 3] = state.alive ? 1 : 0;
      if (state.alive) alive++;
    }
    return { poses, alive, step: this.stepIndex };
  }

  /** Ranks the generation, records its best, and breeds the next grid unless this was the last. */
  finishGeneration(): GenerationOutcome {
    const objective = this.objective;
    const agents = this.agents;

    this.population = agents.map(agent => cloneGenome(agent.genome));
    this.population.sort((a, b) => compareGenomes(a, b, objective));
    const bestGenome = this.population[0];
    this.bestGenome = bestGenome;

    if (!this.hallOfFame || compareGenomes(bestGenome, this.hallOfFame, objective) < 0) {
      this.hallOfFame = cloneGenome(bestGenome);
    }

    const bestAgent = agents.reduce((best, agent) =>
      compareGenomes(agent.genome, best.genome, objective) < 0 ? agent : best, agents[0]);
    if (bestAgent) {
      this.bestAgentSnapshot = {
        genome: cloneGenome(bestAgent.genome),
        trajectory: bestAgent.trajectory.map(point => ({ ...point })),
        state: { ...bestAgent.state },
      };
    }

    const averageFitness = this.population.reduce((sum, g) => sum + g.fitness, 0) / this.population.length;
    const aliveCount = this.population.filter(g => g.alive).length;
    const bestLapTime = bestGenome.completedLap ? bestGenome.lapTime : 0;
    const roundedBestFitness = Math.round(bestGenome.fitness * 100) / 100;

    if (roundedBestFitness > this.bestFitnessEver + 1) {
      this.bestFitnessEver = roundedBestFitness;
      this.stagnationCounter = 0;
    } else {
      this.stagnationCounter++;
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
    const stagnationLevel = Math.min(3, Math.floor(this.stagnationCounter / 5));

    const outcome: GenerationOutcome = {
      generation: this.generation,
      bestFitness: roundedBestFitness,
      bestLapTime: Math.round(bestLapTime * 100) / 100,
      bestProgress: Math.round((bestGenome.progressRatio ?? 0) * 1000) / 10,
      aliveCount,
      averageFitness: Math.round(averageFitness * 100) / 100,
      bestDriftScore: Math.round((bestGenome.driftScore ?? 0) * 10) / 10,
      trajectory: this.bestAgentSnapshot?.trajectory ?? [],
      weights: this.bestAgentSnapshot ? [...this.bestAgentSnapshot.genome.weights] : [],
      steps: this.stepIndex,
      agentUpdates: this.agentUpdates,
      durationMs: Math.round(performance.now() - this.generationStartedAt),
    };

    if (this.generation < this.generations) {
      this.population = evolvePopulation(this.population, this.mutationRate, objective, stagnationLevel);
      // Re-seat the all-time best. Ordinary elitism already preserves it while the inputs hold
      // still, but this makes "the best never regresses" true by construction.
      if (this.hallOfFame && this.population.length) {
        this.population[this.population.length - 1] = cloneGenome(this.hallOfFame);
      }
    }

    return outcome;
  }

  /** The run's champion, as a record that can be rebuilt into a car on any thread. */
  result(): TrainingResult {
    if (this.bestAgentSnapshot) {
      return {
        bestAgents: [{
          genome: cloneGenome(this.bestAgentSnapshot.genome),
          trajectory: this.bestAgentSnapshot.trajectory.map(point => ({ ...point })),
          state: { ...this.bestAgentSnapshot.state },
        }],
        bestGenome: this.bestGenome,
      };
    }
    if (this.bestGenome) {
      const agent = new CarAgent(cloneGenome(this.bestGenome), this.settings, this.objective);
      agent.reset(this.track, this.referenceLine.points, this.referenceLine.estimatedLapTime);
      return {
        bestAgents: [{ genome: agent.genome, trajectory: [], state: { ...agent.state } }],
        bestGenome: this.bestGenome,
      };
    }
    return { bestAgents: [], bestGenome: null };
  }
}

// ---------- The driver ----------

/** How a driver talks to whoever is watching: the worker posts these, the fallback calls them. */
export interface TrainingIO {
  /**
   * Simulated seconds per real second, read fresh on every step so the slider takes effect
   * mid-generation. `Infinity` runs flat out.
   */
  speed(): number;
  /** True once a stop has been asked for; checked every step so the run halts within one. */
  stopped(): boolean;
  /** Hands over the field. The pose buffer is the caller's to keep or transfer. */
  publish(snapshot: FieldSnapshot): void;
  onGeneration(outcome: GenerationOutcome): void;
  /** Lets the event loop turn — for messages on a worker, for painting on the main thread. */
  yield(): Promise<void>;
}

/** Repaint cadence for the field. The renderer needs far less than the physics rate. */
const SNAPSHOT_INTERVAL_MS = 33;
/** Longest stretch of stepping before the loop gives the event loop a turn. */
const YIELD_BUDGET_MS = 12;
/** Cars per slice: small enough that the yield budget is honoured to within a slice. */
const SLICE = 64;

/**
 * Runs an engine to completion (or until stopped), pacing it to the requested speed.
 *
 * Wall-clock pacing: each step advances the world by `dt`, so at a speed of N the step that
 * has just finished must not complete before step*dt/N real seconds have passed. While waiting
 * the field is still published, so a slow-motion run animates rather than jumping.
 *
 * Returns true if the run was stopped before its last generation completed. A stopped
 * generation is never reported: every agent is frozen mid-lap, so recording it would make a
 * halted run look like it had collapsed.
 */
export async function driveTraining(engine: TrainingEngine, io: TrainingIO): Promise<boolean> {
  // Every publish gets a fresh buffer: a worker transfers it away, so it cannot be reused.
  const publish = () => io.publish(engine.snapshot());

  while (!io.stopped() && engine.startGeneration()) {
    const runStart = now();
    let lastSnapshot = 0;
    let sliceStart = now();
    let pacedSteps = 0;

    // A fresh grid is worth showing before it moves.
    publish();

    let progress: 'more' | 'step' | 'end' = 'step';
    while (progress !== 'end') {
      if (io.stopped()) break;

      if (engine.atStepBoundary) {
        // Read the speed every step so the slider takes effect immediately, mid-generation.
        const speed = io.speed();
        if (Number.isFinite(speed)) {
          const dueAt = runStart + (pacedSteps * engine.dt * 1000) / speed;
          let waitMs = dueAt - now();
          while (waitMs > 1 && !io.stopped()) {
            const t = now();
            if (t - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
              publish();
              lastSnapshot = t;
            }
            await sleep(Math.min(waitMs, 16));
            waitMs = dueAt - now();
          }
          sliceStart = now();
        }
        pacedSteps++;
      }

      progress = engine.advanceSlice(SLICE);

      const t = now();
      if (t - sliceStart >= YIELD_BUDGET_MS) {
        if (t - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
          publish();
          lastSnapshot = t;
        }
        await io.yield();
        sliceStart = now();
      }
    }

    if (io.stopped()) return true;

    publish();
    io.onGeneration(engine.finishGeneration());
    await io.yield();
  }

  return io.stopped();
}

function now(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
