import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'vdsp.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private preferenceSubject = new BehaviorSubject<ThemePreference>(this.readStoredPreference());
  private resolvedSubject = new BehaviorSubject<ResolvedTheme>('dark');

  /** What the user picked, including 'system'. */
  preference$: Observable<ThemePreference> = this.preferenceSubject.asObservable();
  /** The theme actually applied — 'system' already resolved. Canvas painting listens to this. */
  resolved$: Observable<ResolvedTheme> = this.resolvedSubject.asObservable();

  private media = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

  constructor() {
    this.media?.addEventListener('change', () => {
      if (this.preferenceSubject.value === 'system') this.apply();
    });
    this.apply();
  }

  get preference(): ThemePreference {
    return this.preferenceSubject.value;
  }

  get resolved(): ResolvedTheme {
    return this.resolvedSubject.value;
  }

  setPreference(preference: ThemePreference) {
    this.preferenceSubject.next(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Private browsing or storage disabled — the choice just won't persist.
    }
    this.apply();
  }

  private apply() {
    const resolved = this.resolve(this.preferenceSubject.value);
    const root = document.documentElement;

    // See the `.theme-switching` rule in styles.scss: transitioned properties do not
    // re-resolve from a changed custom property, so the swap has to happen with
    // transitions off or themed elements keep their old colours.
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', resolved);
    void root.offsetHeight; // force the recalculation while transitions are suppressed

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => root.classList.remove('theme-switching'));
    } else {
      root.classList.remove('theme-switching');
    }

    if (resolved !== this.resolvedSubject.value) {
      this.resolvedSubject.next(resolved);
    }
  }

  private resolve(preference: ThemePreference): ResolvedTheme {
    if (preference === 'system') {
      return this.media?.matches ? 'light' : 'dark';
    }
    return preference;
  }

  private readStoredPreference(): ThemePreference {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      // ignore
    }
    return 'system';
  }
}
