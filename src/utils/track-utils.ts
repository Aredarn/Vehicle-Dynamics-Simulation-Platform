import { RacingLinePoint } from '../interfaces/car-state';
import { Segment } from '../models/Track';

export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

export function buildTrackPath(segments: Segment[], step = 2): RacingLinePoint[] {
  const path: RacingLinePoint[] = [];
  let totalS = 0;
  let previous: RacingLinePoint | null = null;

  for (const seg of segments) {
    const length = getSegmentLength(seg);
    const steps = Math.max(1, Math.ceil(length / step));

    for (let i = 0; i <= steps; i++) {
      const dist = (i / steps) * length;
      const basePoint = computeSegmentPoint(seg, dist);
      const point = {
        x: basePoint.x,
        y: basePoint.y,
        heading: basePoint.heading,
      };

      if (previous) {
        totalS += distance(previous, point);
      }

      path.push({
        ...point,
        s: totalS,
      });

      previous = { ...point, s: totalS };
    }
  }

  return path;
}


export function closestPointOnPath(point: { x: number; y: number }, path: RacingLinePoint[]) {
  return closestPointOnPathRange(point, path, 0, path.length - 2);
}

/**
 * Same result as `closestPointOnPath`, but searches only a window around `hintIndex` — the
 * index returned by the previous call. A car covers at most a few metres per simulation step
 * against 2 m path spacing, so the true closest point is always within a handful of indices;
 * scanning the whole path every step made this one of the two dominant training costs.
 *
 * Falls back to a full scan when the local result looks wrong (the car was teleported, or the
 * window straddles a point where the track passes close to itself), so the result stays exact.
 */
export function closestPointOnPathNear(
  point: { x: number; y: number },
  path: RacingLinePoint[],
  hintIndex: number,
  window = 12
) {
  if (path.length < 2) return closestPointOnPath(point, path);

  const lo = Math.max(0, hintIndex - window);
  const hi = Math.min(path.length - 2, hintIndex + window);
  const local = closestPointOnPathRange(point, path, lo, hi);

  // If the best point sits on the window edge, a nearer one probably lies outside it.
  const onEdge = (local.index <= lo && lo > 0) || (local.index >= hi && hi < path.length - 2);
  if (onEdge) return closestPointOnPath(point, path);

  return local;
}

function closestPointOnPathRange(
  point: { x: number; y: number },
  path: RacingLinePoint[],
  from: number,
  to: number
) {
  let best = { point: { x: 0, y: 0 }, index: 0, s: 0, heading: 0, distance: Infinity, offset: 0 };

  for (let i = from; i <= to; i++) {
    const p0 = path[i];
    const p1 = path[i + 1];
    const result = closestPointOnSegment(point, p0, p1);
    if (result.distance < best.distance) {
      best = {
        point: result.point,
        index: i,
        s: result.s,
        heading: result.heading,
        distance: result.distance,
        offset: result.offset,
      };
    }
  }

  return best;
}

function closestPointOnSegment(point: { x: number; y: number }, p0: RacingLinePoint, p1: RacingLinePoint) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) {
    return { point: { x: p0.x, y: p0.y }, distance: distance(point, p0), s: p0.s, heading: p0.heading, offset: 0 };
  }

  const t = ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / length2;
  const clamped = Math.max(0, Math.min(1, t));
  const projX = p0.x + clamped * dx;
  const projY = p0.y + clamped * dy;
  const dist = distance(point, { x: projX, y: projY });
  const s = p0.s + clamped * (p1.s - p0.s);
  const heading = Math.atan2(dy, dx);
  const offset = signedLateralOffset(point, p0, p1);
  return { point: { x: projX, y: projY }, distance: dist, s, heading, offset };
}

function signedLateralOffset(point: { x: number; y: number }, p0: RacingLinePoint, p1: RacingLinePoint) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const px = point.x - p0.x;
  const py = point.y - p0.y;
  const cross = px * dy - py * dx;
  const length = Math.hypot(dx, dy) || 1;
  return cross / length;
}

/**
 * Distance along `heading` until the ray leaves the track, resolved to within `step`.
 *
 * Walks in coarse strides and then bisects the straddling interval, rather than sampling every
 * `step` metres. This is the hottest path in training — five rays per car per simulation step,
 * each previously up to ~90 whole-track point tests — and the coarse/refine split reaches the
 * same resolution in roughly a quarter of the tests.
 */
export function rayDistanceToTrackEdge(
  origin: { x: number; y: number },
  heading: number,
  segments: Segment[],
  maxDistance: number,
  step: number,
  radius: number
) {
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const offTrackAt = (dist: number) =>
    !isPointOnTrack({ x: origin.x + dx * dist, y: origin.y + dy * dist }, segments, radius);

  const coarse = Math.max(step, 2);
  let lastOnTrack = 0;

  for (let dist = 0; dist <= maxDistance; dist += coarse) {
    if (offTrackAt(dist)) {
      let lo = lastOnTrack;
      let hi = dist;
      while (hi - lo > step) {
        const mid = (lo + hi) / 2;
        if (offTrackAt(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    lastOnTrack = dist;
  }

  return maxDistance;
}

/**
 * Signed curvature at a point on the path: positive turns left, negative right.
 *
 * `computeCurvature` returns a magnitude, which cannot tell a left-hander from a right-hander —
 * and telling them apart is what decides whether a slide is going the right way for the corner.
 */
export function signedCurvatureAt(path: RacingLinePoint[], index: number, span = 3): number {
  const n = path.length;
  if (n < 3) return 0;
  const a = Math.max(0, Math.min(n - 1, index - span));
  const b = Math.max(0, Math.min(n - 1, index + span));
  const ds = path[b].s - path[a].s;
  if (Math.abs(ds) < 1e-6) return 0;
  return normalizeAngle(path[b].heading - path[a].heading) / ds;
}

export function computeCurvature(line: RacingLinePoint[], index: number): number {
  if (index <= 0 || index >= line.length - 1) return 0;
  const p0 = line[index - 1];
  const p1 = line[index];
  const p2 = line[index + 1];
  const headingChange = Math.abs(normalizeAngle(p2.heading - p0.heading));
  const dist = (distance(p0, p1) + distance(p1, p2)) / 2;
  return headingChange / Math.max(dist, 0.001);
}

export const TRACK_HALF_WIDTH = 5; // meters from centerline to wall

export function isPointOnTrack(
  point: { x: number; y: number },
  segments: Segment[],
  radius: number,
  tolerance = 0
) {
  return distanceBeyondTrackEdge(point, segments, radius) <= tolerance;
}

/**
 * How far `point` is past the nearest segment's track edge, in meters. 0 (or less) means on track.
 * Used to model off-track grip loss as a continuous zone rather than a binary in/out check.
 */
export function distanceBeyondTrackEdge(
  point: { x: number; y: number },
  segments: Segment[],
  radius: number
): number {
  // Only segments whose (margin-expanded) bounds cover this point can produce a relevant
  // excess; anything further away is already past the death threshold. Testing every segment
  // here made this the hottest call in training, since each sensor ray samples it repeatedly.
  const candidates = segmentCandidates(point, segments);
  let minExcess = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const excess = segmentEdgeExcess(point, segments[candidates[i]], radius);
    if (excess < minExcess) minExcess = excess;
    if (minExcess <= 0) return 0;
  }
  // A point outside every segment's span/arc entirely (not just past the edge of one) is
  // definitely off track — use a sentinel well past any grip-zone/death threshold.
  return Number.isFinite(minExcess) ? minExcess : 1000;
}

/* ------------------------------------------------------------------------ *
 * Track indexing
 *
 * Per-track data derived once and shared by every agent. Training builds a
 * frozen segment array per run, so keying by that array gives a cache hit for
 * all agents in the population instead of recomputing this 1000 times.
 * ------------------------------------------------------------------------ */

interface SegmentGrid {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  buckets: number[][];
  all: number[];
}

/** Beyond this distance from a segment the excess is past every threshold that matters. */
const INDEX_MARGIN = TRACK_HALF_WIDTH + 12;

const gridCache = new WeakMap<Segment[], SegmentGrid>();
const pathCache = new WeakMap<Segment[], RacingLinePoint[]>();

/** `buildTrackPath` result cached per segment array — identical for every agent on a track. */
export function getTrackPathCached(segments: Segment[], step = 2): RacingLinePoint[] {
  let path = pathCache.get(segments);
  if (!path) {
    path = buildTrackPath(segments, step);
    pathCache.set(segments, path);
  }
  return path;
}

function segmentBounds(seg: Segment): { minX: number; minY: number; maxX: number; maxY: number } {
  const points: Array<{ x: number; y: number }> = [];
  const length = getSegmentLength(seg);
  // Sampling handles straights and arcs uniformly and is only paid once per track.
  const samples = seg.type === 'start' || seg.type === 'straight' ? 2 : 10;
  for (let i = 0; i <= samples; i++) {
    points.push(computeSegmentPoint(seg, (i / samples) * length));
  }
  return {
    minX: Math.min(...points.map(p => p.x)) - INDEX_MARGIN,
    minY: Math.min(...points.map(p => p.y)) - INDEX_MARGIN,
    maxX: Math.max(...points.map(p => p.x)) + INDEX_MARGIN,
    maxY: Math.max(...points.map(p => p.y)) + INDEX_MARGIN,
  };
}

function getSegmentGrid(segments: Segment[]): SegmentGrid {
  const cached = gridCache.get(segments);
  if (cached) return cached;

  const bounds = segments.map(segmentBounds);
  const minX = Math.min(...bounds.map(b => b.minX));
  const minY = Math.min(...bounds.map(b => b.minY));
  const maxX = Math.max(...bounds.map(b => b.maxX));
  const maxY = Math.max(...bounds.map(b => b.maxY));

  const cell = 25;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell));

  const buckets: number[][] = new Array(cols * rows);
  for (let i = 0; i < buckets.length; i++) buckets[i] = [];

  bounds.forEach((b, index) => {
    const c0 = Math.max(0, Math.floor((b.minX - minX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((b.maxX - minX) / cell));
    const r0 = Math.max(0, Math.floor((b.minY - minY) / cell));
    const r1 = Math.min(rows - 1, Math.floor((b.maxY - minY) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(index);
    }
  });

  const grid: SegmentGrid = {
    cell, minX, minY, cols, rows, buckets,
    all: segments.map((_, i) => i),
  };
  gridCache.set(segments, grid);
  return grid;
}

function segmentCandidates(point: { x: number; y: number }, segments: Segment[]): number[] {
  if (segments.length <= 4) return getSegmentGrid(segments).all;

  const grid = getSegmentGrid(segments);
  const c = Math.floor((point.x - grid.minX) / grid.cell);
  const r = Math.floor((point.y - grid.minY) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return EMPTY_CANDIDATES;
  return grid.buckets[r * grid.cols + c];
}

const EMPTY_CANDIDATES: number[] = [];

function segmentEdgeExcess(
  point: { x: number; y: number },
  seg: Segment,
  radius: number
): number {
  const effectiveHalfWidth = Math.max(0, TRACK_HALF_WIDTH - radius);
  if (seg.type === 'start' || seg.type === 'straight') {
    const sx = seg.position.x;
    const sy = seg.position.y;
    const dx = Math.cos(seg.heading);
    const dy = Math.sin(seg.heading);
    const length = seg.length ?? 0;
    const px = point.x - sx;
    const py = point.y - sy;
    const proj = px * dx + py * dy;
    if (proj < 0 || proj > length) return Infinity;
    const lateral = Math.abs(px * dy - py * dx);
    return lateral - effectiveHalfWidth;
  }

  const angleRad = (seg.angle ?? 90) * Math.PI / 180;
  const R = seg.radius ?? 60;
  const turnDirection = Math.sign(seg.angle ?? 90) || 1;
  const cx = seg.position.x - turnDirection * R * Math.sin(seg.heading);
  const cy = seg.position.y + turnDirection * R * Math.cos(seg.heading);
  const pointR = Math.hypot(point.x - cx, point.y - cy);
  const radialDelta = Math.abs(pointR - R);

  const startAngle = Math.atan2(seg.position.y - cy, seg.position.x - cx);
  const targetAngle = Math.atan2(point.y - cy, point.x - cx);
  const endAngle = startAngle + angleRad;
  const direction = Math.sign(angleRad) || 1;
  if (!isAngleBetween(targetAngle, startAngle, endAngle, direction)) return Infinity;
  return radialDelta - effectiveHalfWidth;
}

function isAngleBetween(angle: number, start: number, end: number, direction: number) {
  const a = normalizePositive(angle);
  const s = normalizePositive(start);
  const e = normalizePositive(end);

  if (direction >= 0) {
    if (s <= e) {
      return a >= s && a <= e;
    }
    return a >= s || a <= e;
  }

  if (s <= e) {
    return a >= e || a <= s;
  }
  return a >= e && a <= s;
}

function normalizePositive(angle: number) {
  let value = angle % (Math.PI * 2);
  if (value < 0) value += Math.PI * 2;
  return value;
}

function computeSegmentPoint(seg: Segment, distanceAlong: number): { x: number; y: number; heading: number } {
  if (seg.type === 'straight' || seg.type === 'start') {
    return {
      x: seg.position.x + distanceAlong * Math.cos(seg.heading),
      y: seg.position.y + distanceAlong * Math.sin(seg.heading),
      heading: seg.heading,
    };
  }

  const R = seg.radius ?? 60;
  const angleDeg = seg.angle ?? 90;
  const angleRad = angleDeg * Math.PI / 180;
  const turnDirection = Math.sign(angleDeg) || 1;
  const cx = seg.position.x - turnDirection * R * Math.sin(seg.heading);
  const cy = seg.position.y + turnDirection * R * Math.cos(seg.heading);
  const startAngle = Math.atan2(seg.position.y - cy, seg.position.x - cx);
  const arcFraction = distanceAlong / Math.max(R * Math.abs(angleRad), 0.0001);
  const currentAngle = startAngle + turnDirection * arcFraction * Math.abs(angleRad);

  return {
    x: cx + R * Math.cos(currentAngle),
    y: cy + R * Math.sin(currentAngle),
    heading: seg.heading + turnDirection * arcFraction * Math.abs(angleRad),
  };
}

function getSegmentLength(seg: Segment): number {
  if (seg.type === 'straight' || seg.type === 'start') return seg.length ?? 100;
  if (seg.type.startsWith('curve')) {
    const angleRad = Math.abs((seg.angle ?? 90) * Math.PI / 180);
    return (seg.radius ?? 60) * angleRad;
  }
  return 100;
}

export function getTrackLength(line: RacingLinePoint[]): number {
  return line.length ? line[line.length - 1].s : 0;
}
