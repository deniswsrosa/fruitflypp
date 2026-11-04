# QueryFly — a fruit-fly brain writes SQL++, Beat Saber style

Exploration for: a simple webpage where a 3D fruit-fly brain "plays" SQL++ queries
against the Couchbase `travel-sample` dataset, in the style of the viral MaleCNS demos
(Minecraft / Beat Saber / Doom / Bitcoin fly).

Status of this doc: research done, all SQL++ verified live against a real
`travel-sample` bucket on 2026-11-03. A v1 demo is built and running
(`server.js` + `public/`, single-page, zero npm dependencies).

---

## 1. How the viral fly demos actually work

The trigger was **MaleCNS v1.0** (released 2026-06-08, paper in *Cell* Sept 2026): the
first complete wiring diagram of an adult male fruit fly's entire central nervous system,
from FlyEM (HHMI Janelia) + University of Cambridge + MRC LMB + Google Research.
Popular summary: ~166,000 neurons, ~125M synapses. Simulation-relevant numbers from the
flat release tables: **166,700 neurons with annotations, 140,638 with finite soma
positions, ~25.6M aggregated neuron→neuron connections (~124M synaptic contacts)**,
CC BY 4.0. Google Research blog: "A connectomics milestone: mapping the complete male
fruit fly brain".

The connectome is a **directed, signed weighted graph**: edge weight = synapse count,
sign = predicted neurotransmitter of the source neuron (acetylcholine = excitatory,
GABA/glutamate/histamine = inhibitory). Every viral demo reduces to:

1. Load the graph as a sparse matrix.
2. Simulate **leaky integrate-and-fire (LIF)** neurons over it (Shiu et al., Nature 2024 recipe).
3. Drive it with noise and/or a few "sensory" inputs, read spikes out of identified
   neuron groups, map those to actions.

Patrick Mineault's ["Deconstructing viral fly sims"](https://www.neuroai.science/p/are-flies-playing-beat-saber)
is the best writeup: most demos (incl. the Beat Saber one) are a **noise-driven LIF
network button-mashing** — the fly isn't really "seeing" the game; the Beat Saber fly was
even overtrained on one track. That's fine for a gag demo as long as we're honest about it.

### The exact LIF "controls" that make it stable

From [flybrain-snake](https://github.com/charbelkassab/flybrain-snake) (the most rigorous
of the viral-wave repos — it also proves real wiring matters via scrambled-wiring controls):

| Parameter | Value | Note |
|---|---|---|
| resting / reset potential | −52 mV | |
| threshold | −45 mV | |
| membrane τ | 20 ms | |
| synaptic τ | 5 ms | |
| refractory | 2 ms | |
| synaptic delay | 2 ms | |
| time step | 1 ms | (paper: 0.1 ms) |
| synapse gain | **0.1 mV per contact** | the paper's 0.275 causes seizure-like runaway in MaleCNS |
| spike-frequency adaptation | 3 mV/spike, τ 200 ms | real neurons adapt; base model doesn't |
| input drive | Poisson, 150 Hz | |
| signs | acetylcholine +, GABA/glutamate/histamine − | |

Stability fixes that mattered: **drop Kenyon-cell ↔ Kenyon-cell contacts** (dense
axo-axonic loop), **drop synapses onto sensory neurons** (they're driven by the world),
treat dopamine/serotonin/octopamine as slow modulators, not fast excitation. With these,
activity decays to ~100 active neurons within 60 ms after stimulus instead of ~20,000
self-sustaining.

### Prior art worth stealing

- **[flyverse](https://github.com/djmango/flyverse)** — Rust full-brain LIF, **SSE stream of
  spikes to a three.js 166k-neuron point cloud** in the browser. This is the exact
  architecture pattern for our webpage (`GET /api/spikes?from=N`, one frame per 2 ms
  window). Also documents the official data location.
- **[FlyCoder](https://github.com/tolga-ileri/FlyCoder)** — Python frozen MaleCNS sim +
  dashboard with the **honest "what is real vs experimental" table** (we should copy that
  pattern) and a cheap viz recipe: 8,000 visible somata + 6,000 sampled real synapses +
  density shell. ~30–43 FPS, no problem.
- **[fly.ai / flybrain](https://github.com/alextitonis/fly.ai)** — `pip install flybrain`,
  `flybrain download` fetches a **prebuilt 260 MB connectome** (no 1.1 GB raw feather
  download needed). `FlyBrain` steps the whole brain in 12–15 ms on a 24-thread CPU,
  1.4 ms on a midrange GPU. Has `Trace`/`Readout` (reservoir decoding), identified
  input types (LPLC2/LC4 looming, LC10a chase) and output groups (DNa02 steering,
  DNp01 giant fiber, DNg100 forward, MDN backward). Repo-only `flybrain export --web`
  gzips the connectome for in-browser simulation (how their "Wiz" demo runs it in WebGPU).
- **[flybrain-snake](https://github.com/charbelkassab/flybrain-snake)** — the stability
  table above + the **scrambled-wiring control** (same synapse counts, random targets →
  behavior collapses). Perfect as an easter egg / honesty toggle.
- **[FLM (Fly Language Model)](https://www.neuroai.science/p/are-flies-playing-beat-saber)**
  — "talk to a fly": frozen LM embeddings → frozen fly sim → adapter → token
  probabilities. The prior art for option C below.

### Data (CC BY 4.0 — attribution required)

Official flat-connectome tables (what the sims load):
`https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/`
- `connectome-weights-male-cns-v1.0-minconf-0.5.feather` (~1.05 GB)
- `body-annotations-male-cns-v1.0-minconf-0.5.feather` (~14 MB, cell types + soma positions)
- `body-neurotransmitters-male-cns-v1.0.feather` (~43 MB)

Or skip the raw files entirely: `pip install flybrain && flybrain download` (~260 MB
prebuilt, sha256-checked). neuPrint (`male-cns:v1.0`) also offers programmatic access.
For the webpage viz we only need soma positions + a sampled edge subset → trivially
exportable from either path.

Attribution string to show in the footer:
"Connectome: MaleCNS v1.0, FlyEM (HHMI Janelia), University of Cambridge, MRC LMB, and
Google Research — CC BY 4.0 (male-cns.janelia.org)".

---

## 2. Couchbase: current local state

The old `nodebb-couchbase` container was unhealthy (container `nofile` ulimit 1024 →
ep-engine stuck in warmup) and, with your go-ahead, has been replaced by a fresh
container named `couchbase`:

- image `couchbase:community-7.6.2`, `--ulimit nofile=262144:262144`
- ports 8091–8093 + 11210 on 127.0.0.1, user `Administrator` / password `password`
- `travel-sample` loaded (63,288 docs) + primary index; read-only use is all we need
- the demo server defaults to `http://127.0.0.1:8093/query/service`

The old volume `nodebb-couchbase-data` was left in place; delete it with
`docker volume rm nodebb-couchbase-data` if you don't want it. If you ever need to
recreate this cluster from scratch: `couchbase-cli cluster-init` → `bucket-create
travel-sample` → `cbimport json -f sample` (7.6 images have no `cbdocloader`) →
`CREATE PRIMARY INDEX ON travel-sample`.

---

## 3. Verified `travel-sample` schema + SQL++ gotchas (live-checked)

Doc counts: `route` 24,024 · `landmark` 4,495 · `airport` 1,968 · `hotel` 917 · `airline` 187.

**Gotchas that a query generator MUST respect** (each discovered by running queries):

1. **Route→airport JOIN does not work via document keys.** Airport doc keys are
   `airport_<id>` (e.g. `airport_1353`); `route.destinationairport` is the FAA code
   (`"MRS"`). `JOIN ... ON KEYS r.destinationairport` returns **zero rows**. The canonical
   JOIN is route→**airline** via `r.airlineid` (`"airline_137"`). For airport names use a
   correlated subquery on `faa` — and expect **unmatched codes** (e.g. `AKL` has no airport
   doc; the subquery returns missing/NULL).
2. **Hotel `price` is not numeric.** In this build: 437 hotels have `price: null`, the
   other 480 have *strings* like `"Basic rooms start at €89..."`. `price < 300` returns
   **zero rows**. Never emit numeric price predicates; use `vacancy`, `free_breakfast`,
   `free_internet`, `free_parking`, `pets_ok`, `city`, `reviews[*].ratings.Overall`.
3. **Paris has 64 hotels; ~27 priced (as strings)**; city values include
   `Paris-15E-Arrondissement` etc. — `city = "Paris"` ≠ LIKE "Paris%".
4. `route.schedule[]` = `{day: 0–6, utc: "HH:MM:SS", flight: "XX000"}`; day 1 is the
   busiest (~72.3k flights across the dataset).
5. `route.equipment` is a space-separated **string** (`"757 739"`, `"321 319 320"`) →
   match with `LIKE "%739%"` / `CONTAINS()`.
6. `landmark.activity` ∈ `see` (1,722) · `eat` (1,129) · `do` (660) · `drink` (602) ·
   `buy` (380).
7. Prefer `IS NOT NULL` / `ISNUMBER()` guards; the dataset mixes MISSING and NULL.

### Verified query catalog (the fly's "song charts")

```sql
-- A1: airport lookup (city/country from a live "scent" pre-query)
SELECT airportname, city, faa FROM `travel-sample`
WHERE type = "airport" AND city = "San Francisco";

-- A2: high-altitude airports (GROUP/ORDER flavor)
SELECT country, COUNT(*) AS airports FROM `travel-sample`
WHERE type = "airport" GROUP BY country ORDER BY airports DESC LIMIT 5;

-- B1: the canonical JOIN — routes from an airport, with airline names ✔
SELECT r.sourceairport, r.destinationairport, al.name AS airline, al.country
FROM `travel-sample` r JOIN `travel-sample` al ON KEYS r.airlineid
WHERE r.type = "route" AND r.sourceairport = "SFO" LIMIT 5;

-- B2: destination names via correlated subquery (tolerates NULL dest) ✔
SELECT r.destinationairport AS code,
       (SELECT RAW a.airportname FROM `travel-sample` a
        WHERE a.type = "airport" AND a.faa = r.destinationairport)[0] AS dest
FROM `travel-sample` r WHERE r.type = "route" AND r.sourceairport = "SFO" LIMIT 5;

-- C1: busiest weekdays (UNNEST) ✔
SELECT s.day AS weekday, COUNT(*) AS flights FROM `travel-sample` r
UNNEST r.schedule s WHERE r.type = "route"
GROUP BY s.day ORDER BY flights DESC;

-- C2: direct routes only (stops = 0), airline ranking ✔
SELECT airline, COUNT(*) AS direct_routes FROM `travel-sample`
WHERE type = "route" AND stops = 0 GROUP BY airline
ORDER BY direct_routes DESC LIMIT 5;

-- C3: equipment search ✔
SELECT airline, sourceairport, destinationairport FROM `travel-sample`
WHERE type = "route" AND equipment LIKE "%739%" LIMIT 5;

-- D1: hotel search, price-safe ✔
SELECT name, city, vacancy, free_breakfast FROM `travel-sample`
WHERE type = "hotel" AND city = "Paris" AND vacancy = true
ORDER BY name LIMIT 5;

-- D2: top destinations from an airport (no JOIN needed) ✔
SELECT destinationairport, COUNT(*) AS flights FROM `travel-sample`
WHERE type = "route" AND sourceairport = "SFO"
GROUP BY destinationairport ORDER BY flights DESC LIMIT 5;

-- D3: well-reviewed hotels (advanced chart)
SELECT name, city FROM `travel-sample`
WHERE type = "hotel" AND city = "Paris"
AND ANY r IN reviews SATISFIES r.ratings.Overall >= 4 END LIMIT 5;

-- D4: eat/drink/see landmarks ✔
SELECT name, activity, city FROM `travel-sample`
WHERE type = "landmark" AND activity = "eat" AND city = "Paris" LIMIT 5;
```

Random parameters (city, FAA code, airline, equipment code, activity) should be drawn
live from small "scent" queries (`SELECT DISTINCT city FROM ... WHERE type="hotel"`
etc.) so the fly's queries always hit real data.

---

## 4. The core question: how does the fly "generate" queries?

Three honest options:

### Option A — Theater (procedural sparks + templates)
A random/spark animation plays in the brain while a template engine emits queries.
Zero data downloads, an evening of work. Indistinguishable from the viral demos in
effect, but it's a lie and we'd know it.

### Option B — Real LIF + grammar-constrained token emission (recommended)
The actual MaleCNS connectome runs as a LIF simulation; its spikes genuinely choose the
queries, and a grammar guarantees they're valid SQL++:

1. **Charts**: each query archetype above is a "Beat Saber chart" — a sequence of token
   slots with candidate sets (`SELECT` | `SELECT DISTINCT` | `SELECT RAW`, field lists,
   `WHERE` clauses, ...). ~120-token vocabulary total.
2. **Token ↔ neuron-group mapping**: each candidate token maps to a neuron group
   (curated named groups — optic-lobe cell types, Kenyon cells, antennal-lobe PNs,
   descending neurons; or hash-assigned clusters spatially grouped so tokens of one
   clause type light a coherent brain region). The mapping is interface, not biology —
   say so on the page.
3. **Per beat (say every 500 ms at 120 BPM)**: step the brain ~10–20 ms, inject
   beat-pulsed Poisson noise (that's what gives the demos their rhythm), read the spike
   counts of the current slot's candidate groups, softmax/winner-take-all → the winning
   token is emitted as a Beat Saber block and appended to the query.
4. **Grammar safety**: candidate sets only ever contain tokens that keep the query
   parseable; optional extra validation by running the query (we run it anyway).
5. **Execution**: after the final token (a gold `EXECUTE` block), the backend runs the
   query against `travel-sample` and streams rows to the results panel.

CPU cost is fine: `flybrain` does a 20 ms step in 12–15 ms on this 24-thread machine;
a beat needs only a handful of steps. flyverse proved even 0.23× real-time streaming
looks great in a browser.

**Honesty table (put this on the page, FlyCoder-style):**

| Component | Status |
|---|---|
| Connectome graph (who connects to whom, sign, weight) | real MaleCNS v1.0, CC BY 4.0 |
| Spikes, which groups fire when a token is chosen | real LIF simulation |
| Query executed against `travel-sample` | real Couchbase, real results |
| Token↔neuron-group mapping, charts, beat clock | interface (our design) |
| "The fly understands SQL" | no. Obviously. It's a fly. |

**Easter egg (also the scientific control):** a "scramble wiring" toggle that
degree-preserving-shuffles the graph — the fly's queries visibly degrade. That's the
exact experiment flybrain-snake ran to prove the wiring matters.

### Option C — Reservoir/LLM hybrid ("talk to a fly")
Local LLM (e.g. Ollama) or FLM-style frozen-LM-embedding → fly sim → adapter generates
the query; fly activity modulates token probabilities (clusters glow with the LM's
uncertainty). The most "wow", but heavier and more failure modes. Good v2: swap the
grammar's candidate ranking from "spike counts" to "LLM logprobs nudged by spike
counts".

---

## 5. Recommended architecture

```
┌──────────────────────────── browser (one static page) ───────────────────────────┐
│ three.js: 166k-soma point cloud (or 8k sample + edges, FlyCoder recipe)          │
│ Beat Saber lane: token blocks fly at the viewer, sliced on beat → SQL assembles  │
│ query panel (syntax-highlighted) + results table + "what's real" honesty table    │
│ Tone.js: synthwave loop + slice SFX (no licensed audio)                          │
└──────────────▲───────────────────────────────────────────────────────────────────┘
               │ SSE (one JSON event per beat: token + sampled spike ids)
┌──────────────┴──────────────┐        ┌─────────────────────────────┐
│ Python backend (FastAPI)     │        │ Couchbase 8.0.2 (your 8091) │
│  • flybrain FlyBrain LIF     │  HTTP  │  bucket: travel-sample      │
│  • grammar/charts engine     │ ─────▶ │  (N1QL/SQL++ on :8093)      │
│  • scent pre-queries         │        │  until healthy: flyquery-cb │
│  • executes finished queries │        │  on 127.0.0.1:18093         │
└──────────────────────────────┘        └─────────────────────────────┘
```

SSE event sketch:
```
event: beat    data: {"n": 12, "bpm": 120}
event: token   data: {"text":"GROUP BY","kind":"keyword","region":"mushroom_body","beat":12}
event: spikes  data: {"ids":[412,9077,...]}          // ~200 sampled firing neuron ids
event: query   data: {"sql":"SELECT ...","tokens":18}
event: result  data: {"rows":[...],"elapsed_ms":3.2,"status":"success"}
```

Frontend: single `index.html`, three.js from CDN, no build step (matches "simple
webpage"). Backend: Python (flybrain is Python/numba; `FastAPI + uvicorn`, SSE via
`StreamingResponse`). Could also do a pure-static v1 with the brain sim exported via
`flybrain export --web` (Wiz-style, WebGPU) — no Python server at all — but that's
more exotic; keep as an alternative.

Proposed layout:
```
fruitfly/
  EXPLORATION.md            ← this file
  backend/app.py            # FastAPI + SSE
  backend/charts.py         # query archetypes / token slots (verified catalog above)
  backend/fly.py            # FlyBrain wrapper, token↔group mapping, beat stepping
  backend/cb.py             # SQL++ runner (REST to :8093 is enough; SDK optional)
  web/index.html
  web/brain3d.js            # soma cloud + spike flashes
  web/lane.js               # beat-saber token lane
  web/music.js              # Tone.js loop + slice SFX
  scripts/setup_couchbase.sh
```

## 6. Milestones

- **M0 ✅** — research + verified query catalog + travel-sample running.
- **M1 ✅** — static page: procedural 3D fruit fly (Three.js primitives) with the real
  MaleCNS cloud as its CNS (PCA-oriented: brain in the head, nerve cord down the body),
  a keyboard it "types" on — each keypress launches a Beat Saber token block — plus
  WebAudio blips and query/results panels. Debug params: `?autostart`, `?still`, `?nofly`.
  Interactive: chart chips + skip, tempo slider, click-a-block to slice it (with counter),
  x-ray toggle, mute, click-the-brain region inspector (raycast over 141k points).
- **M2 ✅ (simplified)** — backend streams tokens over SSE and executes each finished
  query for real against `travel-sample` (5 template charts, live-sampled parameters).
  The flybrain LIF sim from the original plan was deliberately left out of v1 — the
  spike flashes are decorative, and the page says so. Revisit only if you want the
  neurons to genuinely pick the tokens.
- **M3** — polish: region glow per clause type, results table, scrambled-wiring toggle,
  "lesion the JOIN neurons" joke, mobile/WebGL fallback.
- **M4 (optional)** — Option C LLM hybrid, clip recording for sharing.

## 7. Open questions / assumptions

- **Backend language**: Python chosen (flybrain). Node would need a separate LIF port —
  not worth it. The browser only talks SSE + JSON.
- **Music**: original synth loop via Tone.js (no licensing issues).
- **Cluster**: demo targets `flyquery-cb` until your 8091 cluster is healthy; both are
  supported via env var. Recreating `nodebb-couchbase` needs your go-ahead (NodeBB
  depends on it; data is in the volume, so it's safe).
- **Counts in marketing copy** ("166k neurons / 125M synapses") vs sim numbers
  (166,700 neurons / 25.6M connections / ~124M synaptic contacts) — both are defensible;
  the page footer should use the attribution string either way.
- Whether you want option B (real wiring picks the tokens) or A (pure theater) for v1 —
  B is barely harder since flybrain is pip-installable, and it's the one that's actually
  true.

## M3 — real Drosophila mesh + real keyboard (done)

**Fly model**: Thingiverse thing:1511303 "Drosophila melanogaster model / fruit fly" by
benny369, CC BY-NC 3.0 (attribution in page footer). Source STL 1.38M tris, mirrored at
archive.org (`thingiverse-1511303`). The two small connected components are a spherical
print-cage — drop them; the body component is the complete fly.

**Pipeline** (`scripts/build_fly_glb.py`, venv needs trimesh/fast-simplification/scipy/networkx/matplotlib):
1. Keep largest component, decimate 1.38M -> 150k tris (fast_simplification).
2. Classify triangles: eyes (two lobes z 425-545, y<232, lateral), wings (big flat tris,
   |x-165|>62, z<430, split L/R at x=165), legs (small area, outside body core, z 140-462),
   head (within 105 of (165,231.5,481.1)), body = rest. Legs are CUT from the mesh —
   procedural jointed legs replace them so the front pair can type.
3. Export `public/fly.glb` (~4 MB, indexed, vertex colors, smooth normals) +
   `public/fly-meta.json` (headCenter, eyeCenters, wingPivotL/R, hips).

**Scene orientation**: the model is already head-+z / face-+y — NO rotation needed
(`modelGroup.rotation.x = -0.22` pitches the head up slightly). Earlier attempts
(Rx(-90), Rz(π)) were based on misread axis assignments.

**Brain fit**: `brainAnchor` is a child of the GLB holder at meta.headCenter (model units —
holder's own translation handles recentering; do NOT subtract the shift, that double-counts).
cloudGroup quaternion = plain CLOUD_ROT (nerve cord trails -z into the body).
BRAIN_SCALE 0.24 cloud units -> scene; points size 0.034 local.

**Keyboard**: ANSI 5-row layout with true stagger/key widths, per-key canvas label texture
on the +y face (6-material boxes), cyan underglow strip. Token -> physical key via
first char + shift-alias map (e.g. `*` -> `8`), hash fallback.

**Animation**: wing pivots (baked wingPivotL/R) flutter ~42 Hz with keypress boost;
front procedural legs tap keys (knee/foot rotation, 200 ms); fly bobs on each beat,
hops on execute.

**Gotchas hit**: server static whitelist needed generalizing (now serves anything under
public/ + data/ with traversal guard); GLTFLoader r169 needs ../utils/BufferGeometryUtils.js
(kept three's dir layout under vendor/); brain double-shift bug (anchor must use raw model
coords); key.material is now an ARRAY (emissive on material[2]).

M3 tweaks: BRAIN_SCALE 0.19 (contained in head), keyboard rows flipped so the space
row faces the fly (z = (2-ri)·u·1.02), only front legs animate (bounce 0.007), spark
size 0.16/brightness 4.5/life 950ms/ambient 36 per 110ms for the "thinking" look,
panel badge states the connectome is the real published MaleCNS v1.0.

## M4: ellipsoid brain fit + polish round
- `fitBrain()` now auto-fits: pins the brain centroid to the head-center anchor and
  scales the cloud to the largest size where every brain point stays inside the head
  capsule. Capsule = tilted ellipsoid (principal axes of head+eyes triangles,
  per-direction p2/p98 radii), shrunk by HEAD_SAFETY 0.85 -> 0.82. Meta gained
  `headRadii` [[+,-] x3] + `headAxes` (3 basis rows) from `scripts/build_fly_glb.py`.
- Verified offline (`/tmp/check_fit.py` replicates the JS math, scl matched the live
  page to 3 decimals): 0/126,104 brain points outside the head hull. 0.85 safety had
  ~67 corner leakers at the upper-lateral hull facet; 0.82 -> 0.
- Legs: distance-based cut around the actual mesh legs z'∈[-0.45,0.22], y'<0.56,
  |x|>0.05, ~not head (the old area-based filter left hip stubs that read as 6 extra
  legs). 12 -> 6 legs.
- Keycap labels drawn rotated 180 (they read upside down after the row flip).
- ctrl/alt shimmer: label texture anisotropy 4 -> 16.
- Wings: flutter removed (user request), static fold -0.04.
- Sparks: size 0.16 -> 0.085, brightness 4.5 -> 3.0 (close-up blobs).
- Couchbase: switched from local Docker to remote Capella
  (your-cluster.example, user <your-query-user>, hardcoded).
  n1ql() now uses https.request with rejectUnauthorized:false (Capella cert is
  Couchbase-internal CA). travel-sample present, 31,591 docs. Works, latency ~0.2-3.8s.

## M5: CT-scan fly model
New mesh: `/home/deniswsrosa/Downloads/drosophila_-_adult_fruit_fly_-_ct_scan.glb`
(Skecthfab CT scan, 15 unnamed chunks, 1.5M tris, walking pose, no colors).
Pipeline: `scripts/build_fly_glb_ct.py` (old STL script kept for reference).
- Bake upright: (x, y, z) -> (x, z, -y): head +z, dorsal +y, legs -y. Decimate to 200k.
- Classify (baked coords): head ellipsoid ctr (0, 0.80, 0.50) r (0.33, 0.32, 0.30);
  eyes = head & z'>0.50 & y'>0.68 (front-upper quadrant — the eyes dominate a real
  head, sphere seeds over-select); wings = big-area & y'>0.78 & z'<0; legs cut per M4.
- meta: headCenter = eye_ctr + [0, 0.02, +0.02] (FORWARD — capsule back-radius was
  swallowing the neck and hiding the brain behind the eyes), hips from leg tris near
  the root (|x|<0.35, y'>0.28), wing pivots = wing front-edge mean. fly.glb ~6.2 MB.
- main.js: FLY_SCALE 0.65, modelGroup.rotation.x = -0.55 (body mostly horizontal,
  face tips up to camera; -1.15 hides the abdomen below the keyboard), flyGroup.z
  +0.35 (bbox recentering parks the fly behind the keyboard — abdomen dominates the
  bbox), leg plans + bone radii re-derived: M = Rx(+pitch) . (W/S) where W is the
  world offset FROM THE HIP (using the absolute target as W plants feet wrong).
  Front feet -> space row (world ~ +-0.42, -0.51, 0.65).
- Brain containment re-verified offline (/tmp/check_fit_ct.py): 0/126,104 outside hull.

Credits: panel top-right `.credits` block (index.html) thanks the Sketchfab µCT scan
(https://sketchfab.com/3d-models/drosophila-adult-fruit-fly-ct-scan-ad29b897bd2b4e27bb04ab9d31baa117#download)
and FruitSaber (https://x.com/_lyraaaa_/status/2097527368919470162); footer links the model too.

M5b: procedural stick legs removed (read as awkward next to the real anatomy).
Mesh legs are kept now (build script no longer excludes leg_mask from body;
main.js leg-building block deleted — bone/mkLeg now unused, frontLegs stays
empty so the tap loop is a no-op). The fly's own scanned legs stand at the
keyboard; key flashes + execute hop remain as the typing feedback.

M5c: keyboard rows reverted to normal viewer orientation (z = (ri-2)·u·1.02 — space
row near the camera, digits far toward the fly); the fly-side flip inverted the layout
for the viewer. Glyph 180° rotation reverted with it (labels read upright from the
camera side again).

M6: renamed to FruitFly++ (title, panel, intro, server banner). Intro overlay: big
FRUITFLY++ title, larger text (15.5px/1.7), start button pinned to the bottom via
margin-top:auto, overlay scrollable on short windows. Credits moved from the panel to
absolute bottom-right of #stage. Fly semi-transparent: MAT body 0.5 / eyes 0.9
(depthWrite off everywhere) — CT-ghost look, brain shows through. Keyboard physically
rotated 180° (kbGroup.rotation.set(-0.42, π, 0)): space bar on the fly side, labels
read correctly from the fly side (mirrored/upside-down from the camera). Camera zoom
+30% via fov 55 -> 42.

M7: side brain view like Fly Saber's Neurons panel — picture-in-picture in the
bottom-left of #stage. One renderer, scissored viewport (12,12,170,170 css px);
pipCam (fov 30, layers=1) orbits the cloud center (0.5 radius, y+0.14, 0.35 rad/s).
cloudPts + sparkPts enable layer 1 so the PiP sees ONLY the connectome + live
sparks (fly mesh/keyboard stay layer 0, invisible to it). PointsMaterial is unlit,
so no lights needed on layer 1. Frame div + "MaleCNS v1.0 · live activity" label
are absolutely positioned over the canvas corner. Viewport restored to full after
each PiP render (three multiplies scissor/viewport by pixelRatio internally).

M8: Fly-Saber-faithful activity + perf. Read their frontend (features/brain/brain-scene.tsx):
two-layer cloud — faint "sketch" of all neurons at rest + "ink" layer where active
neurons draw BIGGER, colored by signed activity (excite vermilion / inhibit blue,
diverging like calcium imaging), round soft gl_Points via smoothstep discard.
We adopted: DOT radial sprite for all point materials (PointsMaterial draws squares
otherwise — the "gray boxes"), sparks colored warm (token spikes, EXCITE 0xff4a2d)
vs cool (ambient idle, INHIBIT 0x5f8bff), PiP sketch = 4:1 subsample (35k pts,
0.022/0.1) so the dense cloud reads as a sketch not a white blob.

PiP architecture v2: separate small WebGLRenderer (170px, dpr 1.25, preserveDrawingBuffer,
~25 fps setInterval) instead of scissoring the main canvas — a low-fps scissor pass
can't work because the main render's autoClear wipes the region every frame.
GOTCHA: Box3.setFromObject on the first interval tick ran before any main render had
refreshed matrixWorld → froze a garbage cloud center (y=0.04); now recomputed per tick
(geometry boundingBox is cached, cost is trivial).

Perf: headless SwiftShader fps 3.7 -> 5.7 after: TARGET_TRIS 200k->120k (GLB 4.6MB),
main cloud size 0.04->0.03 opacity 0.65, main renderer dpr cap 1.5->1.25, ambient
sparks 36/110ms -> 24/150ms. Attribution probe: hiding cloud 6.4fps, hiding fly 7.2fps.

M9: x-ray is the default and the toggle is gone — MAT body/head/eyes/wing all at
opacity 0.06 (the old x-ray target), #xray button + handler removed. The fly reads
as a faint ghost; the connectome cloud is the visual focus.

M10: another 30% zoom (fov 42 -> 32), PiP brain box +40% (170 -> 238 css px, label
repositioned to bottom:256px). autoRotate turned OFF — at fov 32 the orbit swung the
subject out of the tight frame (and it forced a constant 60fps redraw). Note: the
headless test Chrome now runs at 1680x1000 (the old default made the portrait stage
look misleadingly cramped).

M11: corner brain -> panel. PiP moved INTO the right panel above the REAL CONNECTOME
badge (in-flow divs, no absolute positioning; pointer-events restored so it's
interactive). Camera 40% closer (offset 0.3/0.14/0.25 vs 0.42/0.2/0.35). Sketch
opacity 0.28 -> 0.16 (semi-transparent: inner activations show through the core).
pipControls: damped OrbitControls on the PiP canvas (rotate drag, wheel zoom,
pan disabled), target re-anchored to brainCenter every tick (the fly bounces).
Activation targets boosted ×1.6 so lit neurons pop against the dimmer rest state.
__qf.flash(r, c, warm) debug hook added.
