# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the author, using VDSP to learn vehicle dynamics and to build engineering evidence — but published so a stranger can clone it and use it without help. Depth and approachability both matter; neither is allowed to win outright.

Secondary: anyone arriving from the public repository — sim-racing tinkerers, people curious about neuroevolution, people who want to draw a circuit and watch something learn it. There is no account, no onboarding, and no support channel, so the interface is the entire explanation.

## Product Purpose

Simulate a racecar with real vehicle dynamics, let a genetic algorithm evolve a small neural network to drive a user-made track, and let the user drive the same car themselves under identical rules.

A session has succeeded when **a training run converges into an AI that drives the track genuinely well**. The trained model's behaviour on the track is the measure of success — not the interface, and not the score by itself.

## Positioning

Runs entirely in a browser from a plain clone. The track is the user's own: assembled from pieces, sketched freehand, or traced from an image of a real circuit. A driver is then evolved on it.

The mechanism a neighbouring project could not truthfully copy: **the human driver and the AI run the same physics step, the same car settings, the same track limits and the same fixed timestep**, so a player's lap and an agent's lap are directly comparable rather than merely similar. Two separately scored objectives exist — Grip (fastest lap) and Drift (angle held at speed) — and a car's setup, down to drivetrain layout, differential and steering lock, genuinely decides what it can do.

## Operating Context

- Single-page workspace, no routes: sidebar (Car / Track / Training / Drive), canvas stage, telemetry drawer.
- Run locally: `npm start` (`ng serve`), then `http://localhost:4200`.
- Trained models persist in `localStorage` under `vdsp.models`; theme preference under `vdsp.theme`.
- Training runs and models are exported as JSON files the user keeps on disk.
- Training is main-thread and CPU-bound. Large populations are genuinely slow — roughly 2.4 s per generation at 200 cars — which shapes how long a user is willing to wait and what they can watch.

## Capabilities and Constraints

**Binding constraints (confirmed):**

- Fully client-side. No backend, no accounts, no server-held state.
- Models stay portable JSON — exportable, keepable, shareable, re-importable. A trained model is never locked inside the app.
- Physics stays real, never gamified. Every car attribute must genuinely drive behaviour, and the AI and the human must be governed by identical physics and track limits.
- Runs from a plain clone plus `ng serve`. No build service, hosting, API key, or paid dependency.

**Capabilities:** three track-authoring modes (pieces, freehand draw, image trace); car setup across mass, engine power, drag coefficient, frontal area, tyre grip, downforce (rated at 200 km/h), final drive, wheelbase, drivetrain (FWD/RWD/AWD), differential (open/LSD) and steering lock; genetic-algorithm training under a Grip or Drift objective; a model library with export/import and head-to-head comparison on any track; a human drive mode with an instrument HUD; light/dark theming.

**Technical constraints:** Angular 18 standalone components, no router, Canvas 2D rendering, simulation fixed at 1/30 s. Karma/Jasmine tests.

**Explicitly undecided:** no LICENSE file exists; no deployment target has been chosen; training has not been moved off the main thread.

## Brand Commitments

- Name: **VDSP** — Vehicle Dynamics Simulation Platform. Page title: "VDSP — Vehicle Dynamics Simulation".
- Repository: `github.com/Aredarn/Vehicle-Dynamics-Simulation-Platform`.
- No logo or wordmark asset exists; the only shipped image is `public/favicon.ico`.

## Evidence on Hand

- `README.md` documents the physics and the training method with the project's real formulas.
- One product screenshot, embedded in the README from GitHub user-attachments.
- Exported training runs as JSON summaries, produced by the app itself.

No testimonials, customers, benchmarks, pricing, licensing, uptime or usage numbers exist. Future work must not invent them.

## Product Principles

1. **The human and the machine obey the same rules.** Any change to physics or track limits applies to both, or the comparison that justifies the product is void.
2. **Every attribute must matter.** A setting that does not measurably change how the car behaves does not belong in the panel.
3. **The trained model is the deliverable.** It must remain inspectable, portable, and separable from the app that produced it.
4. **Client-side or not at all.** Anything requiring a server, an account, or a key is out of scope, however convenient.
5. **Instrumentation must be honest.** Readouts show measured quantities from the simulation, never numbers invented to fill a gauge.
