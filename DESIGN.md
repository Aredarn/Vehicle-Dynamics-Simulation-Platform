---
name: VDSP
description: A local race-engineering instrument — dark canvas ground, hairline chrome, one amber that means state.
colors:
  canvas-ground: "#0E1013"
  chrome: "#14171B"
  chrome-raised: "#1A1E23"
  chrome-line: "#232830"
  inset-well: "#0A0C0E"
  accent-amber: "#FF6B35"
  accent-amber-hover: "#FF8354"
  accent-amber-soft: "rgba(255, 107, 53, 0.15)"
  accent-contrast: "#0E1013"
  text-1: "#E6E9EC"
  text-2: "#98A1AB"
  text-3: "#838C97"
  border: "rgba(255, 255, 255, 0.07)"
  border-strong: "rgba(255, 255, 255, 0.15)"
  success: "#35C26F"
  warning: "#F5A524"
  danger: "#F2555A"
  paper-ground: "#E9E6E0"
  paper-chrome: "#F4F2ED"
  paper-chrome-raised: "#EAE7E1"
  paper-inset-well: "#DCD8D0"
  accent-rust: "#B23B0A"
  accent-rust-hover: "#9A3412"
  ink-1: "#16181B"
  ink-2: "#4E555D"
  ink-3: "#5F666E"
  border-ink: "rgba(22, 24, 27, 0.13)"
  border-ink-strong: "rgba(22, 24, 27, 0.26)"
  data-2: "#4CC9F0"
  data-3: "#B5E48C"
  data-4: "#F9C74F"
  data-5: "#C77DFF"
typography:
  display:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "-0.02em"
    fontFeature: "tnum 1"
  headline:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontFeature: "tnum 1"
  title:
    fontFamily: "Barlow Condensed, Barlow, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.12em"
  body:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  body-small:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Barlow Condensed, Barlow, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "0.12em"
  label-micro:
    fontFamily: "Barlow Condensed, Barlow, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "0.12em"
  figure:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "-0.02em"
    fontFeature: "tnum 1"
rounded:
  r-1: "0px"
  r-2: "2px"
  r-3: "2px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "24px"
  sp-6: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent-amber}"
    textColor: "{colors.accent-contrast}"
    typography: "{typography.label}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.accent-amber-hover}"
    textColor: "{colors.accent-contrast}"
  button-primary-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.text-3}"
    rounded: "{rounded.r-2}"
    height: "30px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-1}"
    typography: "{typography.label}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "30px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "30px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "30px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.r-2}"
    padding: "0"
    width: "30px"
    height: "30px"
  input-field:
    backgroundColor: "{colors.inset-well}"
    textColor: "{colors.text-1}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-2}"
    padding: "0 7px"
    height: "26px"
  input-field-focus:
    backgroundColor: "{colors.chrome-raised}"
    textColor: "{colors.text-1}"
  segmented-cell:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.title}"
    rounded: "{rounded.r-1}"
    padding: "0 8px"
    height: "26px"
  segmented-cell-active:
    backgroundColor: "{colors.accent-amber}"
    textColor: "{colors.accent-contrast}"
  rail-tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-3}"
    typography: "{typography.label-micro}"
    rounded: "{rounded.r-1}"
    height: "54px"
    width: "52px"
  rail-tab-active:
    backgroundColor: "{colors.chrome-raised}"
    textColor: "{colors.accent-amber}"
  property-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-1}"
    typography: "{typography.body-small}"
    rounded: "{rounded.r-1}"
    padding: "7px 8px 7px 0"
  data-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label-micro}"
    rounded: "{rounded.r-1}"
    padding: "0 12px"
    height: "26px"
---

# Design System: VDSP

## Overview

**Creative North Star: "The Instrument Panel"**

VDSP looks like a race-engineering tool that happens to run in a browser: a dark canvas that owns the whole screen, chrome that sits on top of it as thin panels, and a single amber that lights up only when the machine is doing something. The reference points are telemetry software and garage screens, not web dashboards. Density is high and decoration is absent — every pixel of chrome is either a label, a figure, a control, or a hairline separating two of those.

The system is built from three materials only: flat tonal surfaces, 1px hairlines, and gaps. There are no shadows anywhere in the shipped build, no rounded cards, no filled panels, and no decorative gradients (the one gradient in the stylesheet draws the select caret). Depth is expressed by tone alone: the canvas is the darkest ground (`#0E1013`), the chrome sits one step above it (`#14171B`), and anything hovered or active steps up once more (`#1A1E23`). The light theme runs the same structure on warm paper rather than office white, so it reads as a printed data sheet.

The explicitly rejected look is "another SaaS dashboard": equal-weight rounded panels, small grey labels floating in whitespace, soft drop shadows. Where the build still had that shape, it was squared, de-carded, or reduced to rows on a rule.

**Key Characteristics:**
- Full-bleed canvas ground; all chrome floats above it and folds away
- Zero shadows; hairlines and gaps do all separation
- Effectively square (0–2px radii); nothing is a pill or a card
- One amber accent reserved for run state and active selection
- Condensed uppercase legends, tabular monospace for every figure
- Compositor-only motion at 120ms; nothing animates width or height
- Both themes clear WCAG AA on every text pair (lowest measured 4.83:1)

## Colors

An instrument palette: near-black or warm-paper ground, three steps of neutral chrome, three text weights, and exactly one accent that carries meaning.

### Primary
- **Signal Amber** (dark theme): the only saturated colour in the chrome. It marks the active rail tab (a 2px left bar plus icon and label colour), the active segmented cell, the headline session figure, checked toggles, the progress fill, the slider needle, the seed banner's left edge, the caret, the text selection and the focus ring. It is *not* used on the wordmark, not on a disabled control, and not as a decorative tint.
- **Signal Rust** (light theme): the same role darkened to hold 5.3:1 on `paper-chrome` and 4.8:1 on `paper-chrome-raised`. The accent changes value across themes; its meaning never changes.

### Secondary
- **Status trio — Live Green, Caution Amber, Fault Red:** reserved for measured state, never for emphasis. Green marks a live pulsing run indicator and an ahead-of-best delta; caution amber marks a HUD in an abnormal mode; red marks destructive actions and behind-best deltas.

### Tertiary
- **Data series** (`data-2` … `data-5`, with the accent standing in as series 1): the chart and agent-overlay ramp. These exist only inside plotted data and the run swatches that key it. They never appear as UI chrome.

### Neutral
- **Canvas Ground** (`canvas-ground`; `paper-inset-well` in light): the track surface — the extreme plane, always full-bleed behind everything.
- **Chrome** (`chrome` / `paper-chrome`): every panel plane — rail, dock, session strip, telemetry drawer, viewport tool cluster, canvas hint.
- **Chrome Raised** (`chrome-raised`): hover and active fill for tabs, rows and quiet buttons. The only "highlight" material in the system.
- **Chrome Line** (`chrome-line`): the track under a bar — progress groove, slider rail, dial arc, scrollbar thumb.
- **Inset Well** (`inset-well`): the inside of a field. Inputs sink below the chrome rather than sitting on it.
- **Text 1 / 2 / 3:** values and titles / labels and secondary rows / legends, units, hints and disabled text. `text-3` is the floor and was tuned to clear 4.5:1 on both chrome planes in both themes.
- **Border / Border Strong:** the entire separation vocabulary. Weak hairlines divide content within a plane; strong hairlines divide plane from plane and outline controls.

### Named Rules
**The State-Only Accent Rule.** The accent means "this is running" or "this is the one selected". If a mark is neither, it is `text-1` or `text-2`. The wordmark, section headings and disabled controls are explicitly barred from it.

**The Three-Plane Rule.** Only three chrome tones may stack: chrome, chrome-raised on interaction, inset-well inside a field. A fourth tonal step to signify grouping is a card in disguise; use a hairline instead.

**The Measured-Colour Rule.** Green, caution amber and red report a condition measured by the simulation. They may never be borrowed for visual emphasis.

## Typography

**Display Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo, Consolas)
**Body Font:** Barlow (with system-ui, Segoe UI)
**Label Font:** Barlow Condensed (with Barlow, system-ui)

All three are self-hosted from `public/fonts` as latin-subset woff2 under the SIL Open Font License, `font-display: swap`, ten faces in total. The shipped bundle makes zero third-party requests at runtime.

**Character:** A legend-and-readout pairing. Condensed caps name things, monospace figures state them, and Barlow carries the small amount of running prose. The result reads as an instrument face: nothing is set large for drama, only for rank.

### Hierarchy
- **Display** (JetBrains Mono 700, 28px, -0.02em, tabular): the single largest figure in a panel — the summary readout of a run.
- **Headline** (JetBrains Mono 700, 20px, -0.02em, tabular): the lead figure in the session strip, right-aligned, in the accent. One per screen.
- **Title** (Barlow Condensed 600, 15px, 0.12em, uppercase): the docked panel title; the same face at 13px/0.11em titles sections and the telemetry toggle.
- **Body** (Barlow 400, 13px, 1.45): default text, strip values, canvas hint. 12px is the panel-row size; hints cap at 68ch and empty-state copy at 34ch.
- **Label** (Barlow Condensed 600, 11px, 0.12em, uppercase, `text-3`): control legends and stat labels.
- **Micro Label** (Barlow Condensed 600, 10px, 0.09–0.12em, uppercase): rail tab names, strip legends, table headers, HUD block titles. This is the floor.
- **Figure** (JetBrains Mono 500, 15px, tabular): every number in the interface — stat values, field contents, table cells, HUD readouts, keycaps.

### Named Rules
**The Tabular Figure Rule.** Every number renders in JetBrains Mono with `font-variant-numeric: tabular-nums`. A column of values must not jitter as a run updates, and numbers never render in Barlow.

**The Condensed Legend Rule.** Anything that names a control — button text, segmented cell, tab, section title, table header, stat label — is Barlow Condensed, uppercase, tracked 0.06–0.12em. Sentence case belongs to running prose only.

**The 10px Floor Rule.** No type ships below 10px, and 10px is only ever condensed caps at `text-3` or brighter. Nothing at 10px carries information a user must read to operate the app.

## Layout

The canvas is the ground plane and fills the viewport; every other region is absolutely positioned over it. Folding a region away hands its space straight back to the track rather than resizing a column — this is the structural thesis of the workspace and the reason nothing sits in a flex column.

Fixed chrome insets, mirrored as constants in `track-view.component.ts` so the canvas camera can centre on the visible cutout: **icon rail 52px** pinned left (46px compact), **dock 312px** beside it, **session strip 44px** across the top right of the rail and dock, **telemetry drawer 268px** open and **32px** collapsed (the 33px translate covers the bar plus its own top rule). The app shell above all of this is a bezel: `100dvh`, `overflow: hidden`, nothing else.

Spacing runs a 4px rhythm (4 / 8 / 12 / 16 / 24 / 32). Panel sections pad 16px and close with a hairline; rows inside them sit on 6–8px vertical padding. Controls come in three heights only: 30px (button), 26px (input, segmented cell, table row), 24px (small button). Stat grids auto-fit at an 84px minimum column.

**Compact (≤900px):** the rail narrows to 46px, the dock overlays the canvas to the right of the rail — never over it — starting below the strip and stopping above the telemetry bar; the drawer becomes 46vh; and the app *lands with the dock folded*, so the first thing a phone shows is the track. **At ≤620px** one further strip field group drops. The session strip itself never collapses: on a phone it is the only place run state is legible.

### Named Rules
**The Fold-Gives-Back Rule.** Chrome overlays the canvas; collapsing any region returns its pixels to the track. Never convert a panel into a layout column that squeezes the canvas.

**The Shed-Don't-Crush Rule.** When width runs out the strip removes whole fields (`--wide` at ≤900px: Car, Track, Alive; `--mid` at ≤620px: Objective, Gen) rather than shrinking type or truncating values. Anything shed is still readable in the panel it belongs to.

**The Camera-Knows-The-Chrome Rule.** Any change to rail, dock, strip or drawer size must change the matching constant in `track-view.component.ts`; the canvas camera frames the visible cutout, not the viewport.

**The Clear-The-Chrome Rule.** Everything floating in the stage layer is inset from the chrome it can collide with, not from the viewport: the zoom cluster, the corner hint and the driver HUD all clear the docked panel on the left and the collapsed telemetry bar (32px, or 46vh open) at the bottom, and they move when those regions move. Where two overlays would still land on each other, one yields by role rather than by z-index — while driving, the bottom belongs to the HUD and the zoom cluster steps up under the strip (`.workspace.is-driving`).

## Elevation & Depth

There are no shadows in this system. `box-shadow` appears nowhere in the shipped stylesheets, and there is no elevation ramp to reach for. Depth is expressed three ways only: **tone** (canvas below chrome below raised), **hairline** (`border` within a plane, `border-strong` between planes and around controls), and **gap**. A floating element proves it is floating by carrying a `border-strong` outline — the viewport tool cluster and the canvas hint both do exactly that.

The one material effect in the build is the driver HUD, which sits over a moving canvas: `color-mix(in srgb, var(--surface-1) 88%, transparent)` with `backdrop-filter: blur(10px)`. That is a transparency treatment for an overlay on live motion, not an elevation token, and it does not generalise to panels.

### Named Rules
**The No-Shadow Rule.** Separation is a hairline or a gap. If a surface must read as separate, give it `border-strong`; if it must read as grouped, give it hairlines between rows. Never a shadow, never a glow.

**The Rule-Over-Box Rule.** A list is rows divided by hairlines with the last rule removed — not a stack of filled tiles. Emphasis on a row is a 2px accent bar on its left edge (hover on track pieces and presets, active on rail tabs and table rows), not a border drawn around it.

## Shapes

The world is square. `r-1` is a literal `0px` and `r-2` / `r-3` are `2px` — the most any control gets, just enough to keep a 1px border from looking chipped. Nothing in the app is a pill, a rounded card or a capsule badge. Buttons, fields, segmented groups, checkboxes, keycaps, tables and the progress groove are all square or 2px-square. The range slider thumb is a deliberate 4x15px rectangle at `border-radius: 0` — a needle, not a knob.

Two circles exist and both are instruments rather than containers: the 6px status dot that pulses while a run is live, and the 124px HUD speedometer dial. Both earn their curve by depicting a physical readout.

Borders are always exactly 1px (dial and chart strokes excepted — those are data). Corners are never clipped, notched or asymmetric.

### Named Rules
**The Square Rule.** New surfaces take `0px`; controls may take `2px`. Any radius above 2px must be defending an actual dial, a status LED, or a plotted mark.

## Components

### Buttons
- **Shape:** square with a 2px softening (`r-2`), fixed 30px height (24px for the small variant), 12px horizontal padding, condensed uppercase label tracked 0.06em, 6px icon-to-label gap.
- **Primary:** filled accent with `accent-contrast` text and a 1px accent border, so it aligns optically with the outlined variants beside it.
- **Hover / Focus:** background and border swap to `accent-hover` over 120ms. Focus-visible draws a square 2px accent outline offset 1px — the same ring on every focusable element in the app.
- **Disabled:** the filled variant is re-skinned rather than faded — transparent fill, `border-strong` outline, `text-3` label (measured 5.28:1). Only the filled variant; ghost, quiet, icon and danger keep a 0.45 opacity fade because they have no fill to drain.
- **Ghost:** transparent inside a `border-strong` outline with `text-1` text; hover fills `chrome-raised` and lifts the border to `text-3`.
- **Quiet:** no border, `text-2`; hover fills `chrome-raised` and lifts to `text-1`.
- **Icon:** the quiet treatment at 30x30 with an inline SVG stroked in `currentColor`.
- **Danger:** transparent with `danger` text; hover *fills* with `danger` and turns the label white — the only inversion in the system, and it guards a destructive action.

### Inputs / Fields
- **Style:** 26px tall, sunk into `inset-well`, `border-strong` hairline, 2px radius, contents in tabular JetBrains Mono at 12px (selects switch to Barlow).
- **Focus:** the border becomes accent and the fill lifts to `chrome-raised`, so a focused field reads as opened rather than glowing.
- **Select:** the native chevron is replaced by two 5px `currentColor` triangles drawn with linear-gradients, with 24px right padding.
- **Range:** a 2px `chrome-line` track carrying a 4x15px accent needle. No fill, no tooltip bubble.
- **Checkbox:** a 15x15 square well with a `border-strong` hairline; checked fills accent and reveals a `currentColor` check.

### Segmented Control
- **Style:** one `border-strong` box with 1px internal dividers, cells 26px tall, condensed uppercase, `overflow: hidden` so the group reads as a single control.
- **State:** the active cell fills accent with `accent-contrast` text; an inactive cell fills `chrome-raised` on hover. This is the app's primary mode switch — build mode, objective, telemetry view.

### Navigation (icon rail and dock)
- **Rail:** a 52px column on `chrome` with a `border` right edge. A two-letter text mark ("VD", full name in the `title` attribute) occupies the 44px strip-height cell at the top, in `text-2` and never accent. Tabs are 54px tall — icon over a 10px condensed caps name, `text-3` at rest, hairline-divided.
- **Active tab:** `chrome-raised` fill, accent icon and label, and a 2px accent bar flush to the left edge. Never a filled tile.
- **Dock:** a 312px panel on `chrome` with a `border-strong` right edge, a 44px head carrying a condensed uppercase title, and a scrolling body with `overscroll-behavior: contain`. Folded, it leaves an 18x44px reopen tab against the rail. Below 900px the head is hidden and the dock overlays the canvas.

### Session Strip
The 44px band across the top of the canvas: the primary action at the left, then 20px-tall 1px rules separating label-over-value fields (10px condensed legend above a 13px value), with the figure the session is judged on pushed right at 20px/700 in the accent. While a run is active the strip carries `data-state="running"` and the stop button takes an accent border and accent text — the one place the accent reports a live process.

### Property Row (signature)
The unit the panels are built from: label left in 12px `text-2`, value or control right, a 1px hairline beneath, the last rule removed. Interactive variants — track pieces, presets, generation rows — add a `chrome-raised` hover fill and a 2px accent bar on the left edge. This pattern replaced tiled cards during the build and is why the largest block in the first viewport reads as a parts list rather than a grid of buttons.

### Telemetry Drawer (signature)
Bottom-docked, 268px open, always leaving a 32px bar with a condensed uppercase toggle and a view switch. Collapsing applies `transform: translateY(calc(100% - 33px))`: the drawer slides off the bottom edge and the workspace clips the overhang. Height is never animated. On compact it becomes 46vh, full-bleed, and the docked panel stops above its bar.

### Data Table
A `border`-outlined block with a 26px `chrome-raised` head in 10px condensed caps at `text-3`, then 26px rows on a 5-column grid, first column `text-3`, all other columns right-aligned. Rows hover to `chrome-raised` + `text-1` and carry a 2px transparent left border that the accent fills when selected — the same left-bar grammar as the rail and the property rows.

### Driver HUD (signature)
An overlay instrument that sits over the canvas rather than in the drawer: a hairline box of 88% chrome with a 10px backdrop blur, blocks divided by 1px left rules, and a 124px SVG speedometer with a `chrome-line` arc, an accent fill arc, a `danger` needle and monospace tick labels. Its border turns caution amber when the HUD is in an abnormal mode.

### Motion
One duration and one curve: `120ms cubic-bezier(0.4, 0, 0.2, 1)`, applied to colour, border-colour and transform. Only two things move geometrically — the progress bar (`transform: scaleX`) and the telemetry drawer (`transform: translateY`) — and one thing loops: the 1.6s opacity pulse on the live status dot. `prefers-reduced-motion` collapses everything to 0.01ms, and a one-frame `.theme-switching` class kills transitions across a theme swap so custom properties re-resolve.

**The Compositor-Only Rule.** Animate `transform` and `opacity`. Never `width`, `height`, `top` or `left` on anything visible while a training run repaints.

## Do's and Don'ts

### Do:
- **Do** set every number in JetBrains Mono with `tabular-nums`, including field contents and table cells.
- **Do** label controls in Barlow Condensed uppercase, tracked 0.06–0.12em, at 10px or larger.
- **Do** separate with a 1px `border` inside a plane and `border-strong` between planes, removing the rule on the last row.
- **Do** mark selection and run state with the accent — a 2px left bar, an accent fill on an active segmented cell, or accent text on the lead figure.
- **Do** keep new chrome at `0px` radius, or `2px` if it is a control.
- **Do** position new chrome absolutely over the canvas and give it a collapsed state that returns space to the track.
- **Do** update the matching inset constant in `track-view.component.ts` whenever a chrome dimension changes.
- **Do** verify both themes: every text/background pair must clear 4.5:1, and `text-3` on `chrome-raised` is the tightest pair in the system.
- **Do** self-host any new face in `public/fonts`; runtime third-party requests are zero and must stay zero.
- **Do** animate with `transform` and `opacity` at 120ms, and nothing else.

### Don't:
- **Don't** add a shadow, glow or elevation ramp. There are none in the build, and the hairline vocabulary covers every case.
- **Don't** wrap content in a filled, rounded card. Rows on a rule are the list form here.
- **Don't** use a radius above 2px unless the shape is a literal dial or status LED.
- **Don't** spend the accent on identity, decoration, section headings or a disabled control. It reports state and selection only.
- **Don't** borrow `success` / `warning` / `danger` for emphasis; they report measured conditions.
- **Don't** set a number in Barlow, or a control label in sentence case.
- **Don't** ship type below 10px.
- **Don't** signal disabled on a filled control by fading it — outline it in `border-strong` with `text-3` text.
- **Don't** shrink the session strip's type to fit; drop whole fields at the 900px and 620px breakpoints instead.
- **Don't** animate `width` or `height` on chrome that is visible while a run is training.
