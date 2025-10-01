export interface CarState {
  segmentIndex: number;
  distanceAlongSegment: number; // in pixels
  speed: number;               // pixels per second
  heading: number;             // radians
  position: { x: number; y: number };
  racingLineIndex: number;
}
