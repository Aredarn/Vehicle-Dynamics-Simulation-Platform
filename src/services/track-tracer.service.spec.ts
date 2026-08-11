import { TrackTracerService } from './track-tracer.service';
import { pathLength } from '../utils/track-geometry';

// Draws a synthetic "circuit map" (a thick closed loop with a spur + caption blob to be
// rejected) and checks the tracer recovers an ordered centreline of the right shape/length.
function makeImage(): HTMLImageElement {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 300);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.ellipse(200, 150, 140, 90, 0, 0, Math.PI * 2);
  ctx.stroke();
  // A caption blob that must be discarded as a separate component.
  ctx.fillStyle = '#000'; ctx.fillRect(10, 280, 60, 12);
  const img = new Image();
  img.src = c.toDataURL();
  return img;
}

describe('TrackTracerService', () => {
  it('traces a closed circuit and scales it to the stated length', async () => {
    const img = makeImage();
    await new Promise<void>(res => { if (img.complete) res(); else img.onload = () => res(); });

    const tracer = new TrackTracerService();
    const result = await tracer.trace(img, { threshold: 128, invert: false, realLengthMeters: 5000 });

    expect(result.points.length).toBeGreaterThan(30);
    expect(result.closed).toBe(true);
    // Scaled to the requested real length.
    expect(pathLength(result.points, true)).toBeGreaterThan(4500);
    expect(pathLength(result.points, true)).toBeLessThan(5500);

    // Should recover an ellipse-ish ring: roughly centred, and no point at the origin.
    const cx = result.points.reduce((s, p) => s + p.x, 0) / result.points.length;
    const cy = result.points.reduce((s, p) => s + p.y, 0) / result.points.length;
    expect(Math.abs(cx)).toBeLessThan(400);
    expect(Math.abs(cy)).toBeLessThan(400);

    const radii = result.points.map((p: { x: number; y: number }) => Math.hypot(p.x - cx, p.y - cy));
    // A ring has a bounded radius spread; a collapsed/spurred trace would not.
    expect(Math.min(...radii)).toBeGreaterThan(100);
  });

  it('reports a helpful error when nothing track-like is found', async () => {
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 100);
    const blank = new Image();
    blank.src = c.toDataURL();
    await new Promise<void>(res => { if (blank.complete) res(); else blank.onload = () => res(); });

    const tracer = new TrackTracerService();
    await expectAsync(tracer.trace(blank, { threshold: 128, invert: false, realLengthMeters: 1000 }))
      .toBeRejectedWithError(/Could not find a track/);
  });
});
