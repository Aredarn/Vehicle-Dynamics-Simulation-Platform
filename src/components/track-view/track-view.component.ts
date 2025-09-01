import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

type PieceType = 'start' | 'straight' | 'curve45' | 'curve90' | 'curve180';
type Direction = 'left' | 'right';

interface Segment {
  id: string;
  type: PieceType;
  length?: number;   // for straight (pixels)
  radius?: number;   // for curves (pixels)
  angle?: number;    // signed degrees: + = left, - = right
  position: { x: number; y: number }; // start point of the segment (canvas px)
  heading: number;   // radians, tangent heading at start
}


//Current position of the Car 
interface CarState {
  segmentIndex: number;
  distanceAlongSegment: number; // in pixels
  speed: number;               // pixels per second
  heading: number;             // radians
  position: { x: number; y: number };
}



@Component({
  selector: 'app-track-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './track-view.component.html',
  styleUrls: ['./track-view.component.scss']
})
export class TrackViewComponent implements AfterViewInit {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  // palette
  palette = [
    { label: 'Start', type: 'start' as PieceType, length: 40 },
    { label: 'Straight 100', type: 'straight' as PieceType, length: 100 },
    { label: 'Curve 45°', type: 'curve45' as PieceType, radius: 60, angle: 45 },
    { label: 'Curve 90°', type: 'curve90' as PieceType, radius: 60, angle: 90 },
    { label: 'Curve 180°', type: 'curve180' as PieceType, radius: 60, angle: 180 },
  ];

  segments: Segment[] = [];
  private dragPreview: any = null;
  private previewTurnRight = false; // flip curve direction during drag
  private ctx!: CanvasRenderingContext2D;

  ngAfterViewInit(): void {
    const ctx = this.canvasRef.nativeElement.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.drawAll();

    // keyboard toggles
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r') { this.previewTurnRight = !this.previewTurnRight; this.drawAll(); }
    });
  }

  // ---------- Drag & Drop ----------
  onDragStart(piece: any) {
    this.dragPreview = { ...piece };
  }

  onDragOver(ev: DragEvent) { ev.preventDefault(); }

  onDrop(ev: DragEvent) {
    ev.preventDefault();
    if (!this.dragPreview) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const dropX = (ev.clientX - rect.left);
    const dropY = (ev.clientY - rect.top);

    if (this.dragPreview.type === 'start') {
      // place start with a default heading (0) -- user can rotate start later if you add that UI
      const seg: Segment = {
        id: crypto.randomUUID(),
        type: 'start',
        position: { x: dropX, y: dropY },
        heading: 0,
        length: this.dragPreview.length
      };
      this.segments = [seg]; // new track
    } else {
      if (this.segments.length === 0 || this.segments[0].type !== 'start') {
        alert('Place a Start piece first.');
        this.dragPreview = null; return;
      }
      const last = this.segments[this.segments.length - 1];
      const next = this.buildNextFrom(last, this.dragPreview, this.previewTurnRight);
      this.segments.push(next);
    }

    this.dragPreview = null;
    this.drawAll();
  }

  // ---------- Builders & Geometry ----------
  // Create the next segment snapped to the last segment's END (correct chaining)
  private buildNextFrom(last: Segment, piece: any, turnRight: boolean): Segment {
    const lastEnd = this.computeEndOf(last); // { x, y, heading }
    const baseHeading = lastEnd.heading;

    if (piece.type === 'straight') {
      const seg: Segment = {
        id: crypto.randomUUID(),
        type: 'straight',
        length: piece.length ?? 100,
        position: { x: lastEnd.x, y: lastEnd.y },
        heading: baseHeading
      };
      return seg;
    }

    // curve pieces
    if (['curve45', 'curve90', 'curve180'].includes(piece.type)) {
      // determine angle degrees from palette or type
      const angleDeg = piece.angle ?? Number(piece.type.replace('curve', '')) ?? 90;
      const signedDeg = turnRight ? -Math.abs(angleDeg) : Math.abs(angleDeg); // + left, - right

      const seg: Segment = {
        id: crypto.randomUUID(),
        type: piece.type as PieceType,
        radius: piece.radius ?? 60,
        angle: signedDeg, // store signed degrees
        position: { x: lastEnd.x, y: lastEnd.y }, // START of this curve = last's END
        heading: baseHeading
      };
      return seg;
    }

    // fallback (shouldn't happen)
    return {
      id: crypto.randomUUID(),
      type: 'straight',
      length: 50,
      position: { x: lastEnd.x, y: lastEnd.y },
      heading: baseHeading
    };
  }

  // Compute end position and end heading of ANY segment (single source of truth)
  // returns { x, y, heading }
  private computeEndOf(seg: Segment): { x: number; y: number; heading: number } {
    const x0 = seg.position.x;
    const y0 = seg.position.y;
    let θ = seg.heading; // start heading (radians)

    // start segment: zero length, heading unchanged
    if (seg.type === 'start') {
      return { x: x0, y: y0, heading: θ };
    }

    // straight: move forward by length along heading
    if (seg.type === 'straight') {
      const L = seg.length ?? 0;
      const x1 = x0 + L * Math.cos(θ);
      const y1 = y0 + L * Math.sin(θ);
      return { x: x1, y: y1, heading: θ };
    }

    // curves: any of curve45/90/180 - seg.angle is signed degrees
    if (['curve45', 'curve90', 'curve180'].includes(seg.type)) {
      const R = seg.radius ?? 60;
      const angleDeg = seg.angle ?? Number(seg.type.replace('curve', '')) ?? 90;
      const angleRad = (angleDeg * Math.PI) / 180; // signed radians

      const sign = Math.sign(angleRad) || 1; // + left(CCW), - right(CW)

      // center of curvature is perpendicular to start heading:
      // left center offset vector = (-sinθ, cosθ) * R
      // right center offset vector = ( sinθ,-cosθ) * R  (same formula with sign)
      const cx = x0 - sign * R * Math.sin(θ);
      const cy = y0 + sign * R * Math.cos(θ);

      // compute angle from center to start point:
      const startAngle = Math.atan2(y0 - cy, x0 - cx); // angle of radius vector to start
      const endAngle = startAngle + angleRad;         // rotate by signed angleRad

      const x1 = cx + R * Math.cos(endAngle);
      const y1 = cy + R * Math.sin(endAngle);

      const newHeading = θ + angleRad; // tangent rotates by the same signed angle

      return { x: x1, y: y1, heading: newHeading };
    }

    // fallback
    return { x: x0, y: y0, heading: θ };
  }

  // ---------- Drawing of TRACK----------
  private drawAll() {
    const ctx = this.ctx;
    const canvas = this.canvasRef.nativeElement;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // simple grid for reference
    this.drawGrid(40);

    // draw placed segments
    for (const s of this.segments) this.drawSegment(s);

    // optionally draw ghost preview at end
    if (this.dragPreview && this.segments.length) {
      const last = this.segments[this.segments.length - 1];
      const next = this.buildNextFrom(last, this.dragPreview, this.previewTurnRight);
      this.drawSegment(next, true); // draw preview ghost
    }
  }

  private drawGrid(step: number) {
    const ctx = this.ctx; const w = this.canvasRef.nativeElement.width; const h = this.canvasRef.nativeElement.height;
    ctx.save(); ctx.strokeStyle = '#f0f3f7'; ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.restore();
  }

  private drawSegment(seg: Segment, ghost = false) {
    if (seg.type === 'start') return this.drawStart(seg, ghost);
    if (seg.type === 'straight') return this.drawStraight(seg, ghost);
    if (['curve45', 'curve90', 'curve180'].includes(seg.type)) return this.drawCurve(seg, ghost);
  }

  private drawStart(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(seg.position.x, seg.position.y);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.fillStyle = '#06b6d4';
    ctx.fillRect(-8, -8, 16, 16);
    ctx.restore();
  }

  private drawStraight(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const L = seg.length ?? 100;
    const w = 12;
    ctx.save();
    ctx.translate(seg.position.x, seg.position.y);
    ctx.rotate(seg.heading);
    ctx.globalAlpha = ghost ? 0.4 : 1;

    // road rect
    ctx.fillStyle = '#374151';
    ctx.beginPath();
    ctx.rect(0, -w / 2, L, w);
    ctx.fill();

    // centerline
    ctx.strokeStyle = '#ffffff22';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(L, 0); ctx.stroke();

    ctx.restore();
  }

  private drawCurve(seg: Segment, ghost = false) {
    const ctx = this.ctx;
    const R = seg.radius ?? 60;
    const angleRad = (seg.angle ?? Number(seg.type.replace('curve', '')) ?? 90) * Math.PI / 180;
    const sign = Math.sign(angleRad) || 1;

    const x0 = seg.position.x, y0 = seg.position.y, θ = seg.heading;
    // center same formula used by computeEndOf
    const cx = x0 - sign * R * Math.sin(θ);
    const cy = y0 + sign * R * Math.cos(θ);

    // angles relative to center
    const startAngle = Math.atan2(y0 - cy, x0 - cx);
    const endAngle = startAngle + angleRad;

    const roadWidth = 12;

    ctx.save();
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.fillStyle = '#374151';
    ctx.beginPath();
    // outer arc
    ctx.arc(cx, cy, R + roadWidth / 2, startAngle, endAngle, angleRad < 0);
    // inner arc (reverse direction)
    ctx.arc(cx, cy, R - roadWidth / 2, endAngle, startAngle, angleRad >= 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

  }



  //CAR LOGIC

  private drawCar(state: CarState) {
  const ctx = this.ctx;
  ctx.save();
  ctx.translate(state.position.x, state.position.y);
  ctx.rotate(state.heading);

  // Car body
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(-15, -8, 30, 16);

  // Suspension + tires
  const wheelOffsetX = 12;
  const wheelOffsetY = 6;

  ctx.fillStyle = '#111';
  // Front-left
  ctx.fillRect(-wheelOffsetX, -wheelOffsetY, 5, 5);
  // Front-right
  ctx.fillRect(-wheelOffsetX, wheelOffsetY-5, 5, 5);
  // Rear-left
  ctx.fillRect(wheelOffsetX-5, -wheelOffsetY, 5, 5);
  // Rear-right
  ctx.fillRect(wheelOffsetX-5, wheelOffsetY-5, 5, 5);

  ctx.restore();
}

}
