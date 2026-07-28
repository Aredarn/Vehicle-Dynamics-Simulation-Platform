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
  let best = { point: { x: 0, y: 0 }, index: 0, s: 0, heading: 0, distance: Infinity, offset: 0 };

  for (let i = 0; i < path.length - 1; i++) {
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

export function rayDistanceToTrackEdge(
  origin: { x: number; y: number },
  heading: number,
  segments: Segment[],
  maxDistance: number,
  step: number,
  radius: number
) {
  let dist = 0;
  while (dist <= maxDistance) {
    const x = origin.x + Math.cos(heading) * dist;
    const y = origin.y + Math.sin(heading) * dist;
    if (!isPointOnTrack({ x, y }, segments, radius)) {
      return dist;
    }
    dist += step;
  }
  return maxDistance;
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
  let minExcess = Infinity;
  for (const seg of segments) {
    const excess = segmentEdgeExcess(point, seg, radius);
    if (excess < minExcess) minExcess = excess;
    if (minExcess <= 0) return 0;
  }
  // A point outside every segment's span/arc entirely (not just past the edge of one) is
  // definitely off track — use a sentinel well past any grip-zone/death threshold.
  return Number.isFinite(minExcess) ? minExcess : 1000;
}

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
