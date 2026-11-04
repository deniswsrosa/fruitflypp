#!/usr/bin/env python3
"""Mark the CT mesh's two forelegs for runtime skinning; preserve every triangle."""
import json
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]


def main():
    mesh = trimesh.load(ROOT / "public/fly.glb").geometry["body"]
    centers = mesh.triangles_center
    legs = []
    for side, name, joints in [
        (-1, "left", [[-.17, .535, .24], [-.34, .52, .535], [-.235, .23, .67], [-.12, .025, .77]]),
        (1, "right", [[.095, .53, .24], [.23, .515, .50], [.13, .23, .65], [.045, .025, .77]]),
    ]:
        lateral = centers[:, 0] < -.11 if side < 0 else centers[:, 0] > .015
        mask = (centers[:, 2] > .235) & (centers[:, 1] < .565) & lateral
        faces = np.flatnonzero(mask).tolist()
        legs.append({"name": name, "side": side, "joints": joints, "faces": faces})
    data = {"sourceVertexCount": len(mesh.vertices), "sourceFaceCount": len(mesh.faces), "legs": legs}
    (ROOT / "public/foreleg-rig.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print({leg["name"]: len(leg["faces"]) for leg in legs})


if __name__ == "__main__":
    main()
