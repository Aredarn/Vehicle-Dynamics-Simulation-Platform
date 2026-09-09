---
version: 1
slug: "src-components-track-view-track-view-component-ts"
primary_target: "src/components/track-view/track-view.component.ts"
related_targets: ["src/components/track-view/track-view.component.html","src/components/track-view/track-view.component.scss","src/styles.scss","src/app/app.component.html","src/app/app.component.scss"]
---

## Scope

The whole VDSP workspace: track canvas, sidebar (Car / Track / Training / Drive), telemetry drawer, driver HUD. Visitor mode: **Operate**.

## Audience and job

One person at a desk, alone, running a local dev server, moving between four jobs that matter equally: building or tracing a track, tuning the car, watching a run train, and reading telemetry afterwards. Success is a trained AI that drives the track genuinely well.

## Constraints

All current functionality, controls and behaviour preserved. Fully client-side. Light and dark themes both survive. Canvas 2D rendering unchanged. Physics, scoring and model formats untouched — this is a visual redesign only.

## Craft bar

MoTeC i2 / race telemetry tools, and iRacing / Assetto Corsa garage screens. Their density, restraint and absence of decoration is the level to reach.

## Rejected

"Another SaaS dashboard" (user's words). The incumbent look — equal-weight rounded panels, small grey labels, soft shadows — is the anti-reference, not the baseline.

## Direction contract

THESIS: The canvas owns the screen and panels dock to its edges, collapsing to rails when idle. Refuses the fixed sidebar-plus-drawer that permanently boxes the track inside chrome.

OWN-WORLD: Instrument dark ground with a single amber accent that carries state and nothing else. Hairline rules and gaps for separation — no rounded cards, no shadows, no filled panels. Dense property rows: label left, tabular figure right. Condensed caps for labels, tabular numerals everywhere data appears.

STORY: An engineer sees the track first, reads run state peripherally from the accent, and reaches any control without hunting for it.

FIRST VIEWPORT: Track full-bleed, edge to edge. A narrow icon rail pins left (Car, Track, Training, Drive); the active panel docks beside it and collapses. A top strip carries car, objective, generation and the headline figure in tabular numerals, with the primary action at its left. Telemetry docks bottom, collapsed until wanted.

FORM: The professional tool — the category standard, chosen deliberately over seven grounded candidates and two challenger hands. Seed key b54b6c67, kind canon, code-led.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

Whether the telemetry dock should default open while a run is active.
