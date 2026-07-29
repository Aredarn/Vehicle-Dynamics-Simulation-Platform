import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges } from '@angular/core';

export interface TrendSeries {
  label: string;
  color: string;
  /** y-values indexed by generation (x is the array index + 1). */
  values: number[];
}

interface RenderedSeries {
  label: string;
  color: string;
  path: string;
  last: number | null;
}

/**
 * Small multi-series line chart drawn as inline SVG — no charting dependency.
 * Scales to its container via viewBox, so it stays crisp at any panel width.
 */
@Component({
  selector: 'app-trend-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './trend-chart.component.html',
  styleUrl: './trend-chart.component.scss',
})
export class TrendChartComponent implements OnChanges {
  @Input() title = '';
  @Input() unit = '';
  /** Values at or below this are treated as "no data" and skipped (e.g. lap time 0 = never finished). */
  @Input() ignoreAtOrBelow: number | null = null;
  @Input() height = 132;
  @Input() series: TrendSeries[] = [];

  /**
   * Rendering happens here rather than in a `series` setter: Angular assigns inputs in template
   * order, so a setter would render before `ignoreAtOrBelow` had been applied and would plot the
   * very values it is meant to skip.
   */
  ngOnChanges() {
    this.render();
  }

  readonly width = 320;
  readonly padLeft = 6;
  readonly padRight = 6;
  readonly padTop = 8;
  readonly padBottom = 16;

  rendered: RenderedSeries[] = [];
  yMin = 0;
  yMax = 1;
  xMax = 1;
  hasData = false;
  gridLines: number[] = [];

  private render() {
    const points = this.series.flatMap(s => s.values.filter(v => this.isValid(v)));
    this.hasData = points.length > 0;

    if (!this.hasData) {
      this.rendered = [];
      return;
    }

    const min = Math.min(...points);
    const max = Math.max(...points);
    const pad = (max - min) * 0.12 || Math.abs(max) * 0.12 || 1;
    this.yMin = min - pad;
    this.yMax = max + pad;
    this.xMax = Math.max(1, ...this.series.map(s => s.values.length));

    const plotH = this.height - this.padTop - this.padBottom;
    this.gridLines = [0, 0.5, 1].map(t => this.padTop + t * plotH);

    this.rendered = this.series.map(s => ({
      label: s.label,
      color: s.color,
      path: this.buildPath(s.values),
      last: this.lastValid(s.values),
    }));
  }

  private buildPath(values: number[]): string {
    const plotW = this.width - this.padLeft - this.padRight;
    const plotH = this.height - this.padTop - this.padBottom;
    const span = this.yMax - this.yMin || 1;

    let path = '';
    let penDown = false;

    values.forEach((value, index) => {
      if (!this.isValid(value)) {
        // Break the line rather than interpolating across generations with no result.
        penDown = false;
        return;
      }
      const x = this.padLeft + (this.xMax <= 1 ? plotW / 2 : (index / (this.xMax - 1)) * plotW);
      const y = this.padTop + plotH - ((value - this.yMin) / span) * plotH;
      path += `${penDown ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
      penDown = true;
    });

    return path.trim();
  }

  private lastValid(values: number[]): number | null {
    for (let i = values.length - 1; i >= 0; i--) {
      if (this.isValid(values[i])) return values[i];
    }
    return null;
  }

  private isValid(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (this.ignoreAtOrBelow !== null && value <= this.ignoreAtOrBelow) return false;
    return true;
  }

  format(value: number | null): string {
    if (value === null) return '—';
    const abs = Math.abs(value);
    if (abs >= 10000) return `${(value / 1000).toFixed(1)}k`;
    if (Number.isInteger(value)) return value.toFixed(0);
    if (abs >= 100) return value.toFixed(0);
    return value.toFixed(abs >= 10 ? 1 : 2);
  }
}
