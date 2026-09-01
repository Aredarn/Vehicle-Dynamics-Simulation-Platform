import { Injectable } from '@angular/core';
import { TrainingObjective } from '../utils/drift-scoring';
import { BehaviorSubject, Observable } from 'rxjs';
import { CarSettings } from './car-settings.service';
import { AI_INPUT_COUNT, AI_HIDDEN_SIZE } from '../models/CarAgent';
import { weightCount } from '../utils/neural-policy';

/**
 * A saved model is the evolved weight vector plus the context it was trained under — car
 * settings and a description of the track. That's everything needed to either replay it
 * elsewhere (the comparer) or seed a new training run with it as a starting point (continuing
 * training on a different track), independent of the run history that produced it.
 */
export interface SavedCarModel {
  id: string;
  name: string;
  weights: number[];
  carSettings: CarSettings;
  trainedTrackLabel: string;
  trainedTrackLength: number;
  generation: number;
  bestLapTime: number;
  bestFitness: number;
  bestProgress: number;
  createdAt: number;
  /** What this model was trained for. Older saved models predate the choice and are grip. */
  objective: TrainingObjective;
  /** Best drift score reached, for models trained on the drift objective. */
  bestDriftScore: number;
}

const STORAGE_KEY = 'vdsp.models';
const EXPECTED_WEIGHT_COUNT = weightCount(AI_INPUT_COUNT, AI_HIDDEN_SIZE);

/**
 * Genome size before body slip angle became a network input.
 *
 * Models saved then are still perfectly good drivers, so rather than rejecting them they are
 * widened: each hidden neuron gains one weight for the new input, set to zero. A zero weight
 * means "ignore this input", so a migrated model behaves exactly as it did when it was saved.
 */
const LEGACY_INPUT_COUNT = 14;
const LEGACY_WEIGHT_COUNT = weightCount(LEGACY_INPUT_COUNT, AI_HIDDEN_SIZE);

export function migrateLegacyWeights(weights: number[]): number[] {
  if (weights.length !== LEGACY_WEIGHT_COUNT) return weights;

  const migrated: number[] = [];
  const oldStride = LEGACY_INPUT_COUNT + 1; // neuron bias + one weight per input
  for (let h = 0; h < AI_HIDDEN_SIZE; h++) {
    const start = h * oldStride;
    // The new input sits at index 13, ahead of the constant bias input which moves from 13 to
    // 14. So the zero is inserted before the constant's weight, not appended after it —
    // appending would hand the old bias weight to the slip input and leave the bias at zero.
    const upToNewInput = weights.slice(start, start + oldStride - 1);
    const constantInputWeight = weights[start + oldStride - 1];
    migrated.push(...upToNewInput, 0, constantInputWeight);
  }
  // The output layer reads the hidden layer, whose size has not changed.
  migrated.push(...weights.slice(AI_HIDDEN_SIZE * oldStride));
  return migrated;
}

@Injectable({ providedIn: 'root' })
export class ModelLibraryService {
  private modelsSubject = new BehaviorSubject<SavedCarModel[]>(this.readStored());
  models$: Observable<SavedCarModel[]> = this.modelsSubject.asObservable();

  get models(): SavedCarModel[] {
    return this.modelsSubject.value;
  }

  saveModel(model: Omit<SavedCarModel, 'id' | 'createdAt'>): SavedCarModel {
    const saved: SavedCarModel = {
      ...model,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.persist([...this.modelsSubject.value, saved]);
    return saved;
  }

  renameModel(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.persist(this.modelsSubject.value.map(m => (m.id === id ? { ...m, name: trimmed } : m)));
  }

  deleteModel(id: string) {
    this.persist(this.modelsSubject.value.filter(m => m.id !== id));
  }

  exportModel(model: SavedCarModel) {
    const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const fileLabel = model.name.replace(/\s+/g, '_').toLowerCase() || 'model';
    link.download = `${fileLabel}.vdspmodel.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /** Throws with a message suitable for direct display if the file isn't a compatible model. */
  async importModel(file: File): Promise<SavedCarModel> {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`"${file.name}" is not valid JSON.`);
    }
    return this.importFromParsed(parsed, file.name);
  }

  private importFromParsed(parsed: unknown, sourceName: string): SavedCarModel {
    const obj = parsed as Record<string, unknown>;
    const weights = obj?.['weights'];

    const widened = Array.isArray(weights) && weights.length === LEGACY_WEIGHT_COUNT
      ? migrateLegacyWeights(weights as number[])
      : weights;

    if (!Array.isArray(widened) || widened.length !== EXPECTED_WEIGHT_COUNT || !widened.every(w => typeof w === 'number' && Number.isFinite(w))) {
      throw new Error(
        `"${sourceName}" doesn't look like a compatible model — expected ${EXPECTED_WEIGHT_COUNT} weights, ` +
        `got ${Array.isArray(weights) ? weights.length : 'none'}. It may be from an incompatible version of VDSP.`
      );
    }

    const carSettings = obj?.['carSettings'] as Partial<CarSettings> | undefined;
    if (!carSettings || typeof carSettings.mass !== 'number' || typeof carSettings.wheelbase !== 'number') {
      throw new Error(`"${sourceName}" is missing the car settings it was trained with.`);
    }

    const saved: SavedCarModel = {
      id: crypto.randomUUID(),
      name: typeof obj['name'] === 'string' && (obj['name'] as string).trim() ? (obj['name'] as string).trim() : 'Imported model',
      weights: (widened as number[]).map(w => Number(w)),
      carSettings: { ...(carSettings as CarSettings) },
      trainedTrackLabel: typeof obj['trainedTrackLabel'] === 'string' ? obj['trainedTrackLabel'] as string : 'Unknown track',
      trainedTrackLength: Number(obj['trainedTrackLength']) || 0,
      generation: Number(obj['generation']) || 0,
      bestLapTime: Number(obj['bestLapTime']) || 0,
      bestFitness: Number(obj['bestFitness']) || 0,
      bestProgress: Number(obj['bestProgress']) || 0,
      objective: obj['objective'] === 'drift' ? 'drift' : 'grip',
      bestDriftScore: Number(obj['bestDriftScore']) || 0,
      createdAt: Date.now(),
    };

    this.persist([...this.modelsSubject.value, saved]);
    return saved;
  }

  private persist(models: SavedCarModel[]) {
    this.modelsSubject.next(models);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
    } catch {
      // Storage full or disabled (e.g. private browsing) — the library still works this session.
    }
  }

  private readStored(): SavedCarModel[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Models stored before body slip became an input are widened on the way in, so a library
      // built up over previous sessions keeps working rather than silently failing to load.
      return parsed.map((model: SavedCarModel) => ({
        ...model,
        weights: Array.isArray(model?.weights) ? migrateLegacyWeights(model.weights) : model?.weights,
        objective: model?.objective === 'drift' ? 'drift' : 'grip',
        bestDriftScore: Number(model?.bestDriftScore) || 0,
      }));
    } catch {
      return [];
    }
  }
}
