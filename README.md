# VDSP

Simulation of a racecar in Angular/TS.

## Motivation

This project is for myself to learn a bit more physics and get more experience. The purpose of
this web-app is to simulate a specified car around a user-created track — and to have an AI
learn to drive that track as fast as it can, using trail braking and a proper racing line.

**Car attributes:**

| Attribute | Unit | What it affects |
|---|---|---|
| Weight | kg | Inertia, tyre load, weight transfer |
| Engine power output | kW | Available drive force (power-limited at speed) |
| Drag coefficient | – | Aerodynamic drag |
| Frontal area | m² | Aerodynamic drag |
| Tire grip | μ | The whole friction budget — braking, traction and cornering |
| Downforce | N | Extra tyre load, so more grip without more mass |
| Final drive ratio | – | Scales drive force at the wheels |
| Wheelbase | m | Weight transfer geometry, and the drawn size of the car |

<img width="1919" height="1028" alt="VDSP screenshot" src="https://github.com/user-attachments/assets/f71a047a-a172-433f-b11a-5ba0bc3d0ecd" />

## Features

- **Three ways to build a track**
  - **Pieces** — drag straights and corners onto the canvas for quick blocking-out.
  - **Draw** — sketch the centreline freehand; the stroke becomes editable control points you can
    drag, insert or delete. Any shape, any corner angle.
  - **Image** — import a circuit map (Nordschleife, an F1 layout, a hand sketch) and trace it
    automatically, then fix up any point by hand.
- **Adjustable track width**, because real circuits vary a lot.
- **AI training** — a genetic algorithm evolves a small neural network to drive the lap.
- **Model library** — save any generation as a reusable model, export/import it as a file,
  continue training it on a *different* track, and compare models head-to-head on one layout.
- **Telemetry** — fitness, lap time and survival charted over generations, with run comparison.
- **Light / dark theme**, following your system setting by default.

<img width="1919" height="1033" alt="Képernyőkép 2026-07-29 130328" src="https://github.com/user-attachments/assets/f76fb3fd-eb33-4c3e-a461-10dfc9bcb31b" />

1. Download the code using Git
```console
git clone https://github.com/Aredarn/Vehicle-Dynamics-Simulation-Platform.git
```
2. Install Node.JS
```console
winget install nodejs
```
3. Install Angular CLI:
```console
npm install -g @angular/cli
```
4. Navigate to code in terminal
```console
cd C:\YOUR_FILE_LOCATION\Vehicle-Dynamics-Simulation-Platform
```
5. Start the server:
```console
ng serve
```
6. Open the webapp in a browser
```console
http://localhost:4200
```
## Formulas — How the Training Works

The AI isn't told how to drive. It's given a car, a track, and a score — then a
genetic algorithm breeds better drivers over many generations.

Each generation runs the same loop:

```
population of neural networks
        ↓  each one drives the track in a physics simulation
trajectories + lap times
        ↓  each run is scored by the fitness function
ranked drivers
        ↓  best are kept, mutated and recombined
next generation
```

---

### 1. The Car — Physics

Every simulation step (1/30 s) resolves the forces on the car.

**Longitudinal forces**

```
N      = m·g + downforce                  (load pressing the tyres down)
F_drag = ½·ρ·Cd·A·v²                      (ρ = 1.225 kg/m³)
F_roll = 0.015·N
F_eng  = min(0.9·P/v · finalDrive/3.8, μ·Fz_rear) · throttle
a_x    = (F_eng − F_drag − F_roll − F_brake) / m
```

**Weight transfer** — braking pushes load onto the front axle, accelerating onto
the rear (h = 0.5 m assumed CG height, L = wheelbase):

```
ΔFz      = m·a_x·h / L
Fz_front = N/2 − ΔFz
Fz_rear  = N/2 + ΔFz
```

This is what makes **trail braking** a real trade-off: braking into a corner loads
the front tyre and buys grip for turn-in, but spends part of that tyre's budget on
braking. Brake bias is 60% front.

**The friction circle** — each tyre has one grip budget shared between braking and
cornering. Whatever a tyre spends going forwards, it can't spend turning:

```
F_lat_max = √(1 − (F_long / (μ·Fz))²) · μ·Fz          per axle
a_lat_max = (F_lat_front + F_lat_rear) / m
```

**Rotation** — the steering command asks for a yaw rate, and grip decides whether
the car can deliver it:

```
ω = clamp(steer · 2.2 rad/s,  ±a_lat_max / v)
a_x' = a_x · √(1 − (a_lat_used / a_lat_max)²)
```

Ask for more rotation than grip allows and the car simply understeers instead.

---

### 2. The Reference Speed Profile

Before training, the optimizer computes a near-ideal speed for every point on the
track. This becomes the speed *limit* the AI is judged against.

```
v_corner = √(a_lat_max / κ)               κ = curvature (1/radius)
```

Then two passes make it physically reachable — you can't accelerate or brake
instantly:

```
forward  (from a standing start, v₀ = 0):
    vᵢ = min(vᵢ, √(vᵢ₋₁² + 2·a_accel·ds))

backward (so the car is already slowing for the next corner):
    vᵢ = min(vᵢ, √(vᵢ₊₁² + 2·a_brake·ds))

reference lap time = Σ ds / v_avg
```

---

### 3. The Driver — Neural Network

A small feed-forward network: **14 inputs → 12 hidden (tanh) → 3 outputs**, giving
`(14+1)·12 + (12+1)·3 = 219` weights. That weight array *is* the genome.

| Inputs (14) | |
|---|---|
| 5 distance sensors | rays at −43°, −20°, 0°, +20°, +43° |
| current speed | normalised to top speed |
| lateral offset | distance from centreline |
| 3 lookahead limits | corner speed limits ahead, scaled by braking distance |
| lap progress | how far around the lap |
| yaw rate | how fast the car is rotating |
| grip usage | how close the tyres are to the limit |
| bias | constant 1 |

| Outputs (3) | Range |
|---|---|
| steering | −1 … 1 (tanh) |
| throttle | 0 … 1 (sigmoid) |
| brake | 0 … 1 (sigmoid) |

A single linear layer can't represent "brake hard *while* turning in, then release
as you unwind the steering" — the hidden layer is what makes trail braking
learnable.

---

### 4. The Score — Fitness

```
fitness = 10000 · progress                  how far around the lap
        +   400 · Δprogress                 momentum this step
        +   800 · gripUse · progress        reward for using the tyres when trail braking
        −    12 · lapTime                   go faster
        −  qualityPenalty                   driving errors (capped at 3000)
        −   200 · offTrackTime
        −  2000 · (1 − progress)            if it crashed
        + 12000 · min(3, refLap / lapTime)  if it finished
```

`qualityPenalty` collects the driving mistakes:

```
qualityPenalty = 3000 · avg(overspeed²)     carrying more speed than the corner allows
               +  150 · avg(edgeProximity)  light wall-scrape deterrent
               + 1200 · avg(backwards)      facing the wrong way
               +  400 · avg(yawExcess)      sliding / spinning
```

Two deliberate choices worth knowing:

- **The speed profile is a limit, not a target.** Only *exceeding* it is punished.
  Being slower is already punished by lap time — penalising both would
  double-count it and punish accelerating away from the start line.
- **There is no "stay near the centreline" term.** A racing line is *defined* by
  leaving the centreline: wide entry, clip the apex, open the exit, straighten a
  chicane into one line. Penalising lateral offset would reward tracing the
  track's curvature instead. Staying on the road is enforced by hard track limits;
  the *line* is shaped purely by lap time.

---

### 5. Evolution

Each generation of population `P` is rebuilt as:

| Share | Source |
|---|---|
| 8% | **Elites** — top performers copied unchanged |
| 40% | **Refinement** — small mutations of the top 20%, at four step sizes (σ × 0.25, 0.5, 1, 1.5) |
| 5–15% | **Fresh random** genomes for diversity |
| rest | **Crossover** — uniform, each weight taken whole from one parent or the other |

**Mutation** is Gaussian with σ = 0.12 (typical weight magnitude is ~0.25), with a
10% chance of a 5× jump to escape a local optimum:

```
w' = w + N(0, σ)          90% of the time
w' = w + N(0, 5σ)         10% of the time
```

The refinement band is what produces steady, incremental gains — without it the
only route to a better driver is one lucky large mutation, which makes progress
arrive in sudden jumps.

**Stagnation** — if the best fitness doesn't improve, exploration widens:

```
level = min(3, ⌊flatGenerations / 5⌋)
```

This raises mutation size and random injection, but **only for the exploration
band** — refinement always stays fine-grained, and the level is capped. Local
search has to stay local to work.

The best genome ever seen is always carried forward, so the champion can never be
lost.

---

### 6. Track Limits

The track is 5 m from centreline to edge. Leaving it isn't an instant fail — it's
a grip penalty, like running onto grass:

```
grip multiplier: 1.0 → 0.35 over the first 0.5 m beyond the edge
```

A car is retired when it's clearly gone:

- more than **8 m** beyond the edge (in the barriers), or
- more than **1.5–2.5 s** cumulative off-track (depends on the car)

Two guards keep scores honest:

- **Progress is capped at 1.4× the distance actually travelled**, so cutting across
  a corner's apex can't claim track it never drove.
- **Crossing the finish counts as a lap** if the car is within 6 m of the end and
  pointing forward — otherwise driving *through* the finish line would score as
  leaving the track.

Each generation gets **3× the reference lap time** to finish (minimum 75 s), since
a learning driver laps far off the ideal pace.

---

### Tuning Cheat Sheet

| Setting | Effect |
|---|---|
| **Population** | More drivers per generation = better coverage, slower generations |
| **Generations** | More time to refine. Lap times keep improving long after the first completed lap |
| **Mutation** | Higher = more exploration, noisier population. 0.2–0.45 is a sensible range |

Larger and tighter tracks need noticeably more generations — the AI must survive
every corner before it can start optimising the line through them.
