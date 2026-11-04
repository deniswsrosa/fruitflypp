#!/usr/bin/env python3
"""Fly-Saber's trained rate network, driven by key flashes and colored targets.

stdin: JSON lines containing up to 16 rectangular visual patches.
stdout: ready metadata, then 15 Hz signed int8 changes from gray-background rest.
The original saber readout is unused: SQL remains template generated.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/fly-saber/src"))
os.environ.setdefault("JAX_PLATFORMS", "cpu")

import jax
import jax.numpy as jnp
import numpy as np
import pandas as pd

from brain.config import ModelConfig
from brain.connectome.metadata import column_angles
from brain.model.brain import Params, load_graph, make_step, rest_state
from brain.model.interventions import no_interventions
from fly_saber.eye import EyeConfig, Patches, render

VISUAL_TTL = 2.0
STIMULATION_TTL = 1.0


def fingerprint(values):
    return hashlib.sha256(np.ascontiguousarray(values, dtype=np.int64).tobytes()).hexdigest()[:16]


class Brain:
    def __init__(self):
        bundle = ROOT / "data/brain-model"
        graph_dir = bundle / "subgraph"
        self.neurons = pd.read_parquet(graph_dir / "neurons.parquet")
        edges = pd.read_parquet(graph_dir / "edges.parquet")
        with np.load(bundle / "bc_950.npz", allow_pickle=False) as checkpoint:
            meta = json.loads(str(checkpoint["__meta__"]))
            identity = json.loads((bundle / "MANIFEST.json").read_text())["subgraph_fingerprint"]
            if any(identity.get(k) != v for k, v in meta["subgraph"].items()):
                raise ValueError("Checkpoint metadata does not match the bundle manifest")
            self.neuron_hash = fingerprint(self.neurons["body_id"].to_numpy())
            if self.neuron_hash != identity["neurons_sha256"]:
                raise ValueError("Checkpoint neuron IDs/order do not match the subgraph")
            if fingerprint(edges[["pre", "post", "weight"]].to_numpy()) != identity["edges_sha256"]:
                raise ValueError("Checkpoint synaptic graph does not match the subgraph")
            asset = json.loads((ROOT / "public/brain/neurons.json").read_text())
            if asset["body_id"] != self.neurons["body_id"].astype(int).tolist():
                raise ValueError("Browser neuron IDs/order do not match the model")
            config = {**meta["configs"]["model"], "subgraph_dir": str(graph_dir)}
            self.cfg = ModelConfig(**config)
            self.params = Params(*(jnp.asarray(checkpoint["." + key]) for key in Params._fields))
            self.eye_cfg = EyeConfig(**meta["configs"]["eye"])

        self.graph, columns, self.count = load_graph(self.cfg)
        self.edge_count = len(edges)
        angles = column_angles(columns, self.eye_cfg.ommatidium_spacing_deg,
                               self.eye_cfg.binocular_overlap_deg)
        self.directions = jnp.asarray(np.radians(angles.to_numpy()), dtype=jnp.float32)
        self.column_count = len(columns)
        self.left_columns = jnp.asarray((columns["side"] == "L").to_numpy())
        self.iv = no_interventions(self.count)
        self.stimulation = None
        self.controls = {"blindLeft": False, "blindRight": False, "stimulate": None}
        self.step = jax.jit(make_step(self.graph, self.cfg, self.count))
        self.state = rest_state(self.params, self.graph, self.cfg, self.count)
        gray = jnp.full((2, self.column_count), 0.5)
        self.state, out = self.step(self.params, self.state, gray, self.iv, jax.random.PRNGKey(0))
        self.rest = np.asarray(out.rates)
        self.render = jax.jit(lambda patches: render(self.directions, patches, self.eye_cfg))
        self.tick = 0

    def retina(self, patches, controls=None):
        controls = controls or {}
        centers = np.zeros((16, 3), np.float32)
        centers[:, 2] = 1
        sizes = np.zeros((16, 2), np.float32)
        luminance = np.full(16, 0.5, np.float32)
        chroma = np.full(16, 0.5, np.float32)
        for i, patch in enumerate(patches[:16]):
            centers[i] = patch["center"]
            sizes[i] = patch["half_size"]
            luminance[i] = patch["luminance"]
            chroma[i] = patch["chroma"]
        center, half_size = jnp.asarray(centers), jnp.asarray(sizes)
        eyes = jnp.stack([
            self.render(Patches(center, half_size, jnp.asarray(luminance))),
            self.render(Patches(center, half_size, jnp.asarray(chroma))),
        ])
        covered = jnp.where(self.left_columns, bool(controls.get("blindLeft", False)),
                            bool(controls.get("blindRight", False)))
        return jnp.where(covered[None, :], 0.5, eyes)

    def advance(self, patches, controls=None):
        controls = controls or {}
        stimulus = controls.get("stimulate")
        stimulation = None if stimulus is None else (stimulus["index"], stimulus["current"])
        if stimulation != self.stimulation:
            opto = jnp.zeros(self.count)
            if stimulation is not None:
                opto = opto.at[stimulation[0]].set(stimulation[1])
            self.iv = self.iv._replace(opto=opto)
            self.stimulation = stimulation
        self.controls = {"blindLeft": bool(controls.get("blindLeft", False)),
                         "blindRight": bool(controls.get("blindRight", False)),
                         "stimulate": stimulus}
        eyes = self.retina(patches, controls)
        self.state, out = self.step(self.params, self.state, eyes, self.iv,
                                    jax.random.PRNGKey(self.tick))
        self.tick += 1
        change = np.asarray(out.rates) - self.rest
        values = np.clip(np.rint(change * (127 / 0.25)), -127, 127).astype(np.int8)
        return values


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


def main():
    brain = Brain()
    # Compile the eye pass before declaring the session ready.
    brain.advance([])
    emit({"event": "ready", "neurons": brain.count, "edges": brain.edge_count,
          "columns": brain.column_count, "neuronHash": brain.neuron_hash,
          "bodyIds": brain.neurons["body_id"].astype(int).tolist()})
    latest = {"patches": [], "controls": {}, "seq": -1, "received": 0.0}
    lock = threading.Lock()
    closed = threading.Event()

    def inputs():
        try:
            for line in sys.stdin:
                message = json.loads(line)
                with lock:
                    latest.update(patches=message["patches"], controls=message.get("controls", {}),
                                  seq=message.get("seq", -1), received=time.monotonic())
        finally:
            closed.set()

    threading.Thread(target=inputs, daemon=True).start()
    while not closed.is_set():
        started = time.monotonic()
        with lock:
            age = started - latest["received"]
            patches = latest["patches"] if age < VISUAL_TTL else []
            # Eye covers are persistent switches. Rendering delays must not
            # reopen an eye; only the held stimulation current has a short lease.
            controls = dict(latest["controls"])
            if age >= STIMULATION_TTL:
                controls["stimulate"] = None
            seq = latest["seq"]
        values = brain.advance(patches, controls)
        if brain.tick % 2 == 0:
            emit({"event": "activity", "step": brain.tick,
                  "controls": brain.controls, "inputSeq": seq,
                  "values": base64.b64encode(values.tobytes()).decode("ascii")})
        closed.wait(max(0, 1 / 30 - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
