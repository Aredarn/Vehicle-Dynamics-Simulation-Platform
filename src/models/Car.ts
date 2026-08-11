import { CarState, RacingLinePoint } from "../interfaces/car-state";
import { CarSettings } from "../services/car-settings.service";
import { calculateCorneringSpeedLimit, calculateLongitudinalAcceleration, calculatePerformance } from "../utils/car-physics";
import { TrackModel } from "../utils/track-geometry";

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
        const performance = calculatePerformance(settings);
        this.maxSpeed = performance.topSpeed / 3.6;
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
            const maxSpeed = calculateCorneringSpeedLimit(this.getSettingsSnapshot(), curvature, this.state.speed, Math.min(0.7, this.state.speed / this.maxSpeed));
            minTargetSpeed = Math.min(minTargetSpeed, maxSpeed);
        }

        return Math.max(minTargetSpeed, 5);
    }

    private distanceBetween(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    update(dt: number, track: TrackModel | null) {
        if (!track || !track.points.length) {
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

        const acceleration = calculateLongitudinalAcceleration(this.getSettingsSnapshot(), v, throttle, brake);

        v += acceleration * dt;
        v = Math.max(0, Math.min(v, this.maxSpeed));
        this.state.speed = v;

        this.moveAlongRacingLine(v, dt);
    }

    private getSettingsSnapshot(): CarSettings {
        return {
            name: 'Preview Car',
            presetId: 'custom',
            mass: this.mass,
            enginePower: this.enginePower,
            dragCoeff: this.dragCoeff,
            frontalArea: this.frontalArea,
            tireGrip: this.tireGrip,
            downforce: this.downforce,
            finalDrive: this.finalDrive,
            wheelbase: this.wheelbase,
        };
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

    /**
     * The unified track model already carries a uniformly resampled centreline, so this is now
     * just a copy — the per-segment arc sampling it used to do lives in the track builder.
     */
    computeRacingLine(track: TrackModel | null): RacingLinePoint[] {
        if (!track || track.points.length === 0) return [];
        return track.points.map(p => ({ ...p }));
    }

}
