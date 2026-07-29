import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { AIDrivingService, AITrainingHistoryEntry, AITrainingRun } from '../../services/ai-driving.service';
import { ModelLibraryService } from '../../services/model-library.service';
import { IconComponent } from '../icon/icon.component';
import { TrendChartComponent, TrendSeries } from '../trend-chart/trend-chart.component';

const SERIES_COLORS = [
  'var(--data-1)',
  'var(--data-2)',
  'var(--data-3)',
  'var(--data-4)',
  'var(--data-5)',
];

@Component({
  selector: 'app-results-panel',
  standalone: true,
  imports: [CommonModule, IconComponent, TrendChartComponent],
  templateUrl: './results-panel.component.html',
  styleUrl: './results-panel.component.scss'
})
export class ResultsPanelComponent implements OnInit, OnDestroy {
  runs: AITrainingRun[] = [];
  selectedGeneration: number | null = null;

  /** Runs plotted on the charts. Defaults to the newest run; more can be added to compare. */
  comparedRunIds = new Set<string>();
  activeRunId: string | null = null;

  fitnessSeries: TrendSeries[] = [];
  lapSeries: TrendSeries[] = [];
  survivalSeries: TrendSeries[] = [];

  private runsSub!: Subscription;
  private selectedSub!: Subscription;

  constructor(
    private aiDrivingService: AIDrivingService,
    private modelLibrary: ModelLibraryService,
  ) {}

  ngOnInit() {
    this.runsSub = this.aiDrivingService.runs$.subscribe(runs => {
      const isNewRun = runs.length > this.runs.length;
      this.runs = runs;

      // Follow the newest run automatically; keep any manual comparison selection.
      if (isNewRun && runs.length) {
        const newest = runs[runs.length - 1];
        this.activeRunId = newest.id;
        this.comparedRunIds = new Set([newest.id]);
      }
      if (!this.comparedRunIds.size && runs.length) {
        this.comparedRunIds.add(runs[runs.length - 1].id);
        this.activeRunId = runs[runs.length - 1].id;
      }

      this.rebuildSeries();
    });

    this.selectedSub = this.aiDrivingService.selectedHistoryEntry$.subscribe(entry => {
      this.selectedGeneration = entry?.generation ?? null;
    });
  }

  ngOnDestroy() {
    this.runsSub?.unsubscribe();
    this.selectedSub?.unsubscribe();
  }

  // ---------- Run selection ----------
  get activeRun(): AITrainingRun | null {
    return this.runs.find(run => run.id === this.activeRunId) ?? null;
  }

  get comparedRuns(): AITrainingRun[] {
    return this.runs.filter(run => this.comparedRunIds.has(run.id));
  }

  get isComparing(): boolean {
    return this.comparedRunIds.size > 1;
  }

  selectRun(run: AITrainingRun) {
    this.activeRunId = run.id;
    if (!this.comparedRunIds.has(run.id)) {
      this.comparedRunIds.add(run.id);
      this.rebuildSeries();
    }
  }

  toggleCompare(run: AITrainingRun, event: Event) {
    event.stopPropagation();
    if (this.comparedRunIds.has(run.id)) {
      // Keep at least one run plotted.
      if (this.comparedRunIds.size === 1) return;
      this.comparedRunIds.delete(run.id);
    } else {
      this.comparedRunIds.add(run.id);
    }
    this.rebuildSeries();
  }

  isCompared(run: AITrainingRun): boolean {
    return this.comparedRunIds.has(run.id);
  }

  runColor(run: AITrainingRun): string {
    const index = this.runs.findIndex(r => r.id === run.id);
    return SERIES_COLORS[index % SERIES_COLORS.length];
  }

  private rebuildSeries() {
    const runs = this.comparedRuns;
    this.fitnessSeries = runs.map(run => ({
      label: this.shortLabel(run),
      color: this.runColor(run),
      values: run.entries.map(e => e.bestFitness),
    }));
    this.lapSeries = runs.map(run => ({
      label: this.shortLabel(run),
      color: this.runColor(run),
      values: run.entries.map(e => e.bestLapTime),
    }));
    this.survivalSeries = runs.map(run => ({
      label: this.shortLabel(run),
      color: this.runColor(run),
      values: run.entries.map(e => e.aliveCount),
    }));
  }

  shortLabel(run: AITrainingRun): string {
    const match = run.label.match(/Run\s*(\d+)/i);
    return match ? `Run ${match[1]}` : run.label;
  }

  // ---------- Derived readouts ----------
  bestLapOf(run: AITrainingRun): number | null {
    const laps = run.entries.map(e => e.bestLapTime).filter(v => v > 0);
    return laps.length ? Math.min(...laps) : null;
  }

  finishedCount(run: AITrainingRun): number {
    return run.entries.filter(e => e.bestLapTime > 0).length;
  }

  selectEntry(entry: AITrainingHistoryEntry) {
    this.aiDrivingService.selectHistoryEntry(entry);
  }

  /**
   * Extracts a generation checkpoint as a standalone, exportable model — the weights plus the
   * car/track context they were trained under. Available on every generation, not just the
   * run's final one, since the best result of a run often isn't its last generation.
   */
  saveAsModel(run: AITrainingRun, entry: AITrainingHistoryEntry, event: Event) {
    event.stopPropagation();
    if (!entry.weights.length) return;

    const suggested = `${this.shortLabel(run)} · Gen ${entry.generation}`;
    const name = window.prompt('Save this generation as a model:', suggested);
    if (!name || !name.trim()) return;

    this.modelLibrary.saveModel({
      name: name.trim(),
      weights: entry.weights,
      carSettings: run.carSettings,
      trainedTrackLabel: run.trackLabel,
      trainedTrackLength: run.trackLength,
      generation: entry.generation,
      bestLapTime: entry.bestLapTime,
      bestFitness: entry.bestFitness,
      bestProgress: entry.bestProgress,
    });
  }

  /** Newest generations first — the interesting end of a long run. */
  recentEntries(run: AITrainingRun): AITrainingHistoryEntry[] {
    return [...run.entries].reverse();
  }

  // ---------- Export ----------
  async exportRun(run: AITrainingRun, event: Event) {
    event.stopPropagation();
    const exportText = this.buildRunExportText(run);

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(exportText);
      } else {
        this.copyTextFallback(exportText);
      }
    } catch {
      this.copyTextFallback(exportText);
    }

    this.downloadRunJson(run, exportText);
  }

  private buildRunExportText(run: AITrainingRun): string {
    const entries = run.entries.map(entry => ({
      generation: entry.generation,
      bestFitness: entry.bestFitness,
      bestLapTime: entry.bestLapTime,
      bestProgress: entry.bestProgress,
      aliveCount: entry.aliveCount,
      averageFitness: entry.averageFitness,
    }));

    const firstEntry = entries[0] ?? null;
    const lastEntry = entries[entries.length - 1] ?? null;
    const bestFitnessEntry = entries.reduce((best, entry) => entry.bestFitness > (best?.bestFitness ?? -Infinity) ? entry : best, firstEntry);
    const finished = entries.filter(e => e.bestLapTime > 0);
    const bestLapTimeEntry = finished.length
      ? finished.reduce((best, entry) => entry.bestLapTime < best.bestLapTime ? entry : best)
      : null;

    const sampleCount = 5;
    const samples = entries.length <= sampleCount
      ? entries
      : Array.from({ length: sampleCount }, (_, index) => entries[Math.floor(index * (entries.length - 1) / (sampleCount - 1))]);

    const payload = {
      id: run.id,
      label: run.label,
      startedAt: new Date(run.startedAt).toISOString(),
      completedAt: run.completedAt ? new Date(run.completedAt).toISOString() : null,
      generationCount: run.generationCount,
      bestFitness: run.bestFitness,
      bestLapTime: run.bestLapTime,
      bestProgress: run.bestProgress,
      aliveCount: run.aliveCount,
      averageFitness: run.averageFitness,
      summary: {
        firstEntry,
        lastEntry,
        bestFitnessEntry,
        bestLapTimeEntry,
        sampledGenerations: samples,
      },
      notes: 'This export is a summary of the run. Full per-step trajectories and low-level details are omitted for concise LLM analysis.',
    };

    return JSON.stringify(payload, null, 2);
  }

  private copyTextFallback(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  private downloadRunJson(run: AITrainingRun, exportText: string) {
    const blob = new Blob([exportText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const fileNameLabel = run.label.replace(/\s+/g, '_').toLowerCase();
    link.download = `${fileNameLabel || 'run-export'}_${run.id}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
