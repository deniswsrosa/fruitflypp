#!/usr/bin/env python3
"""Fit cranial neuron coordinates inside the CT head, behind the eyes.

Maximize a uniform scale and translation without distorting the neuron cloud.
The hull is contracted by 10% first to leave clearance beneath the exoskeleton.
Ascending neurons have nerve-cord somata and must not constrain the head fit.
All coordinates, including those nerve-cord neurons, retain the same transform.
Run after changing the brain export or fly mesh.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linprog
from scipy.spatial import ConvexHull
from scipy.spatial.transform import Rotation
import trimesh

ROOT = Path(__file__).resolve().parents[1]
ROTATION = [3.53, 0.119, 0]
CLEARANCE = 0.10


def fit():
    source = ROOT / "public/brain/neurons.json"
    asset = json.loads(source.read_text())
    points = np.array(asset["position_um"]).reshape(-1, 3)
    lo, hi = (np.array(asset["bounds_um"][key]) for key in ["min", "max"])
    points = (points - (lo + hi) / 2) * 2 / max(hi - lo)
    points[:, 0] *= -1
    # Three.js Euler XYZ is an intrinsic rotation (uppercase XYZ in scipy).
    points = points @ Rotation.from_euler("XYZ", ROTATION).as_matrix().T
    head_mask = np.array([
        asset["superclasses"][code] != "ascending_neuron" for code in asset["superclass"]
    ])
    source_center = points[head_mask].mean(axis=0)
    points -= source_center
    cranial = points[head_mask]

    mesh_path = ROOT / "public/fly.glb"
    mesh = trimesh.load(mesh_path)
    vertices = np.vstack([mesh.geometry[name].vertices for name in ["head", "eyes"]])
    hull = ConvexHull(vertices)
    normals, offsets = hull.equations[:, :3], hull.equations[:, 3]
    center = vertices[hull.vertices].mean(axis=0)
    support = np.concatenate([
        (cranial @ normals[i:i + 64].T).max(axis=0) for i in range(0, len(normals), 64)
    ])
    limits = -offsets - CLEARANCE * -(normals @ center + offsets)
    # Keep the cranial center behind the retina-facing eye caps (head +z is front).
    max_center_z = float(mesh.geometry["eyes"].vertices[:, 2].mean() - 0.12)
    constraints = np.vstack([np.column_stack([support, normals]), [0, 0, 0, 1]])
    result = linprog([-1, 0, 0, 0], A_ub=constraints,
                     b_ub=np.append(limits, max_center_z),
                     bounds=[(0, None)] + [(None, None)] * 3,
                     method="highs")
    if not result.success:
        raise RuntimeError(result.message)
    scale, *translation = result.x
    fitted = cranial * scale + translation
    # Verify against the actual uncontracted hull, independently of LP tolerances.
    max_distance = max((fitted @ n + d).max() for n, d in zip(normals, offsets))
    if max_distance > 1e-7:
        raise RuntimeError(f"Brain extends outside head envelope: {max_distance}")
    output = {
        "neuronCount": asset["n_neurons"],
        "assetSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "meshSha256": hashlib.sha256(mesh_path.read_bytes()).hexdigest(),
        "rotation": ROTATION, "scale": float(scale), "center": translation,
        "sourceCenter": source_center.tolist(), "maxCenterZ": max_center_z,
        "headNeuronCount": int(head_mask.sum()),
        "bodyNeuronCount": int((~head_mask).sum()),
        "excludedSuperclasses": ["ascending_neuron"],
        "clearance": CLEARANCE,
    }
    (ROOT / "public/brain/head-fit.json").write_text(json.dumps(output, indent=2) + "\n")
    print(f"Fitted {len(cranial)} cranial neurons: scale={scale:.6f}, center={translation}")
    print(f"Preserved {(~head_mask).sum()} nerve-cord neurons outside the head constraint")
    print(f"Maximum signed distance from head envelope: {max_distance:.6f}")


if __name__ == "__main__":
    fit()
