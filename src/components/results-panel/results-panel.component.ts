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

  selectEntry(entry: AITrainingHistoryEntry) {
    this.aiDrivingService.selectHistoryEntry(entry);
  }
}
