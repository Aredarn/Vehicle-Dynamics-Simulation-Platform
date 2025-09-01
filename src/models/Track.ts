export interface Track {
    name: string;
    width: number;
    segments: Segment[];
}

export interface Segment {
    type: string;
    length?: number;
    radius?: number;
    angle?: number;
}
