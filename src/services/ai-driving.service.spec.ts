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
});
