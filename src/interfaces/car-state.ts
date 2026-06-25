export interface CarState {
    s: number;
    speed: number;
    heading: number;
    position: { x: number; y: number };
    racingLineIndex: number;
}

export type RacingLinePoint = {
    x: number;
    y: number;
    heading: number;
    s: number;
    targetSpeed?: number;
};
