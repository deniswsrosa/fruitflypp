#!/usr/bin/env python3
"""Build public/fly.glb + public/fly-meta.json from the CT-scan Drosophila GLB
(thing:5667511 style Sketchfab export, 15 unnamed chunks, walking pose).

Bakes the walking pose upright (head -> +z toward camera, dorsal -> +y),
decimates, classifies triangles into body / head / eyes / wingL / wingR, cuts
the legs (main.js rebuilds six procedural ones that type), and exports an
indexed GLB with vertex colors plus the anchor meta used to park the
connectome, flap-fold the wings, and attach the legs.
"""
import json
import os
from pathlib import Path

import numpy as np
import trimesh
import fast_simplification
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt

SRC = os.environ.get("FLY_SOURCE_GLB", str(Path.home() / 'Downloads/drosophila_-_adult_fruit_fly_-_ct_scan.glb'))
OUT_DIR = str(Path(__file__).resolve().parents[1] / 'public')
TARGET_TRIS = 120_000

m = trimesh.load(SRC, force='scene')
body = trimesh.util.concatenate(list(m.geometry.values()))
print('chunks merged:', len(body.faces), 'tris')

# bake upright: model (x, y_ant-post, z_up) -> (x, z_up, -y) so the head faces
# +z (camera) and the dorsal side is +y
v = body.vertices.copy()
body.vertices = np.column_stack([v[:, 0], v[:, 2], -v[:, 1]])
body.fix_normals()

v, f = fast_simplification.simplify(
    body.vertices.astype(np.float32), body.faces.astype(np.int64),
    target_reduction=1 - TARGET_TRIS / len(body.faces))
fly = trimesh.Trimesh(vertices=v, faces=f, process=False)
fly.fix_normals()
print('decimated to:', len(fly.faces))

c = fly.triangles_center
areas = fly.area_faces

# ---- classify (baked coords: head +z, dorsal +y, x lateral) ----
# regions from the side profile: head z 0.3..0.75 / y 0.55..1.1, eyes at
# (+-0.22, 0.85, 0.55), wings paddles y 0.8..1.3 / z -1.3..0, legs splay
# y 0..0.5 / z -0.4..0.2 with |x| > 0.1, antennae z > 0.6 (kept, on the head)
hc = np.array([0.0, 0.80, 0.50])
head_ell = ((c[:, 0] - hc[0]) / 0.33) ** 2 + ((c[:, 1] - hc[1]) / 0.32) ** 2 + ((c[:, 2] - hc[2]) / 0.30) ** 2
head_mask = head_ell < 1.0

eye_seeds = None
eye_mask = head_mask & (c[:, 2] > 0.50) & (c[:, 1] > 0.68) & (np.abs(c[:, 0]) > 0.02)

big = areas > np.percentile(areas, 60)
wing_mask = big & (c[:, 1] > 0.78) & (c[:, 2] < 0.0) & (np.abs(c[:, 0]) > 0.08)
wingL = wing_mask & (c[:, 0] < 0)
wingR = wing_mask & (c[:, 0] > 0)

# legs: kept on the mesh now (the procedural stick legs were removed — they
# read as awkward next to the real anatomy). leg_mask is only computed to
# derive the hip anchors for meta.
leg_mask = ((c[:, 1] < 0.56) & (c[:, 2] > -0.45) & (c[:, 2] < 0.22) & (np.abs(c[:, 0]) > 0.05)
            & ~head_mask & ~eye_mask & ~wing_mask)

leg_idx = np.where(leg_mask)[0]
print('leg tris (kept):', len(leg_idx))

# hip anchors: cut triangles near the root (close to the body axis, high up)
attach = c[leg_mask & (c[:, 1] > 0.28) & (np.abs(c[:, 0]) < 0.35) & (c[:, 2] > -0.2)]
hips = []
for side in (attach[:, 0] < 0, attach[:, 0] > 0):
    hips.append(attach[side].mean(0).round(3).tolist())
print('hips:', hips)

# wing pivots: average the wing's front edge (nearest the thorax)
pivots = []
for w in (wingL, wingR):
    pts = c[w]
    root = pts[pts[:, 2] > np.percentile(pts[:, 2], 85)] if len(pts) else np.zeros((1, 3))
    pivots.append(root.mean(0).round(3).tolist())

head_idx = np.where(head_mask & ~eye_mask & ~wing_mask)[0]
body_idx = np.where(~head_mask & ~eye_mask & ~wing_mask)[0]

masks = [('body', body_idx), ('head', head_idx), ('eyes', np.where(eye_mask)[0]),
         ('wingL', np.where(wingL)[0]), ('wingR', np.where(wingR)[0])]
for name, idx in masks:
    print(name, len(idx))

COL = {
    'body': np.array([0.66, 0.56, 0.40]),
    'head': np.array([0.70, 0.58, 0.38]),
    'eyes': np.array([0.42, 0.11, 0.07]),
    'wingL': np.array([0.80, 0.88, 0.95]),
    'wingR': np.array([0.80, 0.88, 0.95]),
}

parts = {}
for name, idx in masks:
    sub = fly.submesh([idx], repair=False, only_watertight=False)[0]
    sub = sub.copy(); sub.remove_unreferenced_vertices()
    cols = np.tile(COL[name], (len(sub.vertices), 1))
    sub.visual.vertex_colors = (cols * 255).astype(np.uint8)
    sub.vertex_normals  # smooth normals before export
    parts[name] = sub
    print(name, '->', len(sub.faces), 'tris,', len(sub.vertices), 'verts')

# ---- meta ----
ev = parts['eyes'].vertices
eye_ctr = ev.mean(0)
head_ctr = eye_ctr + np.array([0.0, 0.02, 0.02])   # between/just behind the eye caps
capsule_v = np.vstack([parts['head'].vertices, ev])
d = capsule_v - head_ctr
w, V = np.linalg.eigh(np.cov(d.T))
V = V[:, np.argsort(w)[::-1]]
u = d @ V
head_radii = []
for k in range(3):
    lo, hi = np.percentile(u[:, k], [2, 98])
    head_radii.append([round(float(hi), 4), round(float(-lo), 4)])
meta = {
    'headCenter': head_ctr.round(4).tolist(),
    'headRadii': head_radii,
    'headAxes': [[round(x, 5) for x in row] for row in V.T],
    'eyeCenters': [ev[ev[:, 0] < 0].mean(0).round(3).tolist(),
                   ev[ev[:, 0] > 0].mean(0).round(3).tolist()],
    'wingPivotL': pivots[0],
    'wingPivotR': pivots[1],
    'hips': hips,
    'bounds': [fly.bounds[0].round(3).tolist(), fly.bounds[1].round(3).tolist()],
    'source': 'Drosophila adult fruit fly CT scan (Sketchfab, thing:5667511)',
}

# ---- preview ----
rng = np.random.default_rng(3)
fig, axes = plt.subplots(1, 3, figsize=(18, 6))
pc = {'body': 'tan', 'head': 'orange', 'eyes': 'red', 'wingL': 'skyblue', 'wingR': 'royalblue'}
for ax, (i, j, lbl) in zip(axes, [(0, 1, 'XY (front view)'), (0, 2, 'XZ (top)'), (1, 2, 'YZ (side)')]):
    for name, sub in parts.items():
        vv = sub.vertices[sub.faces].reshape(-1, 3)
        idx = rng.choice(len(vv), min(25000, len(vv)), replace=False)
        ax.scatter(vv[idx, i], vv[idx, j], s=0.3, c=pc[name])
    ax.scatter([head_ctr[i]], [head_ctr[j]], c='green', s=120, marker='*')
    ax.set_aspect('equal'); ax.set_title(lbl); ax.grid(alpha=.3)
plt.tight_layout(); plt.savefig('/tmp/fly_ct_classified.png', dpi=85)
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
