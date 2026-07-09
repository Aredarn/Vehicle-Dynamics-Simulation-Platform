import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { AIDrivingService, AITrainingHistoryEntry, AITrainingRun } from '../../services/ai-driving.service';

@Component({
  selector: 'app-results-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './results-panel.component.html',
  styleUrl: './results-panel.component.scss'
})
export class ResultsPanelComponent implements OnInit, OnDestroy {
  runs: AITrainingRun[] = [];
  selectedGeneration: number | null = null;
  expandedRuns = new Set<string>();

  private runsSub!: Subscription;
  private selectedSub!: Subscription;

  constructor(private aiDrivingService: AIDrivingService) {}

  ngOnInit() {
    this.runsSub = this.aiDrivingService.runs$.subscribe(runs => {
      this.runs = runs;
    });

    this.selectedSub = this.aiDrivingService.selectedHistoryEntry$.subscribe(entry => {
      this.selectedGeneration = entry?.generation ?? null;
    });
  }

  ngOnDestroy() {
    this.runsSub?.unsubscribe();
    this.selectedSub?.unsubscribe();
  }

  toggleRun(run: AITrainingRun) {
    if (this.expandedRuns.has(run.id)) {
      this.expandedRuns.delete(run.id);
    } else {
      this.expandedRuns.add(run.id);
    }
  }

  isRunExpanded(run: AITrainingRun): boolean {
    return this.expandedRuns.has(run.id);
  }

  async exportRun(run: AITrainingRun) {
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
    alert('Run export copied to clipboard and downloaded as a JSON file. Paste it into your LLM prompt.');
  }

  private buildRunExportText(run: AITrainingRun): string {
    const entries = run.entries.map(entry => ({
      generation: entry.generation,
      bestFitness: entry.bestFitness,
      bestLapTime: entry.bestLapTime,
      aliveCount: entry.aliveCount,
      averageFitness: entry.averageFitness,
    }));

    const firstEntry = entries[0] ?? null;
    const lastEntry = entries[entries.length - 1] ?? null;
    const bestFitnessEntry = entries.reduce((best, entry) => entry.bestFitness > (best?.bestFitness ?? -Infinity) ? entry : best, firstEntry);
    const bestLapTimeEntry = entries.reduce((best, entry) => (best == null || entry.bestLapTime < best.bestLapTime) ? entry : best, firstEntry);

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

  selectEntry(entry: AITrainingHistoryEntry) {
    this.aiDrivingService.selectHistoryEntry(entry);
  }
}
