export type PieceType = 'start' | 'straight' | 'curve45' | 'curve90' | 'curve180';

export interface Track {
    name: string;
    width: number;
    segments: Segment[];
}

export interface Segment {
  id: string;
  type: PieceType;
  length?: number;   // for straight (pixels)
  radius?: number;   // for curves (pixels)
  angle?: number;    // signed degrees: + = left, - = right
  position: { x: number; y: number }; // start point of the segment (canvas px)
  heading: number;   // radians, tangent heading at start
}
