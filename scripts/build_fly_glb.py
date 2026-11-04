#!/usr/bin/env python3
"""Build public/fly.glb + public/fly-meta.json from the Thingiverse Drosophila STL
(thing:1511303 by benny369, CC BY-NC 3.0).

Keeps the biggest connected component (the fly; the two smaller ones are the
spherical print-cage), decimates, classifies triangles into body / eyes /
wingL / wingR, exports an indexed GLB with vertex colors plus a small JSON of
anchor points used to park the connectome in the head and flap the wings.
"""
import json
import os
from pathlib import Path
import sys

import numpy as np
import trimesh
import fast_simplification
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt

SRC = os.environ.get("FLY_SOURCE_STL", '/tmp/fly1511303/files/drosophila_final.stl')
OUT_DIR = str(Path(__file__).resolve().parents[1] / 'public')
TARGET_TRIS = 150_000

m = trimesh.load(SRC)
comps = sorted(m.split(only_watertight=False, repair=False), key=lambda c: -len(c.faces))
body = comps[0]
print('fly component tris:', len(body.faces))

v, f = fast_simplification.simplify(
    body.vertices.astype(np.float32), body.faces.astype(np.int64),
    target_reduction=1 - TARGET_TRIS / len(body.faces))
fly = trimesh.Trimesh(vertices=v, faces=f, process=False)
print('decimated to:', len(fly.faces))

c = fly.triangles_center

# ---- classify ----
# model axes: x = left/right, z runs head(555) -> wing tips(35), face looks -y.
# eyes: two lobes protruding -y from the head front (high z, lateral in x)
eye_seeds = np.array([[100.0, 205.0, 490.0], [230.0, 205.0, 490.0]])
d_eye = np.linalg.norm(c[:, None, :] - eye_seeds[None, :, :], axis=2)
in_eye_sphere = (d_eye[:, 0] < 78) | (d_eye[:, 1] < 78)
eye_mask = (c[:, 2] > 425) & (c[:, 2] < 545) & (c[:, 1] < 232) & in_eye_sphere & \
           (((np.abs(c[:, 0] - 100) < 72) & (c[:, 0] < 152)) |
            ((np.abs(c[:, 0] - 230) < 72) & (c[:, 0] > 178)))

# wings: large flat triangles away from the body axis, below the head
areas = fly.area_faces
big = areas > np.percentile(areas, 60)
wing_mask = big & (np.abs(c[:, 0] - 165) > 62) & (c[:, 2] < 430)
wingL = wing_mask & (c[:, 0] < 165)
wingR = wing_mask & (c[:, 0] > 165)

body_mask = ~(eye_mask | wing_mask)
c_body = c[body_mask]
body_idx = np.where(body_mask)[0]
head_idx = body_idx[np.linalg.norm(c_body - (165.0, 231.5, 481.1), axis=1) < 105]

# legs: the mesh legs are long thin structures outside the body column, on the
# ventral side, roughly z 330-530 and |x-165| > 40. The old area-based filter
# only caught stubs at the hips (read as 6 extra legs next to the 6 procedural
# ones). Head triangles are excluded so the face/chin is never cut.
leg_mask = (c_body[:, 2] > 325) & (np.abs(c_body[:, 0] - 165) > 42) & (c_body[:, 1] < 215)
head_mask_body = np.linalg.norm(c_body - (165.0, 231.5, 481.1), axis=1) < 105
leg_local = leg_mask & ~head_mask_body
leg_idx = body_idx[leg_local]
print('leg tris:', len(leg_idx))

# hip anchors: where the legs meet the thorax (per side)
attach = c_body[leg_local & (c_body[:, 2] > 360)]
hips = []
for side in (attach[:, 0] < 165, attach[:, 0] > 165):
    hips.append(attach[side].mean(0).round(1).tolist())
print('hips:', hips)

masks = [('body', np.setdiff1d(np.setdiff1d(body_idx, head_idx), leg_idx)),
         ('head', head_idx),
         ('eyes', np.where(eye_mask)[0]),
         ('wingL', np.where(wingL)[0]),
         ('wingR', np.where(wingR)[0])]
for name, idx in masks:
    print(name, len(idx))

COL = {
    'body': np.array([0.72, 0.55, 0.30]),
    'head': np.array([0.76, 0.58, 0.32]),
    'eyes': np.array([0.62, 0.10, 0.10]),
    'wingL': np.array([0.80, 0.88, 0.95]),
    'wingR': np.array([0.80, 0.88, 0.95]),
}

parts = {}
for name, idx in masks:
    sub = fly.submesh([idx], repair=False, only_watertight=False)[0]
    sub = sub.copy(); sub.remove_unreferenced_vertices()
    cols = np.tile(COL[name], (len(sub.vertices), 1))
    sub.visual.vertex_colors = (cols * 255).astype(np.uint8)
    sub.vertex_normals  # force smooth normal computation before export
    parts[name] = sub
    print(name, '->', len(sub.faces), 'tris,', len(sub.vertices), 'verts')

# ---- meta ----
ev = parts['eyes'].vertices
eye_ctr = ev.mean(0)
head_ctr = eye_ctr + np.array([0.0, 22.0, -6.0])   # behind the eye caps
# brain capsule: ellipsoid about head_ctr fitted to head+eyes triangles in the
# capsule's own principal frame (the head sits tilted on the thorax, so a
# model-axis-aligned box leaks out at the back of the head). meta gets the
# basis rows (headAxes) plus per-axis radii (p2/p98 extents, min-direction).
capsule_v = np.vstack([parts['head'].vertices, ev])
d = capsule_v - head_ctr
w, V = np.linalg.eigh(np.cov(d.T))
V = V[:, np.argsort(w)[::-1]]        # columns = principal axes, longest first
u = d @ V
head_radii = []
for k in range(3):
    lo, hi = np.percentile(u[:, k], [2, 98])
    head_radii.append([round(hi), round(-lo)])   # [+dir, -dir] per axis
meta = {
    'headCenter': head_ctr.round(1).tolist(),
    'headRadii': head_radii,
    'headAxes': [[round(x, 4) for x in row] for row in V.T],
    'eyeCenters': [ev[ev[:, 0] < 165].mean(0).round(1).tolist(),
                   ev[ev[:, 0] > 165].mean(0).round(1).tolist()],
    'wingPivotL': [105.0, 245.0, 395.0],
    'wingPivotR': [225.0, 245.0, 395.0],
    'hips': hips,
    'bounds': [fly.bounds[0].round(1).tolist(), fly.bounds[1].round(1).tolist()],
    'source': 'Thingiverse thing:1511303 by benny369, CC BY-NC 3.0',
}

# ---- preview ----
rng = np.random.default_rng(3)
fig, axes = plt.subplots(1, 3, figsize=(18, 6))
pc = {'body': 'tan', 'head': 'orange', 'eyes': 'red', 'wingL': 'skyblue', 'wingR': 'royalblue'}
for ax, (i, j, lbl) in zip(axes, [(0, 1, 'XY'), (0, 2, 'XZ'), (1, 2, 'YZ')]):
    for name, sub in parts.items():
        vv = sub.vertices[sub.faces].reshape(-1, 3)
        idx = rng.choice(len(vv), min(25000, len(vv)), replace=False)
        ax.scatter(vv[idx, i], vv[idx, j], s=0.3, c=pc[name])
    lv = fly.vertices[fly.faces[leg_idx]].reshape(-1, 3)
    li = rng.choice(len(lv), min(25000, len(lv)), replace=False)
    ax.scatter(lv[li, i], lv[li, j], s=0.4, c='lime')
    ax.scatter([head_ctr[i]], [head_ctr[j]], c='green', s=120, marker='*')
    ax.set_aspect('equal'); ax.set_title(lbl); ax.grid(alpha=.3)
plt.tight_layout(); plt.savefig('/tmp/fly_classified.png', dpi=85)
print('preview saved')

# ---- export ----
scene = trimesh.Scene()
for name, sub in parts.items():
    scene.add_geometry(sub, node_name=name, geom_name=name)
glb_path = os.path.join(OUT_DIR, 'fly.glb')
scene.export(glb_path)
meta_path = os.path.join(OUT_DIR, 'fly-meta.json')
with open(meta_path, 'w') as fh:
    json.dump(meta, fh)
print('exported', glb_path, os.path.getsize(glb_path), 'bytes')
print('meta:', json.dumps(meta))
