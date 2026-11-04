#!/usr/bin/env python3
"""Build the brain-cloud asset for the webpage from the MaleCNS annotations table.

Input : data/body-annotations.feather (CC BY 4.0, MaleCNS v1.0)
Output: data/positions.bin  [uint32 N][N*3 float32 xyz][N uint8 regionId]
        data/regions.json   {"names": [...]}   // region 0..K-1

Positions are soma EM voxel coordinates, percentile-clipped, centered and
isotropically normalized to [-1, 1]. Regions are the dataset's own
`somaNeuromere` labels (top 16 by count, remainder = "other").
"""
import json

import numpy as np
import pyarrow.feather as pf

SRC = "data/body-annotations.feather"
OUT_BIN = "data/positions.bin"
OUT_META = "data/regions.json"
K_REGIONS = 14

t = pf.read_table(SRC, columns=["somaLocation"])
locs = t.column("somaLocation").to_pylist()

pts = [loc for loc in locs if loc is not None and len(loc) == 3]

xyz = np.asarray(pts, dtype=np.float64)
print(f"rows with soma: {len(xyz)} / {t.num_rows}")

# clip outliers per axis, center, normalize isotropically to [-1, 1]
lo, hi = np.percentile(xyz, [0.5, 99.5], axis=0)
xyz = np.clip(xyz, lo, hi)
xyz -= xyz.mean(axis=0)
xyz /= np.abs(xyz).max()
xyz[:, 0] *= -1  # arbitrary L/R flip so the cloud faces "left"

# k-means (Lloyd's, seeded) for balanced display regions; named by centroid
# axis signs only -- no anatomical claims.
rng = np.random.default_rng(7)
centers = xyz[rng.choice(len(xyz), K_REGIONS, replace=False)]
for _ in range(30):
    d = ((xyz[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
    assign = d.argmin(1)
    new = np.array([xyz[assign == k].mean(0) if (assign == k).any() else centers[k]
                    for k in range(K_REGIONS)])
    if np.allclose(new, centers):
        break
    centers = new
region_ids = assign.astype(np.uint8)

names = []
for k in range(K_REGIONS):
    c = centers[k]
    sx, sy, sz = ("+" if v >= 0 else "-" for v in c)
    names.append(f"x{sx} y{sy} z{sz} ·{k}")
order = np.argsort([-((region_ids == k).sum()) for k in range(K_REGIONS)])
remap = np.empty(K_REGIONS, dtype=np.uint8)
for new, old in enumerate(order):
    remap[old] = new
region_ids = remap[region_ids]
names = [names[old] for old in order]
print("regions:", {names[i]: int((region_ids == i).sum()) for i in range(K_REGIONS)})

blob = b"".join([
    np.array([len(xyz)], dtype="<u4").tobytes(),
    xyz.astype("<f4").tobytes(),
    region_ids.tobytes(),
])
with open(OUT_BIN, "wb") as f:
    f.write(blob)
with open(OUT_META, "w") as f:
    json.dump({"names": names}, f)
print(f"wrote {OUT_BIN} ({len(blob)/1e6:.1f} MB, {len(xyz)} points, {K_REGIONS} regions)")
