/// <reference lib="webworker" />
/**
 * Runs one training session off the main thread.
 *
 * The worker owns nothing but an engine and two knobs — the speed and the stop flag — both of
 * which the service can turn mid-run. Poses go back at repaint rate as a transferred buffer,
 * outcomes go back once per generation, and the worker is done (and terminated by the
 * service) after a single run.
 */
import { TrainingEngine, driveTraining } from './training-engine';
import type { TrainingCommand, TrainingEvent } from './training-protocol';

let speed = Number.POSITIVE_INFINITY;
let stopped = false;
let running = false;

/**
 * A macrotask yield with no minimum delay. `setTimeout(0)` is clamped to 4 ms once timers nest,
 * which they do here on every slice — at a 12 ms slice that idled the worker a quarter of the
 * time. A message to ourselves is a real task, so queued `speed` / `stop` commands still get
 * handled in between, and it fires as soon as they have.
 */
const yieldChannel = new MessageChannel();
let resumeAfterYield: (() => void) | null = null;
yieldChannel.port1.onmessage = () => {
  const resume = resumeAfterYield;
  resumeAfterYield = null;
  resume?.();
};
function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    resumeAfterYield = resolve;
    yieldChannel.port2.postMessage(null);
  });
}

function post(event: TrainingEvent, transfer: Transferable[] = []) {
  postMessage(event, transfer);
}

async function run(command: Extract<TrainingCommand, { type: 'start' }>) {
  running = true;
  speed = command.speed;
  stopped = false;

  try {
    const engine = new TrainingEngine(command.input);
    const wasStopped = await driveTraining(engine, {
      speed: () => speed,
      stopped: () => stopped,
      publish: snapshot => post({ type: 'field', snapshot }, [snapshot.poses.buffer]),
      onGeneration: outcome => post({ type: 'generation', outcome }),
      yield: yieldToLoop,
    });
    post({ type: 'done', result: engine.result(), stopped: wasStopped });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

addEventListener('message', ({ data }: MessageEvent<TrainingCommand>) => {
  switch (data.type) {
    case 'start':
      // One run per worker; a second start on a busy worker is a programming error upstream.
      if (!running) void run(data);
      break;
    case 'speed':
      speed = data.speed > 0 ? data.speed : Number.POSITIVE_INFINITY;
      break;
    case 'stop':
      stopped = true;
      break;
  }
});
