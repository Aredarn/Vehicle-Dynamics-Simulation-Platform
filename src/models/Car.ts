import { CarState, RacingLinePoint } from "../interfaces/car-state";
import { CarSettings } from "../services/car-settings.service";
import { Segment } from "./Track";

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
        s: 0,
        speed: 0,
        heading: 0,
        position: { x: 0, y: 0 },
        racingLineIndex: 0
    };

    private currentRacingLine: RacingLinePoint[] = [];
    private maxSpeed = 120;

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
        this.finalDrive = settings.finalDrive;
        this.wheelbase = settings.wheelbase;
        this.invalidateRacingLine();
    }

    invalidateRacingLine() {
        this.currentRacingLine = [];
    }

    setOptimizedRacingLine(line: RacingLinePoint[]) {
        this.currentRacingLine = line;
        this.state.s = 0;
        this.state.racingLineIndex = 0;
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

    getRacingLine(): RacingLinePoint[] {
        return this.currentRacingLine;
    }

    private calculateTargetSpeed(): number {
        const idx = Math.floor(this.state.racingLineIndex);

        if (idx >= this.currentRacingLine.length - 1 || this.currentRacingLine.length < 2) {
            return 20;
        }

        const current = this.currentRacingLine[idx];
        if (current.targetSpeed !== undefined) {
            return current.targetSpeed;
        }

        let minTargetSpeed = this.maxSpeed;
        const lookaheadPoints = 12;
        const step = 4;

        for (let i = 0; i < lookaheadPoints; i++) {
            const lookaheadIdx = idx + i * step;
            if (lookaheadIdx >= this.currentRacingLine.length - 1) break;

            const p1 = this.currentRacingLine[lookaheadIdx];
            const p2 = this.currentRacingLine[lookaheadIdx + 1];

            const headingChange = Math.abs(this.normalizeAngle(p2.heading - p1.heading));
            const distance = this.distanceBetween(p1, p2);
            if (distance < 0.01) continue;

            const curvature = headingChange / distance;
            const normalForce = this.mass * 9.81 + this.downforce;
            const maxLatAcc = this.tireGrip * normalForce / this.mass;
            const maxSpeed = Math.sqrt(maxLatAcc / Math.max(curvature, 0.0001));

            minTargetSpeed = Math.min(minTargetSpeed, maxSpeed);
        }

        return Math.max(minTargetSpeed, 5);
    }

    private distanceBetween(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    update(dt: number, track: Segment[]) {
        if (!track.length) {
            this.currentRacingLine = [];
            this.state.s = 0;
            this.state.speed = 0;
            this.state.position = { x: 0, y: 0 };
            this.state.heading = 0;
            this.state.racingLineIndex = 0;
            return;
        }

        if (this.currentRacingLine.length === 0) {
            this.currentRacingLine = this.computeRacingLine(track);
            this.state.s = 0;
            this.state.racingLineIndex = 0;
            if (this.currentRacingLine.length === 0) return;
        }

        const rho = 1.225;
        const g = 9.81;
        let v = this.state.speed;
        const targetSpeed = this.calculateTargetSpeed();
        const margin = 0.1 * targetSpeed;

        let throttle = 0;
        let brake = 0;

        if (v < targetSpeed - margin) {
            throttle = 1.0;
        } else if (v > targetSpeed + margin) {
            brake = 1.0;
        } else {
            throttle = 0.3;
        }

        const normalForce = this.mass * g + this.downforce;
        const dragForce = 0.5 * rho * this.dragCoeff * this.frontalArea * v * v;
        const rollingResistance = 0.02 * normalForce;
        const maxTractionForce = this.tireGrip * normalForce;

        const engineForce = throttle > 0
            ? Math.min(this.computeEngineForce(v, throttle), maxTractionForce)
            : 0;

        const brakeForce = brake > 0 ? brake * maxTractionForce : 0;
        const netForce = engineForce - dragForce - rollingResistance - brakeForce;
        const acceleration = netForce / this.mass;

        v += acceleration * dt;
        v = Math.max(0, Math.min(v, this.maxSpeed));
        this.state.speed = v;

        this.moveAlongRacingLine(v, dt);
    }

    private computeEngineForce(speed: number, throttle: number): number {
        const powerW = this.enginePower * 1000;
        const driveRatio = this.finalDrive / 3.8;
        return throttle * (speed > 0.5 ? powerW / speed : powerW) * driveRatio;
    }

    private normalizeAngle(angle: number): number {
        while (angle > Math.PI) angle -= 2 * Math.PI;
        while (angle < -Math.PI) angle += 2 * Math.PI;
        return angle;
    }

    moveAlongRacingLine(v: number, dt: number) {
        if (this.currentRacingLine.length < 2) return;

        this.state.s += v * dt;
        const totalLength = this.currentRacingLine[this.currentRacingLine.length - 1].s;

        if (this.state.s > totalLength) {
            this.state.s = this.state.s % totalLength;
            this.state.racingLineIndex = 0;
        }

        const pos = this.interpolatePosition(this.state.s, this.currentRacingLine);
        this.state.position = { x: pos.x, y: pos.y };
        this.state.heading = pos.heading;
    }

    interpolatePosition(s: number, racingLine: RacingLinePoint[]) {
        let i = this.state.racingLineIndex;

        while (i < racingLine.length - 1 && racingLine[i + 1].s < s) {
            i++;
        }
        this.state.racingLineIndex = i;

        const p1 = racingLine[i];
        const p2 = racingLine[i + 1] ?? p1;
        const ds = p2.s - p1.s;
        const t = ds > 0 ? (s - p1.s) / ds : 0;
        const x = p1.x + t * (p2.x - p1.x);
        const y = p1.y + t * (p2.y - p1.y);
        const heading = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        return { x, y, heading };
    }

    computeRacingLine(track: Segment[]): RacingLinePoint[] {
        if (track.length === 0) return [];

        const racingLine: RacingLinePoint[] = [];
        let totalS = 0;
        let prevPoint: { x: number; y: number } | null = null;

        for (const seg of track) {
            const segLength = this.getSegmentLength(seg);
            const steps = Math.max(20, Math.ceil(segLength * 2));

            for (let i = 0; i <= steps; i++) {
                const distance = (i / steps) * segLength;
                const point = this.computeCenterPoint(seg, distance);

                if (prevPoint) {
                    const dx = point.x - prevPoint.x;
                    const dy = point.y - prevPoint.y;
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

    private computeCenterPoint(seg: Segment, distance: number): { x: number; y: number; heading: number } {
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
                    x: smoothed[i - 1].x * 0.25 + smoothed[i].x * 0.5 + smoothed[i + 1].x * 0.25,
                    y: smoothed[i - 1].y * 0.25 + smoothed[i].y * 0.5 + smoothed[i + 1].y * 0.25,
                    heading: smoothed[i].heading,
                    s: smoothed[i].s
                };
            }

            smoothed = newPoints;
        }

        return smoothed;
    }
}
