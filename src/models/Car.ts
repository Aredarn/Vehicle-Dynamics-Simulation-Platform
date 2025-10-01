import { CarState } from "../interfaces/car-state";
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
        segmentIndex: 0,
        distanceAlongSegment: 0,
        speed: 0,
        heading: 0,
        position: { x: 0, y: 0 },
        racingLineIndex: 0
    };

    private currentRacingLine: { x: number, y: number, heading: number }[] = [];
    private lookaheadDistance = 50;
    private maxSpeed = 80;

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

    update(dt: number, track: Segment[]) {
        if (!track.length) return;

        // Ensure racing line is computed
        if (this.currentRacingLine.length === 0) {
            this.currentRacingLine = this.computeRacingLine(track);
            if (this.currentRacingLine.length === 0) return;
            this.state.racingLineIndex = 0;
        }

        const rho = 1.225;
        const g = 9.81;
        let v = this.state.speed;

        // Calculate target speed based on upcoming curvature
        const targetSpeed = this.calculateTargetSpeed();

        // Calculate forces
        const dragForce = 0.5 * rho * this.dragCoeff * this.frontalArea * v * v;
        const rollingResistance = 0.02 * this.mass * g;

        // Simple throttle/brake control
        let throttle = 0;
        let brake = 0;

        if (v < targetSpeed * 0.9) {
            throttle = 1.0;
        } else if (v > targetSpeed * 1.1) {
            brake = 1.0;
        } else {
            throttle = 0.3;
        }

        // Engine force
        let engineForce = 0;
        if (throttle > 0) {
            const maxEngineForce = this.enginePower * 500;
            const normalForce = this.mass * g + this.downforce;
            const maxTractionForce = this.tireGrip * normalForce * 0.8;
            engineForce = Math.min(throttle * maxEngineForce, maxTractionForce);
        }

        // Brake force
        const brakeForce = brake * this.tireGrip * (this.mass * g + this.downforce);

        // Net force
        const netForce = engineForce - dragForce - rollingResistance - brakeForce;
        const acceleration = netForce / this.mass;

        // Update velocity
        v += acceleration * dt;
        v = Math.max(0, Math.min(v, this.maxSpeed));
        this.state.speed = v;

        // Move along racing line - FIXED BOUNDS CHECKING
        this.moveAlongRacingLine(v, dt);
    }

    private calculateTargetSpeed(): number {
        const currentIdx = Math.floor(this.state.racingLineIndex);

        // Safety check - if we don't have enough points, return safe speed
        if (currentIdx >= this.currentRacingLine.length - 1 || this.currentRacingLine.length < 2) {
            return 20; // Safe speed when near end or not enough points
        }

        let minTargetSpeed = this.maxSpeed;

        // Look ahead for curves with proper bounds checking
        for (let i = 0; i < 8; i++) {
            const lookaheadIdx = currentIdx + i * 3;

            // SAFETY CHECK: Ensure we don't go beyond array bounds
            if (lookaheadIdx >= this.currentRacingLine.length - 1) {
                continue; // Skip if beyond bounds
            }

            const currentPoint = this.currentRacingLine[lookaheadIdx];
            const nextPoint = this.currentRacingLine[lookaheadIdx + 1];

            // SAFETY CHECK: Ensure points exist
            if (!currentPoint || !nextPoint) {
                continue;
            }

            const headingChange = Math.abs(this.normalizeAngle(nextPoint.heading - currentPoint.heading));
            const distance = this.distanceBetween(currentPoint, nextPoint);

            if (distance > 0.1 && headingChange > 0.05) {
                const curvature = headingChange / distance;
                const maxCorneringSpeed = 10 + (30 / (1 + curvature * 20));
                minTargetSpeed = Math.min(minTargetSpeed, maxCorneringSpeed);
            }
        }

        return Math.max(minTargetSpeed, 8); // Minimum speed of 8 m/s
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

    private moveAlongRacingLine(speed: number, dt: number) {
        if (this.currentRacingLine.length < 4) return;

        const distanceToMove = speed * dt;
        this.state.racingLineIndex += distanceToMove;

        // Handle looping
        while (this.state.racingLineIndex >= this.currentRacingLine.length) {
            this.state.racingLineIndex -= this.currentRacingLine.length;
        }

        // Get four points for cubic interpolation (prev, current, next, next+1)
        const index = Math.floor(this.state.racingLineIndex);
        const t = this.state.racingLineIndex - index;

        const prevIndex = (index - 1 + this.currentRacingLine.length) % this.currentRacingLine.length;
        const currentIndex = index;
        const nextIndex = (index + 1) % this.currentRacingLine.length;
        const nextNextIndex = (index + 2) % this.currentRacingLine.length;

        // Safety checks
        const indices = [prevIndex, currentIndex, nextIndex, nextNextIndex];
        for (const idx of indices) {
            if (idx < 0 || idx >= this.currentRacingLine.length || !this.currentRacingLine[idx]) {
                this.state.racingLineIndex = 0;
                return;
            }
        }

        const p0 = this.currentRacingLine[prevIndex];
        const p1 = this.currentRacingLine[currentIndex];
        const p2 = this.currentRacingLine[nextIndex];
        const p3 = this.currentRacingLine[nextNextIndex];

        // Cubic interpolation for smoother movement
        this.state.position.x = this.cubicInterpolate(p0.x, p1.x, p2.x, p3.x, t);
        this.state.position.y = this.cubicInterpolate(p0.y, p1.y, p2.y, p3.y, t);

        // For heading, use linear interpolation between current and next (smoother)
        let headingDiff = p2.heading - p1.heading;
        if (headingDiff > Math.PI) headingDiff -= 2 * Math.PI;
        if (headingDiff < -Math.PI) headingDiff += 2 * Math.PI;

        this.state.heading = p1.heading + headingDiff * t;
        this.state.heading = this.normalizeAngle(this.state.heading);
    }

    private cubicInterpolate(p0: number, p1: number, p2: number, p3: number, t: number): number {
        // Catmull-Rom spline interpolation
        const t2 = t * t;
        const t3 = t2 * t;

        return 0.5 * (
            (2 * p1) +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        );
    }

    computeRacingLine(track: Segment[]): { x: number, y: number, heading: number }[] {
        if (track.length === 0) return [];
        const racingLine: { x: number, y: number, heading: number }[] = [];

        // Generate more points for smoother movement
        for (const seg of track) {
            const segLength = this.getSegmentLength(seg);
            const steps = Math.max(20, Math.ceil(segLength * 2)); // More points!

            for (let i = 0; i <= steps; i++) {
                const distance = (i / steps) * segLength;
                const point = this.computeCenterPoint(seg, distance);
                racingLine.push(point);
            }
        }

        return this.smoothRacingLine(racingLine);
    }

    private generateSegmentPoints(seg: Segment): { x: number, y: number, heading: number }[] {
        const points: { x: number, y: number, heading: number }[] = [];
        const segLength = this.getSegmentLength(seg);

        // Generate enough points for smooth movement
        const steps = Math.max(8, Math.ceil(segLength));

        for (let i = 0; i <= steps; i++) {
            const distance = (i / steps) * segLength;
            const point = this.computeCenterPoint(seg, distance);
            points.push(point);
        }

        return points;
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

    private smoothRacingLine(points: { x: number, y: number, heading: number }[]): { x: number, y: number, heading: number }[] {
        if (points.length < 3) return points;

        let smoothed = [...points];

        // Gentle smoothing to remove wobbles but preserve track alignment
        for (let pass = 0; pass < 2; pass++) {
            const newPoints = [...smoothed];

            for (let i = 1; i < smoothed.length - 1; i++) {
                newPoints[i] = {
                    x: (smoothed[i - 1].x * 0.25 + smoothed[i].x * 0.5 + smoothed[i + 1].x * 0.25),
                    y: (smoothed[i - 1].y * 0.25 + smoothed[i].y * 0.5 + smoothed[i + 1].y * 0.25),
                    heading: smoothed[i].heading
                };
            }

            smoothed = newPoints;
        }

        return smoothed;
    }
}