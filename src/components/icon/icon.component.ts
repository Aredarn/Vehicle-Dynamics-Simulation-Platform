import { Component, Input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Inline SVG icons, stroked with `currentColor` so they inherit text colour and
 * theme automatically. Kept as a local set rather than an icon package to avoid
 * pulling in a dependency for ~20 glyphs.
 */
const ICONS: Record<string, string> = {
  // Navigation / sections
  car: '<path d="M3 11.5 4.6 7a2 2 0 0 1 1.9-1.3h7a2 2 0 0 1 1.9 1.3L17 11.5"/><path d="M2.5 11.5h15v4h-2.2M4.7 15.5H2.5v-4"/><path d="M7 15.5h6"/><circle cx="5.6" cy="15.6" r="1.4"/><circle cx="14.4" cy="15.6" r="1.4"/>',
  track: '<path d="M6.5 4.5h7a4 4 0 0 1 0 8h-7a3 3 0 0 0 0 6h8"/>',
  cpu: '<rect x="6.5" y="6.5" width="7" height="7" rx="1"/><rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M7.5 1.5v2M12.5 1.5v2M7.5 16.5v2M12.5 16.5v2M1.5 7.5h2M1.5 12.5h2M16.5 7.5h2M16.5 12.5h2"/>',
  chart: '<path d="M3 17V3"/><path d="M3 17h14"/><path d="M6 13.5 9.5 9l3 2.5L17 6"/>',

  // Actions
  play: '<path d="M6 4.5v11l9-5.5-9-5.5Z"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1"/>',
  undo: '<path d="M4 9h8.5a4 4 0 0 1 0 8H8"/><path d="M7 6 4 9l3 3"/>',
  download: '<path d="M10 3v9"/><path d="m6.5 8.5 3.5 3.5 3.5-3.5"/><path d="M4 15.5h12"/>',
  plus: '<path d="M10 5v10M5 10h10"/>',
  minus: '<path d="M5 10h10"/>',
  fit: '<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7"/><path d="M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7"/><path d="M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13"/><path d="M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13"/>',
  reset: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.5 3v3.5H13"/>',
  trash: '<path d="M4 6h12"/><path d="M8 6V4.5h4V6"/><path d="M5.5 6l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10"/>',
  compare: '<path d="M10 3v14"/><path d="M6 6.5 3 10l3 3.5"/><path d="m14 6.5 3 3.5-3 3.5"/>',

  // Theme
  sun: '<circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
  moon: '<path d="M16 11.3A6.5 6.5 0 0 1 8.7 4a6.5 6.5 0 1 0 7.3 7.3Z"/>',
  monitor: '<rect x="2.5" y="4" width="15" height="10" rx="1.5"/><path d="M7 17h6M10 14v3"/>',

  // Disclosure
  chevronDown: '<path d="m5.5 8 4.5 4.5L14.5 8"/>',
  chevronRight: '<path d="m8 5.5 4.5 4.5L8 14.5"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',

  // Track pieces — schematic glyphs rather than emoji
  pieceStart: '<path d="M5 3.5v13"/><rect x="7" y="4" width="9" height="6" rx="0.5"/><path d="M7 7h4.5V4M11.5 7H16v3H7"/>',
  pieceStraight: '<path d="M3 10h14"/><path d="M3 6.5v7M17 6.5v7"/>',
  pieceCurveL: '<path d="M4 16.5V11a6 6 0 0 1 6-6h6"/><path d="M13.5 2.5 16.5 5l-3 2.5"/>',
  pieceCurveR: '<path d="M16 16.5V11a6 6 0 0 0-6-6H4"/><path d="M6.5 2.5 3.5 5l3 2.5"/>',
  pieceChicane: '<path d="M3 15c3 0 3-4.5 6-4.5S12 5 15 5"/><path d="M13.5 2.5 16.5 5l-3 2.5"/>',

  // Models library
  upload: '<path d="M10 12.5V3"/><path d="m6.5 6.5 3.5-3.5 3.5 3.5"/><path d="M4 15.5h12"/>',
  edit: '<path d="M12.5 3.5 16.5 7.5 7 17H3v-4l9.5-9.5Z"/><path d="M11 5l4 4"/>',
  bookmark: '<path d="M5.5 3.5h9a1 1 0 0 1 1 1V17l-5.5-3-5.5 3V4.5a1 1 0 0 1 1-1Z"/>',
  layers: '<path d="m10 3 7 4-7 4-7-4 7-4Z"/><path d="m3 11 7 4 7-4"/><path d="m3 14.5 7 4 7-4"/>',
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `
    <svg
      class="icon"
      [attr.width]="size"
      [attr.height]="size"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      [innerHTML]="markup"
    ></svg>
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .icon { display: block; }
  `],
})
export class IconComponent {
  @Input({ required: true }) set name(value: string) {
    // Angular's HTML sanitizer strips SVG child elements from [innerHTML]. The
    // markup here comes only from the constant map above — never from user or
    // network input — so trusting it is safe.
    this.markup = this.sanitizer.bypassSecurityTrustHtml(ICONS[value] ?? '');
  }

  @Input() size = 16;
  @Input() strokeWidth = 1.5;

  markup: SafeHtml = '';

  constructor(private sanitizer: DomSanitizer) {}
}
