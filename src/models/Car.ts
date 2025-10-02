import { CarState, RacingLinePoint } from "../interfaces/car-state";
import { CarSettings } from "../services/car-settings.service";
import { Segment } from "./Track";
const PX_PER_M = 3;      // 1m = 3px

export class Car {
    mass!: number;
    enginePower!: number;
    dragCoeff!: number;
    frontalArea!: number;
    tireGrip!: number;
    downforce!: number;
    finalDrive!: number;
    wheelbase!: number;

    state: CarState = {
        s: 0,                        // meters along racing line
        speed: 0,                    // m/s
        heading: 0,
        position: { x: 0, y: 0 },
        racingLineIndex: 0           // helper for interpolation
    };


    private currentRacingLine: RacingLinePoint[] = [];
    private maxSpeed = 80; // m/s (~288 km/h)
    constructor(settings: CarSettings) {
        this.updateSpecs(settings);
    }

    updateSpecs(settings: CarSettings) {
        this.mass = settings.mass;
        this.enginePower = settings.enginePower;
        this.dragCoeff = settings.dragCoeff;
        this.frontalArea = settings.frontalArea;
        this.tireGrip = settings.tireGrip;
        this.downforce = settings.downforce;
    }

    public resetCar() {
        this.state = {
            s: 0,
            speed: 0,
            heading: 0,
            position: { x: 0, y: 0 },
            racingLineIndex: 0
        };
        this.currentRacingLine = [];
    }

    update(dt: number, track: Segment[]) {
        if (!track.length) {
            // Reset racing line and car state when track is cleared
            this.currentRacingLine = [];
            this.state.s = 0;
            this.state.speed = 0;
            this.state.position = { x: 0, y: 0 };
            this.state.heading = 0;
            this.state.racingLineIndex = 0;
            return;
        }

        // Recompute racing line if none exists
        if (this.currentRacingLine.length === 0) {
            this.currentRacingLine = this.computeRacingLine(track);
            this.state.s = 0;
            this.state.racingLineIndex = 0;
            if (this.currentRacingLine.length === 0) return;
        }

        const g = 9.81;           // gravity
        const rho = 1.225;        // air density

        let v = this.state.speed;

        // ----------------------
        // 1. Compute target speed
        // ----------------------
        const targetSpeed = this.calculateTargetSpeed(); // fully physics-based

        // ----------------------
        // 2. Compute forces
        // ----------------------
        const dragForce = 0.5 * rho * this.dragCoeff * this.frontalArea * v * v;
        const rollingResistance = 0.015 * this.mass * g;

        // Engine force
        const maxEngineForce = this.enginePower * 500; // simple scaling
        const normalForce = this.mass * g + this.downforce;
        const maxTractionForce = this.tireGrip * normalForce;

        let engineForce = 0;
        let brakeForce = 0;

        // ----------------------
        // 3. Throttle/Brake Control
        // ----------------------
        const speedDiff = targetSpeed - v;

        if (speedDiff > 0.5) {
            // accelerate
            engineForce = Math.min(maxEngineForce, maxTractionForce);
        } else if (speedDiff < -0.5) {
            // brake
            brakeForce = maxTractionForce;
        } else {
            // maintain speed
            engineForce = 0.3 * maxEngineForce;
        }

        // ----------------------
        // 4. Net acceleration
        // ----------------------
        const netForce = engineForce - dragForce - rollingResistance - brakeForce;
        const acceleration = netForce / this.mass;

        // Update velocity
        v += acceleration * dt;
        v = Math.max(0, Math.min(v, this.maxSpeed));
        this.state.speed = v;

        // ----------------------
        // 5. Move along racing line
        // ----------------------
        this.moveAlongRacingLine(v, dt);
    }


    private calculateTargetSpeed(): number {
        const currentIdx = Math.floor(this.state.racingLineIndex);

        if (currentIdx >= this.currentRacingLine.length - 1 || this.currentRacingLine.length < 2) {
            return 20; // default safe speed
        }

        let minTargetSpeed = this.maxSpeed;

        // Maximum lateral acceleration the car can sustain (m/s²)
        const g = 9.81;
        const normalForce = this.mass * g + this.downforce;      // N
        const maxLatAcc = this.tireGrip * normalForce / this.mass; // m/s²

        // Look ahead a few segments
        const lookaheadSteps = 25;
        for (let i = 0; i < lookaheadSteps; i++) {
            const idx = currentIdx + i * 4;

            if (idx >= this.currentRacingLine.length - 1) continue;

            const p1 = this.currentRacingLine[idx];
            const p2 = this.currentRacingLine[idx + 1];

            if (!p1 || !p2) continue;

            const headingChange = this.normalizeAngle(p2.heading - p1.heading);
            const distance = this.distanceBetween(p1, p2);

            if (distance < 0.01) continue;

            const curvature = Math.abs(headingChange / distance); // 1/m

            // Max speed for this curve: v = sqrt(a_lat / curvature)
            const maxSpeedCurve = Math.sqrt(maxLatAcc / Math.max(curvature, 0.0001));

            minTargetSpeed = Math.min(minTargetSpeed, maxSpeedCurve);
        }

        // Clamp min speed
        minTargetSpeed = Math.max(minTargetSpeed, 5); // minimum speed 5 m/s

        return minTargetSpeed;
    }


    private normalizeAngle(angle: number): number {
        // Keep angle between -PI and PI
        while (angle > Math.PI) angle -= 2 * Math.PI;
        while (angle < -Math.PI) angle += 2 * Math.PI;
        return angle;
    }

    private distanceBetween(p1: { x: number, y: number }, p2: { x: number, y: number }): number {
        return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    }

    moveAlongRacingLine(v: number, dt: number) {
        if (this.currentRacingLine.length < 2) return;

        this.state.s += v * dt;

        const totalLength = this.currentRacingLine[this.currentRacingLine.length - 1].s;

        // Looping
        if (this.state.s > totalLength) {
            this.state.s = this.state.s % totalLength;
            this.state.racingLineIndex = 0; // reset index for clean interpolation
        }

        const pos = this.interpolatePosition(this.state.s, this.currentRacingLine);

        this.state.position = { x: pos.x, y: pos.y };
        this.state.heading = pos.heading;
    }


    interpolatePosition(s: number, racingLine: RacingLinePoint[]) {
        let i = this.state.racingLineIndex;

        // advance index until we find segment containing s
        while (i < racingLine.length - 1 && racingLine[i + 1].s < s) {
            i++;
        }
        this.state.racingLineIndex = i;

        const p1 = racingLine[i];
        const p2 = racingLine[i + 1];

        const t = (s - p1.s) / (p2.s - p1.s);
        const x = p1.x + t * (p2.x - p1.x);
        const y = p1.y + t * (p2.y - p1.y);
        const heading = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        return { x, y, heading };
    }

    computeRacingLine(track: Segment[]): RacingLinePoint[] {
        if (track.length === 0) return [];

        const racingLine: RacingLinePoint[] = [];
        let totalS = 0;
        let prevPoint: { x: number, y: number } | null = null;

        for (const seg of track) {
            const segLength = this.getSegmentLength(seg);
            const steps = Math.max(20, Math.ceil(segLength * 2));

            for (let i = 0; i <= steps; i++) {
                const distance = (i / steps) * segLength;
                const point = this.computeCenterPoint(seg, distance); // {x, y, heading}

                if (prevPoint) {
                    const dx = (point.x - prevPoint.x) / PX_PER_M;
                    const dy = (point.y - prevPoint.y) / PX_PER_M;
                    totalS += Math.sqrt(dx * dx + dy * dy);
                }

                racingLine.push({
                    x: point.x,
                    y: point.y,
                    heading: point.heading,
                    s: totalS
                });

                prevPoint = point;
            }
        }

        return this.smoothRacingLine(racingLine);
    }

    private computeCenterPoint(seg: Segment, distance: number): { x: number, y: number, heading: number } {
        // Always use center line - this ensures the racing line stays on track
        if (seg.type === 'straight' || seg.type === 'start') {
            const x = seg.position.x + distance * Math.cos(seg.heading);
            const y = seg.position.y + distance * Math.sin(seg.heading);
            return { x, y, heading: seg.heading };
        }

        if (seg.type.startsWith('curve')) {
            const R = seg.radius ?? 60;
            const angleDeg = seg.angle ?? 90;
            const angleRad = angleDeg * Math.PI / 180;
            const turnDirection = Math.sign(angleDeg);

            const cx = seg.position.x - turnDirection * R * Math.sin(seg.heading);
            const cy = seg.position.y + turnDirection * R * Math.cos(seg.heading);

            const startAngle = Math.atan2(seg.position.y - cy, seg.position.x - cx);
            const arcLength = R * Math.abs(angleRad);
            const arcFraction = distance / Math.max(arcLength, 0.001);

            const endAngle = startAngle + turnDirection * arcFraction * Math.abs(angleRad);

            const x = cx + R * Math.cos(endAngle);
            const y = cy + R * Math.sin(endAngle);
            const heading = seg.heading + turnDirection * arcFraction * Math.abs(angleRad);

            return { x, y, heading };
        }

        return { x: seg.position.x, y: seg.position.y, heading: seg.heading };
    }

    private getSegmentLength(seg: Segment): number {
        if (seg.type === 'straight' || seg.type === 'start') return seg.length ?? 100;
        if (seg.type.startsWith('curve')) {
            const angleRad = Math.abs((seg.angle ?? 90) * Math.PI / 180);
            return (seg.radius ?? 60) * angleRad;
        }
        return 100;
    }

    private smoothRacingLine(points: RacingLinePoint[]): RacingLinePoint[] {
        if (points.length < 3) return points;

        let smoothed = [...points];

        for (let pass = 0; pass < 2; pass++) {
            const newPoints = [...smoothed];

            for (let i = 1; i < smoothed.length - 1; i++) {
                newPoints[i] = {
                    x: (smoothed[i - 1].x * 0.25 + smoothed[i].x * 0.5 + smoothed[i + 1].x * 0.25),
                    y: (smoothed[i - 1].y * 0.25 + smoothed[i].y * 0.5 + smoothed[i + 1].y * 0.25),
                    heading: smoothed[i].heading,
                    s: smoothed[i].s // ✅ keep distance unchanged
                };
            }

            smoothed = newPoints;
        }

        return smoothed;
    }

}