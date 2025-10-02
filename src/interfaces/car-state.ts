export interface CarState {
    s: number;                  // total distance traveled along racing line (in meters)
    speed: number;              // current speed (m/s)
    heading: number;            // orientation (radians)
    position: { x: number, y: number }; // pixel coords for drawing
    racingLineIndex: number;    // optional: nearest index (for quick lookup, not core logic)
}

export type RacingLinePoint = {
    x: number;
    y: number;
    heading: number;
    s: number; 
};

