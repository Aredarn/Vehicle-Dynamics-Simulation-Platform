import { RacingLinePoint } from '../interfaces/car-state';
import { Segment } from '../models/Track';
import { buildTrackPath, normalizeAngle } from './track-utils';

/**
 * Free-form track geometry.
 *
 * Every track — whether assembled from pieces, drawn by hand, or traced from an image — is
 * reduced to the same thing here: a centreline polyline plus a half-width. The piece model
 * could only express straights and fixed-degree arcs, which is exactly the limit that made
 * real circuits impossible to build; a polyline has no such constraint.
 *
 * Collision is therefore "distance to the centreline polyline, minus the half-width", i.e. a
 * stroked path with round joins. That matters beyond generality: a chain of *rectangles* leaves
 * a wedge-shaped gap on the outside of every joint, which would read as off-track and kill a car
 * at each one. Round joins close those gaps by construction.
 */

export const DEFAULT_TRACK_HALF_WIDTH = 5;
/** Centreline resampling interval, in metres. */
export const CENTERLINE_SPACING = 2;

export type TrackSource = 'pieces' | 'drawn' | 'traced';

export interface TrackModel {
  /** Uniformly resampled centreline carrying heading and cumulative distance. */
  points: RacingLinePoint[];
  halfWidth: number;
  closed: boolean;
  source: TrackSource;
  label: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * How far past the edge distances stay accurate. The furthest threshold any caller applies is
 * the 8 m "in the barrier" cutoff, so anything beyond this can safely collapse to the sentinel —
 * and every extra metre of reach pulls more chords into each bucket, which is pure cost on a
 * convoluted circuit that folds back on itself.
 */
const QUERY_MARGIN = 9;
/** Small cells keep buckets close to "chords actually near this point" rather than near the cell. */
const GRID_CELL = 6;

interface ChordGrid {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  buckets: number[][];
}

const gridCache = new WeakMap<TrackModel, ChordGrid>();
const EMPTY: number[] = [];

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createTrackModel(
  raw: Vec2[],
  options: { halfWidth?: number; closed?: boolean; source?: TrackSource; label?: string } = {}
): TrackModel {
  const closed = options.closed ?? false;
  return {
    points: resampleCenterline(raw, CENTERLINE_SPACING, closed),
    halfWidth: Math.max(1.5, options.halfWidth ?? DEFAULT_TRACK_HALF_WIDTH),
    closed,
    source: options.source ?? 'drawn',
    label: options.label ?? 'Custom Track',
  };
}

/** Bridges the piece-based builder into the unified model. */
export function trackFromSegments(
  segments: Segment[],
  halfWidth = DEFAULT_TRACK_HALF_WIDTH,
  label = 'Custom Track'
): TrackModel {
  const path = buildTrackPath(segments, CENTERLINE_SPACING);
  return {
    points: path,
    halfWidth,
    closed: false,
    source: 'pieces',
    label,
  };
}

/**
 * Walks the input polyline and emits a point every `spacing` metres, so downstream code can
 * assume uniform spacing (the windowed projection search in particular relies on a bounded
 * distance-per-index).
 */
export function resampleCenterline(raw: Vec2[], spacing: number, closed = false): RacingLinePoint[] {
  const source = closed && raw.length > 2 ? [...raw, raw[0]] : raw;
  if (source.length < 2) return [];

  const out: RacingLinePoint[] = [{ x: source[0].x, y: source[0].y, heading: 0, s: 0 }];

  /** Arc length walked since the last emitted sample. */
  let sinceLast = 0;
  let total = 0;

  for (let i = 0; i < source.length - 1; i++) {
    const a = source[i];
    const b = source[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;

    // Where along this chord the next sample falls.
    let offset = spacing - sinceLast;
    while (offset <= len) {
      const t = offset / len;
      total += spacing;
      out.push({ x: a.x + dx * t, y: a.y + dy * t, heading: 0, s: total });
      offset += spacing;
    }
    sinceLast = len - (offset - spacing);
  }

  // Headings from neighbours, wrapping on a closed loop so the seam stays continuous.
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const prev = closed ? out[(i - 1 + n) % n] : out[Math.max(0, i - 1)];
    const next = closed ? out[(i + 1) % n] : out[Math.min(n - 1, i + 1)];
    out[i].heading = Math.atan2(next.y - prev.y, next.x - prev.x);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Spatial index
 * ------------------------------------------------------------------ */

function getGrid(model: TrackModel): ChordGrid {
  const cached = gridCache.get(model);
  if (cached) return cached;

  const pts = model.points;
  const reach = model.halfWidth + QUERY_MARGIN;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  minX -= reach; minY -= reach; maxX += reach; maxY += reach;

  const cols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL));
  const buckets: number[][] = new Array(cols * rows);
  for (let i = 0; i < buckets.length; i++) buckets[i] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - minX) / GRID_CELL));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x) + reach - minX) / GRID_CELL));
    const r0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - minY) / GRID_CELL));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(a.y, b.y) + reach - minY) / GRID_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(i);
    }
  }

  const grid: ChordGrid = { cell: GRID_CELL, minX, minY, cols, rows, buckets };
  gridCache.set(model, grid);
  return grid;
}

function candidates(point: Vec2, model: TrackModel): number[] {
  const grid = getGrid(model);
  const c = Math.floor((point.x - grid.minX) / grid.cell);
  const r = Math.floor((point.y - grid.minY) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return EMPTY;
  return grid.buckets[r * grid.cols + c];
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

function distanceToChord(px: number, py: number, a: RacingLinePoint, b: RacingLinePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - a.x, py - a.y);
  // Clamping the projection is what gives the round joins that close the outer-edge gaps.
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/** Raw distance to the centreline, with no corridor clamping — the basis for both queries below. */
function centerlineDistance(point: Vec2, model: TrackModel): number {
  const pts = model.points;
  const near = candidates(point, model);
  let best = Infinity;
  for (let i = 0; i < near.length; i++) {
    const index = near[i];
    const d = distanceToChord(point.x, point.y, pts[index], pts[index + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * How far past the track edge `point` lies, in metres. 0 means on track.
 * `radius` shrinks the drivable corridor by the car's own half-width.
 */
export function distanceBeyondEdge(point: Vec2, model: TrackModel, radius: number): number {
  if (model.points.length < 2) return 1000;
  const effectiveHalfWidth = Math.max(0, model.halfWidth - radius);
  const d = centerlineDistance(point, model);
  if (!Number.isFinite(d)) return 1000;
  return Math.max(0, d - effectiveHalfWidth);
}

export function isOnTrack(point: Vec2, model: TrackModel, radius: number, tolerance = 0): boolean {
  return distanceBeyondEdge(point, model, radius) <= tolerance;
}

/**
 * Distance along `heading` until the ray leaves the track.
 *
 * Sphere-traced rather than sampled at a fixed interval: at each sample the clearance to the
 * corridor edge is a provably safe distance to jump, because no point within `clearance` of a
 * sample can be further from the centreline than the edge is. On open sections that clears tens
 * of metres in two or three probes instead of twenty, which matters because these five rays per
 * car per step are the single hottest thing in training.
 */
export function rayDistanceToEdge(
  origin: Vec2,
  heading: number,
  model: TrackModel,
  maxDistance: number,
  step: number,
  radius: number
): number {
  const effectiveHalfWidth = Math.max(0, model.halfWidth - radius);
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);

  let dist = 0;
  let lastOn = 0;

  while (dist <= maxDistance) {
    const d = centerlineDistance({ x: origin.x + dx * dist, y: origin.y + dy * dist }, model);
    const clearance = Number.isFinite(d) ? effectiveHalfWidth - d : -1;

    if (clearance <= 0) {
      // Left the corridor somewhere in (lastOn, dist]; bisect to the requested resolution.
      let lo = lastOn;
      let hi = dist;
      while (hi - lo > step) {
        const mid = (lo + hi) / 2;
        const md = centerlineDistance({ x: origin.x + dx * mid, y: origin.y + dy * mid }, model);
        if (!Number.isFinite(md) || md > effectiveHalfWidth) hi = mid; else lo = mid;
      }
      return hi;
    }

    lastOn = dist;
    dist += Math.max(step, clearance);
  }

  return maxDistance;
}

/* ------------------------------------------------------------------ *
 * Path shaping — used by the drawing tool and the image tracer
 * ------------------------------------------------------------------ */

/** Douglas–Peucker: drops points that are already implied by their neighbours. */
export function simplifyPath(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    const a = points[first];
    const b = points[last];

    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], a, b);
      if (d > maxDist) { maxDist = d; index = i; }
    }

    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Chaikin corner cutting — rounds off the jitter left by a freehand stroke or a pixel skeleton. */
export function smoothPath(points: Vec2[], iterations = 2, closed = false): Vec2[] {
  let result = [...points];

  for (let pass = 0; pass < iterations; pass++) {
    if (result.length < 3) break;
    const next: Vec2[] = [];
    if (!closed) next.push(result[0]);

    const limit = closed ? result.length : result.length - 1;
    for (let i = 0; i < limit; i++) {
      const a = result[i];
      const b = result[(i + 1) % result.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }

    if (!closed) next.push(result[result.length - 1]);
    result = next;
  }

  return result;
}

/** Catmull-Rom through the control points — used when points are placed/edited by hand. */
export function splineThroughPoints(points: Vec2[], closed = false, samplesPerSpan = 8): Vec2[] {
  if (points.length < 3) return [...points];

  const out: Vec2[] = [];
  const n = points.length;
  const last = closed ? n : n - 1;

  const at = (i: number) => {
    if (closed) return points[((i % n) + n) % n];
    return points[Math.max(0, Math.min(n - 1, i))];
  };

  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }

  if (!closed) out.push(points[n - 1]);
  return out;
}

/** Total length of a polyline, used to rescale a traced path to a known real-world length. */
export function pathLength(points: Vec2[], closed = false): number {
  let total = 0;
  const limit = closed ? points.length : points.length - 1;
  for (let i = 0; i < limit; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Uniformly scales a path about its own centroid to hit a target length. */
export function scalePathToLength(points: Vec2[], targetLength: number, closed = false): Vec2[] {
  const current = pathLength(points, closed);
  if (current < 1e-6 || targetLength <= 0) return [...points];

  const factor = targetLength / current;
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  return points.map(p => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

export function trackLengthOf(model: TrackModel): number {
  return model.points.length ? model.points[model.points.length - 1].s : 0;
}

export { normalizeAngle };
