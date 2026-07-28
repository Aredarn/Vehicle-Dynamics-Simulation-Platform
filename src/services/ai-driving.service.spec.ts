import { calculateSimulationSteps } from './ai-driving.service';

describe('AIDrivingService simulation timing', () => {
  it('scales simulation steps for longer tracks', () => {
    const shortTrackSteps = calculateSimulationSteps(400, 60, 1 / 30);
    const longTrackSteps = calculateSimulationSteps(2000, 80, 1 / 30);

    expect(shortTrackSteps).toBeGreaterThanOrEqual(1200);
    expect(longTrackSteps).toBeGreaterThan(shortTrackSteps);
  });

  it('allocates enough time for slow learners on long tracks', () => {
    const steps = calculateSimulationSteps(3000, 90, 1 / 30);
    const seconds = steps / 30;
    expect(seconds).toBeGreaterThanOrEqual(120);
  });

  it('gives a learning agent several times the reference lap time to finish', () => {
    const referenceLapSeconds = 50;
    const seconds = calculateSimulationSteps(650, 86, 1 / 30, referenceLapSeconds) / 30;

    // A learning agent laps far off the ideal pace. Budgeting close to the ideal lap meant the
    // clock ran out mid-lap, so a completed lap could never be observed on a larger track.
    expect(seconds).toBeGreaterThanOrEqual(referenceLapSeconds * 2.5);
  });

  it('prefers the reference lap time over the top-speed heuristic when provided', () => {
    const withReference = calculateSimulationSteps(650, 86, 1 / 30, 50);
    const withoutReference = calculateSimulationSteps(650, 86, 1 / 30);

    expect(withReference).toBeGreaterThan(withoutReference);
  });
});
