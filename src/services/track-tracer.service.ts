import { Injectable } from '@angular/core';
import { Vec2, simplifyPath, smoothPath, pathLength, scalePathToLength } from '../utils/track-geometry';

export interface TraceOptions {
  /** 0–255 luminance cut. Pixels darker than this are treated as track when `invert` is false. */
  threshold: number;
  /** Set when the track is drawn light on a dark background. */
  invert: boolean;
  /** Real-world length of the circuit in metres; the traced path is scaled to match. */
  realLengthMeters: number;
}

export interface TraceResult {
  points: Vec2[];
  closed: boolean;
  /** Fraction of the image classified as track — a sanity signal for a bad threshold. */
  coverage: number;
}

/** Working resolution for the trace. Big enough to keep corners, small enough to stay fast. */
const MAX_DIM = 480;

/**
 * Turns a circuit image into a drivable centreline.
 *
 * The pipeline is: luminance threshold to a binary mask, keep the largest connected blob (drops
 * captions, logos and stray marks), thin that blob to a one-pixel skeleton, then walk the
 * skeleton into an ordered path. Thinning is what makes an arbitrarily thick drawn circuit
 * collapse to its centreline; walking is what turns a set of pixels into an *ordered* path,
 * which is what a track actually is.
 *
 * It is deliberately forgiving rather than clever — clean circuit maps trace well, and anything
 * messier is expected to need the manual point editor afterwards.
 */
@Injectable({ providedIn: 'root' })
export class TrackTracerService {
  async trace(image: HTMLImageElement, options: TraceOptions): Promise<TraceResult> {
    const { width, height, data } = this.rasterise(image);
    const mask = this.threshold(data, width, height, options.threshold, options.invert);
    const coverage = mask.reduce((sum, v) => sum + v, 0) / (width * height);

    const largest = this.largestComponent(mask, width, height);
    const skeleton = this.thin(largest, width, height);
    const ordered = this.walkSkeleton(skeleton, width, height);

    if (ordered.points.length < 8) {
      throw new Error(
        'Could not find a track in that image. Try adjusting the threshold, or inverting it if the ' +
        'track is drawn light on a dark background.'
      );
    }

    // Pixel coordinates are y-down and arbitrary in scale; centre them and convert to metres.
    let points: Vec2[] = ordered.points.map(p => ({ x: p.x - width / 2, y: p.y - height / 2 }));
    points = simplifyPath(points, 1.2);
    points = smoothPath(points, 3, ordered.closed);

    if (options.realLengthMeters > 0) {
      points = scalePathToLength(points, options.realLengthMeters, ordered.closed);
    } else {
      // No stated length: fall back to a sane default so physics isn't nonsense.
      points = scalePathToLength(points, 3000, ordered.closed);
    }

    return { points, closed: ordered.closed, coverage };
  }

  private rasterise(image: HTMLImageElement) {
    const scale = Math.min(1, MAX_DIM / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the image.');

    // White backdrop so transparent PNGs (very common for circuit outlines) threshold sanely
    // instead of every transparent pixel reading as black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  }

  private threshold(data: Uint8ClampedArray, width: number, height: number, cut: number, invert: boolean): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const isTrack = invert ? luminance > cut : luminance < cut;
      mask[p] = isTrack ? 1 : 0;
    }
    return mask;
  }

  /** Flood fill every blob, keep the biggest — drops titles, logos and specks. */
  private largestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
    const labels = new Int32Array(width * height).fill(-1);
    const stack: number[] = [];
    let bestLabel = -1;
    let bestSize = 0;
    let label = 0;

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start] !== -1) continue;
      let size = 0;
      stack.push(start);
      labels[start] = label;

      while (stack.length) {
        const p = stack.pop()!;
        size++;
        const x = p % width;
        const y = (p / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const n = ny * width + nx;
            if (mask[n] && labels[n] === -1) {
              labels[n] = label;
              stack.push(n);
            }
          }
        }
      }

      if (size > bestSize) { bestSize = size; bestLabel = label; }
      label++;
    }

    const out = new Uint8Array(width * height);
    if (bestLabel === -1) return out;
    for (let i = 0; i < labels.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
    return out;
  }

  /** Zhang–Suen thinning: erodes the blob to a single-pixel-wide skeleton. */
  private thin(mask: Uint8Array, width: number, height: number): Uint8Array {
    const img = Uint8Array.from(mask);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : img[y * width + x]);

    let changed = true;
    let guard = 0;
    while (changed && guard++ < 100) {
      changed = false;

      for (const step of [0, 1]) {
        const doomed: number[] = [];
        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            if (!at(x, y)) continue;
            const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y);
            const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1);
            const p8 = at(x - 1, y), p9 = at(x - 1, y - 1);

            const neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (neighbours < 2 || neighbours > 6) continue;

            const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
            let transitions = 0;
            for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) transitions++;
            if (transitions !== 1) continue;

            if (step === 0) {
              if (p2 * p4 * p6 !== 0) continue;
              if (p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0) continue;
              if (p2 * p6 * p8 !== 0) continue;
            }
            doomed.push(y * width + x);
          }
        }
        for (const p of doomed) img[p] = 0;
        if (doomed.length) changed = true;
      }
    }

    return img;
  }

  /**
   * Walks the skeleton into an ordered path.
   *
   * Starts from an endpoint (a pixel with one neighbour) when there is one, which is the natural
   * start of an open track; otherwise the skeleton is a loop and any pixel will do. At junctions
   * — spurs left by thinning, or a pit lane — it follows the neighbour that best continues the
   * current direction, which keeps the walk on the main circuit rather than diving down a stub.
   */
  private walkSkeleton(skeleton: Uint8Array, width: number, height: number): { points: Vec2[]; closed: boolean } {
    const idx = (x: number, y: number) => y * width + x;
    const neighboursOf = (x: number, y: number): Array<{ x: number; y: number }> => {
      const out: Array<{ x: number; y: number }> = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (skeleton[idx(nx, ny)]) out.push({ x: nx, y: ny });
        }
      }
      return out;
    };

    let start: { x: number; y: number } | null = null;
    let anyPixel: { x: number; y: number } | null = null;
    for (let y = 0; y < height && !start; y++) {
      for (let x = 0; x < width; x++) {
        if (!skeleton[idx(x, y)]) continue;
        if (!anyPixel) anyPixel = { x, y };
        if (neighboursOf(x, y).length === 1) { start = { x, y }; break; }
      }
    }

    const closed = !start;
    const from = start ?? anyPixel;
    if (!from) return { points: [], closed: false };

    const visited = new Uint8Array(width * height);
    const points: Vec2[] = [];
    let current = from;
    let heading = { x: 1, y: 0 };

    for (let guard = 0; guard < width * height; guard++) {
      visited[idx(current.x, current.y)] = 1;
      points.push({ x: current.x, y: current.y });

      const candidates = neighboursOf(current.x, current.y).filter(n => !visited[idx(n.x, n.y)]);
      if (!candidates.length) break;

      let best = candidates[0];
      let bestScore = -Infinity;
      for (const c of candidates) {
        const dx = c.x - current.x;
        const dy = c.y - current.y;
        const len = Math.hypot(dx, dy) || 1;
        const score = (dx / len) * heading.x + (dy / len) * heading.y;
        if (score > bestScore) { bestScore = score; best = c; }
      }

      const dx = best.x - current.x;
      const dy = best.y - current.y;
      const len = Math.hypot(dx, dy) || 1;
      heading = { x: dx / len, y: dy / len };
      current = best;
    }

    return { points, closed: closed && points.length > 20 };
  }
}
