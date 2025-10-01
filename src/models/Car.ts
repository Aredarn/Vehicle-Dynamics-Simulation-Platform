import { CarState } from "../components/track-view/track-view.component";
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
    wheelbase!: number; // meters

    state: CarState = {
        segmentIndex: 0,
        distanceAlongSegment: 0,
        speed: 0,
        heading: 0,
        position: { x: 0, y: 0 }
    };

    constructor(settings: CarSettings) {
        this.updateSpecs(settings);
    }

    updateSpecs(settings: CarSettings) {
        console.log('Updating car specs:', settings);
        this.mass = settings.mass;
        this.enginePower = settings.enginePower;
        this.dragCoeff = settings.dragCoeff;
        this.frontalArea = settings.frontalArea;
        this.tireGrip = settings.tireGrip;
        this.downforce = settings.downforce;
    }

    update(dt: number, track: Segment[]) {
        if (track.length === 0) return;

        // Constants
        const rho = 1.225; // air density kg/m³
        const g = 9.81;

        // Forces
        const v = this.state.speed; // px/s (assume px ≈ m)
        const engineForce = (this.enginePower * 1000) / Math.max(v, 1); // W/v = N
        const dragForce = 0.5 * rho * this.dragCoeff * this.frontalArea * v * v;
        const normalForce = this.mass * g + this.downforce;
        const tireForce = this.tireGrip * normalForce;

        // Net force
        const traction = Math.min(engineForce, tireForce);
        const netForce = traction - dragForce;
        const accel = netForce / this.mass;

        // Update speed
        this.state.speed += accel * dt;
        if (this.state.speed < 0) this.state.speed = 0;

        // Move along track
        let remaining = this.state.speed * dt;
        while (remaining > 0) {
            const seg = track[this.state.segmentIndex];
            const segLength = this.getSegmentLength(seg);

            const leftInSeg = segLength - this.state.distanceAlongSegment;
            if (remaining < leftInSeg) {
                this.state.distanceAlongSegment += remaining;
                remaining = 0;
            } else {
                remaining -= leftInSeg;
                this.state.segmentIndex = (this.state.segmentIndex + 1) % track.length; // loop track
                this.state.distanceAlongSegment = 0;
            }
        }

        // Update position and heading
        const seg = track[this.state.segmentIndex];
        const interp = this.computePositionOnSegment(seg, this.state.distanceAlongSegment);
        this.state.position = { x: interp.x, y: interp.y };
        this.state.heading = interp.heading;
    }

    private getSegmentLength(seg: Segment): number {
        if (seg.type === 'straight') return seg.length ?? 100;
        if (seg.type.startsWith('curve')) {
            const angleRad = (seg.angle ?? 90) * Math.PI / 180;
            return (seg.radius ?? 60) * Math.abs(angleRad);
        }
        return 0;
    }

    private computePositionOnSegment(seg: Segment, dist: number) {
        if (seg.type === 'straight') {
            const x = seg.position.x + dist * Math.cos(seg.heading);
            const y = seg.position.y + dist * Math.sin(seg.heading);
            return { x, y, heading: seg.heading };
        }

        const R = seg.radius ?? 60;
        const angleRad = (seg.angle ?? 90) * Math.PI / 180;
        const sign = Math.sign(angleRad);
        const cx = seg.position.x - sign * R * Math.sin(seg.heading);
        const cy = seg.position.y + sign * R * Math.cos(seg.heading);

        const startAngle = Math.atan2(seg.position.y - cy, seg.position.x - cx);
        const arcFrac = dist / (R * Math.abs(angleRad));
        const newAngle = startAngle + arcFrac * angleRad;

        const x = cx + R * Math.cos(newAngle);
        const y = cy + R * Math.sin(newAngle);
        const heading = seg.heading + arcFrac * angleRad;

        return { x, y, heading };
    }
}