import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { Subscription } from 'rxjs';
import { ModelLibraryService, SavedCarModel } from '../../services/model-library.service';
import { IconComponent } from '../icon/icon.component';

export interface ModelComparisonResult {
  lapTime: number;
  progress: number;
  completed: boolean;
}

// Literal hex, not the `var(--data-N)` tokens results-panel uses for its (DOM/SVG) charts —
// these colours also have to work as a canvas strokeStyle, and Canvas2D does not resolve CSS
// custom properties, so a var() string there is silently ignored.
const SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444'];

@Component({
  selector: 'app-model-compare',
  standalone: true,
  imports: [CommonModule, IconComponent],
  templateUrl: './model-compare.component.html',
  styleUrl: './model-compare.component.scss',
})
export class ModelCompareComponent implements OnInit, OnDestroy {
  /** Whether a track is currently loaded — a comparison run needs somewhere to drive. */
  @Input() trackReady = false;
  @Input() running = false;
  /** Keyed by model id: the outcome of the most recent "run on current track", if any. */
  @Input() results: Record<string, ModelComparisonResult> = {};

  @Output() runSelected = new EventEmitter<Array<{ model: SavedCarModel; color: string }>>();
  @Output() useAsSeed = new EventEmitter<SavedCarModel>();

  models: SavedCarModel[] = [];
  selectedIds = new Set<string>();
  importError: string | null = null;

  private sub!: Subscription;

  constructor(private library: ModelLibraryService) {}

  ngOnInit() {
    this.sub = this.library.models$.subscribe(models => {
      this.models = [...models].sort((a, b) => b.createdAt - a.createdAt);
      const liveIds = new Set(this.models.map(m => m.id));
      for (const id of [...this.selectedIds]) {
        if (!liveIds.has(id)) this.selectedIds.delete(id);
      }
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  toggleSelect(model: SavedCarModel) {
    if (this.selectedIds.has(model.id)) this.selectedIds.delete(model.id);
    else this.selectedIds.add(model.id);
  }

  isSelected(model: SavedCarModel): boolean {
    return this.selectedIds.has(model.id);
  }

  colorFor(model: SavedCarModel): string {
    const index = this.models.findIndex(m => m.id === model.id);
    return SERIES_COLORS[Math.max(0, index) % SERIES_COLORS.length];
  }

  get selectedModels(): SavedCarModel[] {
    return this.models.filter(m => this.selectedIds.has(m.id));
  }

  runComparison() {
    if (!this.trackReady || this.running || !this.selectedModels.length) return;
    this.runSelected.emit(this.selectedModels.map(model => ({ model, color: this.colorFor(model) })));
  }

  requestSeed(model: SavedCarModel, event: Event) {
    event.stopPropagation();
    this.useAsSeed.emit(model);
  }

  rename(model: SavedCarModel, event: Event) {
    event.stopPropagation();
    const name = window.prompt('Rename model:', model.name);
    if (!name || !name.trim() || name.trim() === model.name) return;
    this.library.renameModel(model.id, name.trim());
  }

  remove(model: SavedCarModel, event: Event) {
    event.stopPropagation();
    if (!window.confirm(`Delete "${model.name}"? This can't be undone.`)) return;
    this.library.deleteModel(model.id);
  }

  export(model: SavedCarModel, event: Event) {
    event.stopPropagation();
    this.library.exportModel(model);
  }

  async onImportFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || !files.length) return;

    this.importError = null;
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await this.library.importModel(file);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `Could not import "${file.name}".`);
      }
    }
    if (errors.length) this.importError = errors.join(' ');
    input.value = '';
  }

  resultFor(model: SavedCarModel): ModelComparisonResult | null {
    return this.results[model.id] ?? null;
  }
}
