import * as THREE from 'three';

function subsetGeometry(source, faces) {
  const ids = [], lookup = new Map(), index = [];
  for (const face of faces) for (let k = 0; k < 3; k++) {
    const old = source.index ? source.index.getX(face * 3 + k) : face * 3 + k;
    if (!lookup.has(old)) { lookup.set(old, ids.length); ids.push(old); }
    index.push(lookup.get(old));
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = new Float32Array(ids.length * attribute.itemSize);
    ids.forEach((old, i) => {
      for (let k = 0; k < attribute.itemSize; k++) values[i * attribute.itemSize + k] = attribute.getComponent(old, k);
    });
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  geometry.setIndex(index);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function rigFrontLegs(body, rig) {
  const source = body.geometry;
  const faceCount = (source.index?.count ?? source.attributes.position.count) / 3;
  if (faceCount !== rig.sourceFaceCount || source.attributes.position.count !== rig.sourceVertexCount)
    throw new Error('Foreleg rig does not match fly.glb; run scripts/rig_forelegs.py');
  const removed = new Set(), legs = [];
  for (const part of rig.legs) {
    for (const face of part.faces) {
      if (removed.has(face)) throw new Error('Overlapping foreleg masks');
      removed.add(face);
    }
    const geometry = subsetGeometry(source, part.faces);
    const joints = part.joints.map(p => new THREE.Vector3(...p));
    const lengths = joints.slice(1).map((p, i) => p.distanceTo(joints[i]));
    const skinIndex = new Uint16Array(geometry.attributes.position.count * 4);
    const skinWeight = new Float32Array(geometry.attributes.position.count * 4);
    const p = new THREE.Vector3(), closest = new THREE.Vector3();
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      p.fromBufferAttribute(geometry.attributes.position, i);
      let segment = 0, fraction = 0, best = Infinity;
      for (let k = 0; k < 3; k++) {
        const direction = joints[k + 1].clone().sub(joints[k]);
        const t = THREE.MathUtils.clamp(p.clone().sub(joints[k]).dot(direction) / direction.lengthSq(), 0, 1);
        closest.copy(joints[k]).addScaledVector(direction, t);
        const distance = closest.distanceToSquared(p);
        if (distance < best) { best = distance; segment = k; fraction = t; }
      }
      let a = segment, b = segment, mix = 0;
      if (fraction > 0.8 && segment < 2) { b++; mix = (fraction - 0.8) / 0.2 * 0.5; }
      else if (fraction < 0.2 && segment > 0) { a--; mix = 0.5 + fraction / 0.2 * 0.5; }
      skinIndex[i * 4] = a; skinIndex[i * 4 + 1] = b;
      skinWeight[i * 4] = 1 - mix; skinWeight[i * 4 + 1] = mix;
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    const mesh = new THREE.SkinnedMesh(geometry, body.material);
    mesh.name = `front-leg-${part.name}`;
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion); mesh.scale.copy(body.scale);
    mesh.renderOrder = body.renderOrder; mesh.frustumCulled = false;
    const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
    bones.forEach((bone, i) => {
      bone.name = `${part.name}-${['hip', 'knee', 'ankle'][i]}`;
      bone.position.copy(i === 0 ? joints[0] : joints[i].clone().sub(joints[i - 1]));
      if (i) bones[i - 1].add(bone); else mesh.add(bone);
    });
    body.parent.add(mesh);
    mesh.bind(new THREE.Skeleton(bones));
    legs.push({ mesh, bones, joints, lengths, side: part.side, tapT: -Infinity,
      target: null, lastContact: null, contacts: 0 });
  }
  const keep = [];
  for (let face = 0; face < faceCount; face++) if (!removed.has(face)) keep.push(face);
  const remaining = subsetGeometry(source, keep);
  body.geometry = remaining;
  if (keep.length + legs.reduce((n, leg) => n + leg.mesh.geometry.index.count / 3, 0) !== faceCount)
    throw new Error('Foreleg partition changed the source triangle count');
  return legs;
}

function solve(leg, target) {
  const points = leg.joints.map(p => p.clone()), root = points[0].clone();
  const reach = leg.lengths.reduce((a, b) => a + b, 0);
  const goal = target.clone();
  if (goal.distanceTo(root) > reach * 0.99) goal.sub(root).setLength(reach * 0.99).add(root);
  // Three-link FABRIK keeps the original limb lengths while reaching the key.
  for (let iteration = 0; iteration < 8; iteration++) {
    points[3].copy(goal);
    for (let i = 2; i >= 0; i--)
      points[i].sub(points[i + 1]).setLength(leg.lengths[i]).add(points[i + 1]);
    points[0].copy(root);
    for (let i = 1; i < 4; i++)
      points[i].sub(points[i - 1]).setLength(leg.lengths[i - 1]).add(points[i - 1]);
  }
  const parentRotation = new THREE.Quaternion();
  for (let i = 0; i < 3; i++) {
    const rest = leg.joints[i + 1].clone().sub(leg.joints[i]).normalize();
    const desired = points[i + 1].clone().sub(points[i]).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(rest, desired);
    leg.bones[i].quaternion.copy(parentRotation.clone().invert().multiply(rotation));
    parentRotation.copy(rotation);
  }
  return points[3];
}

export function tapNearestLeg(legs, key, now) {
  if (!legs.length || !key) return;
  for (const leg of legs) leg.grooming = null;
  const world = key.localToWorld(new THREE.Vector3(0, key.geometry.parameters.height / 2, 0));
  let closest = null, distance = Infinity;
  for (const leg of legs) {
    const root = leg.mesh.localToWorld(leg.joints[0].clone());
    const d = root.distanceToSquared(world);
    if (d < distance) { distance = d; closest = leg; }
  }
  closest.tapT = now + 15;
  closest.lastFrame = closest.tapT;
  closest.elapsed = 0; closest.phase = 0; closest.active = true;
  closest.counted = false; closest.key = key;
  closest.target = world;
  return closest;
}

export function startGrooming(legs, now) {
  if (legs.length !== 2) return;
  const center = legs[0].joints[0].clone().add(legs[1].joints[0]).multiplyScalar(0.5);
  center.add(new THREE.Vector3(0, -0.20, 0.36));
  for (const leg of legs) {
    leg.active = false;
    leg.grooming = { center: center.clone(), elapsed: 0, lastFrame: now, phase: 0 };
  }
}

export function updateTypingLegs(legs, now) {
  for (const leg of legs) {
    const groom = leg.grooming;
    if (groom) {
      groom.elapsed += Math.min((now - groom.lastFrame) / 1000, 0.12);
      groom.lastFrame = now;
      const phase = groom.phase = Math.min(1, groom.elapsed / 1.7);
      if (phase >= 1) {
        leg.grooming = null;
        leg.bones.forEach(b => b.quaternion.identity());
        continue;
      }
      const blend = phase < 0.2 ? THREE.MathUtils.smoothstep(phase, 0, 0.2)
        : phase > 0.8 ? 1 - THREE.MathUtils.smoothstep(phase, 0.8, 1) : 1;
      const stroke = Math.sin((phase - 0.2) / 0.6 * Math.PI * 10) * blend;
      const contact = groom.center.clone().add(new THREE.Vector3(leg.side * 0.012,
        leg.side * stroke * 0.025, leg.side * stroke * 0.012));
      solve(leg, leg.joints[3].clone().lerp(contact, blend));
      continue;
    }
    if (!leg.active || !leg.target || now < leg.tapT) continue;
    // Keep a visible contact pose even when rendering is slower than real time.
    leg.elapsed += Math.min((now - leg.lastFrame) / 1000, 0.12);
    leg.lastFrame = now;
    const age = leg.phase = Math.min(1, leg.elapsed / 0.22);
    if (age >= 1) {
      leg.active = false;
      leg.bones.forEach(b => b.quaternion.identity());
      continue;
    }
    leg.mesh.updateWorldMatrix(true, false);
    const target = leg.mesh.worldToLocal(leg.target.clone());
    const amount = age < 0.4 ? Math.sin(age / 0.4 * Math.PI / 2)
      : age <= 0.65 ? 1 : Math.cos((age - 0.65) / 0.35 * Math.PI / 2);
    const goal = leg.joints[3].clone().lerp(target, amount);
    goal.y += Math.sin(age * Math.PI * 2) * 0.012;
    const toe = solve(leg, goal);
    if (age >= 0.4 && age <= 0.75) {
      leg.lastContact = leg.mesh.localToWorld(toe.clone()).toArray();
      if (!leg.counted) { leg.contacts++; leg.counted = true; }
    } else if (age < 0.45) leg.counted = false;
  }
}
