import { calculateSimulationSteps } from './ai-driving.service';

describe('AIDrivingService simulation timing', () => {
  it('scales simulation steps for longer tracks', () => {
    const shortTrackSteps = calculateSimulationSteps(400, 20, 1 / 30);
    const longTrackSteps = calculateSimulationSteps(1600, 20, 1 / 30);

    expect(shortTrackSteps).toBeGreaterThanOrEqual(900);
    expect(longTrackSteps).toBeGreaterThan(shortTrackSteps);
    expect(longTrackSteps).toBeGreaterThan(900);
  });
});
