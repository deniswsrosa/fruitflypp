import * as THREE from 'three';

const $ = s => document.querySelector(s);
const TARGET_HOME = [0.60, 0.12, 1.45];

export class BrainInteractions {
  constructor({ scene, camera, renderer, controls, pipCam, pipRenderer, pipControls,
    getBrain, isReady, onChange }) {
    Object.assign(this, { scene, camera, renderer, controls, pipCam, pipRenderer,
      pipControls, getBrain, isReady, onChange });
    this.selected = null;
    this.stimulus = null;
    this.blindLeft = this.blindRight = false;
    this.color = 'red';
    this.applied = null;
    this.inputSeq = -1;
    this.markers = [];
    this.target = new THREE.Mesh(new THREE.CircleGeometry(0.12, 48),
      new THREE.MeshBasicMaterial({ color: 0xff593d, side: THREE.DoubleSide }));
    this.target.name = 'sensory-target';
    this.target.position.set(...TARGET_HOME);
    this.target.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.target.geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff })));
    const cross = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.04, 0, 0.002), new THREE.Vector3(0.04, 0, 0.002),
      new THREE.Vector3(0, -0.04, 0.002), new THREE.Vector3(0, 0.04, 0.002),
    ]);
    this.target.add(new THREE.LineSegments(cross, new THREE.LineBasicMaterial({ color: 0xffffff })));
    scene.add(this.target);
    this.ray = new THREE.Raycaster();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -TARGET_HOME[2]);
    this.installCanvas(renderer.domElement, camera, controls, false);
    this.installCanvas(pipRenderer.domElement, pipCam, pipControls, true);
    $('#target-enabled').addEventListener('change', () => {
      this.target.visible = $('#target-enabled').checked;
      this.onChange(true);
    });
    document.querySelectorAll('[data-target-color]').forEach(button => {
      button.addEventListener('click', () => {
        this.color = button.dataset.targetColor;
        this.target.material.color.setHex(this.color === 'red' ? 0xff593d : 0x4285ff);
        document.querySelectorAll('[data-target-color]').forEach(b =>
          b.setAttribute('aria-pressed', String(b === button)));
        this.onChange(true);
      });
    });
    for (const side of ['left', 'right']) {
      $(`#cover-${side}`).addEventListener('click', () => {
        const field = side === 'left' ? 'blindLeft' : 'blindRight';
        this[field] = !this[field];
        this.updateEyeButtons();
        this.onChange(true);
      });
    }
    const stimulate = $('#stimulate-neuron');
    stimulate.addEventListener('pointerdown', e => {
      if (stimulate.disabled || e.button !== 0) return;
      e.preventDefault();
      stimulate.setPointerCapture(e.pointerId);
      this.beginStimulation();
    });
    stimulate.addEventListener('keydown', e => {
      if ([' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        if (!e.repeat) this.beginStimulation();
      }
    });
    stimulate.addEventListener('keyup', e => {
      if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); this.endStimulation(); }
    });
    $('#stimulus-strength').addEventListener('input', () => {
      if (this.stimulus) {
        this.stimulus = { ...this.stimulus, current: +$('#stimulus-strength').value };
        this.onChange(true);
      }
    });
    $('#reset-brain').addEventListener('click', () => this.reset());
    // Releasing outside the canvas, tab changes and focus loss all release current.
    window.addEventListener('pointerup', () => this.releaseGesture());
    window.addEventListener('pointercancel', () => this.releaseGesture());
    window.addEventListener('blur', () => this.releaseGesture());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseGesture();
    });
  }

  installCanvas(canvas, camera, orbit, pip) {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', pip
      ? 'Brain: click a neuron to select, hold to stimulate. Arrow keys select neurons; Space stimulates.'
      : 'Fly and colored target: drag the target or use arrow keys to move it.');
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.releaseGesture();
      if (!pip && this.target.visible && this.hitTarget(e)) {
        e.preventDefault(); e.stopImmediatePropagation();
        orbit.enabled = false;
        canvas.setPointerCapture(e.pointerId);
        this.dragPlane.setFromNormalAndCoplanarPoint(
          this.camera.getWorldDirection(new THREE.Vector3()), this.target.position);
        this.gesture = { target: true, orbit, canvas, pointerId: e.pointerId };
        this.moveTarget(e);
        canvas.style.cursor = 'grabbing';
        return;
      }
      const index = this.pickNeuron(e.clientX, e.clientY, canvas, camera, pip);
      if (index === null) return;
      const gesture = this.gesture = { index, x: e.clientX, y: e.clientY,
        orbit, canvas, pointerId: e.pointerId, moved: false };
      gesture.timer = setTimeout(() => {
        if (this.gesture !== gesture || gesture.moved) return;
        this.select(index);
        if (this.isReady()) { orbit.enabled = false; this.beginStimulation(); }
      }, 320);
    }, true);
    canvas.addEventListener('pointermove', e => {
      const g = this.gesture;
      if (!g || g.canvas !== canvas || g.pointerId !== e.pointerId) return;
      if (g.target) {
        e.preventDefault(); e.stopImmediatePropagation(); this.moveTarget(e);
      } else if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) {
        g.moved = true; clearTimeout(g.timer); this.endStimulation();
      }
    }, true);
    canvas.addEventListener('pointerup', e => {
      const g = this.gesture;
      if (!g || g.canvas !== canvas) return;
      if (g.target) { e.preventDefault(); e.stopImmediatePropagation(); }
      else if (!g.moved) this.select(g.index);
      this.releaseGesture();
    }, true);
    canvas.addEventListener('lostpointercapture', () => this.releaseGesture());
    canvas.addEventListener('keydown', e => {
      if ([' ', 'Enter'].includes(e.key) && pip) {
        e.preventDefault(); if (!e.repeat) this.beginStimulation();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (pip) {
          const n = this.getBrain().positions?.length / 3;
          if (n) this.select(((this.selected ?? 0) +
            (['ArrowLeft', 'ArrowDown'].includes(e.key) ? -1 : 1) + n) % n);
        } else {
          this.target.position.x += e.key === 'ArrowRight' ? 0.08 : e.key === 'ArrowLeft' ? -0.08 : 0;
          this.target.position.y += e.key === 'ArrowUp' ? 0.08 : e.key === 'ArrowDown' ? -0.08 : 0;
          this.clampTarget(); this.onChange(true);
        }
      }
    });
    canvas.addEventListener('keyup', e => {
      if (pip && [' ', 'Enter'].includes(e.key)) { e.preventDefault(); this.endStimulation(); }
    });
  }

  hitTarget(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1,
      y: 1 - (e.clientY - r.top) / r.height * 2 }, this.camera);
    return this.ray.intersectObject(this.target, false).length > 0;
  }

  moveTarget(e) {
    this.hitTarget(e); // refresh the ray even when dragged outside the target
    const p = this.ray.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
    if (!p) return;
    this.target.position.copy(p);
    this.clampTarget();
    this.onChange(false);
  }

  setVisualFrame(origin, forward, right, up) {
    const first = !this.visualFrame;
    this.visualFrame = { origin: origin.clone(), forward: forward.clone(), right: right.clone(), up: up.clone() };
    if (first) this.clampTarget();
  }

  clampTarget() {
    if (this.visualFrame) {
      const { origin, forward, right, up } = this.visualFrame;
      const delta = this.target.position.clone().sub(origin);
      // Keep the target in front of the model's eyes, rather than silently
      // dragging it behind the downward-facing view of the keyboard.
      const x = THREE.MathUtils.clamp(delta.dot(right), -1.1, 1.1);
      const y = THREE.MathUtils.clamp(delta.dot(up), -0.45, 0.85);
      const z = THREE.MathUtils.clamp(delta.dot(forward), 0.3, 1.1);
      this.target.position.copy(origin).addScaledVector(right, x)
        .addScaledVector(up, y).addScaledVector(forward, z);
      this.target.updateMatrixWorld();
      return;
    }
    this.target.position.x = THREE.MathUtils.clamp(this.target.position.x, -1.25, 1.25);
    this.target.position.y = THREE.MathUtils.clamp(this.target.position.y, -0.3, 1.05);
  }

  pickNeuron(x, y, canvas, camera, pip) {
    const b = this.getBrain(), cloud = pip ? b.cloudSketch : b.cloudPts;
    if (!cloud || !b.positions) return null;
    cloud.updateWorldMatrix(true, false);
    const r = canvas.getBoundingClientRect(), p = new THREE.Vector3();
    let index = null, best = 8 * 8;
    for (let i = 0; i < b.positions.length; i += 3) {
      p.fromArray(b.positions, i).applyMatrix4(cloud.matrixWorld).project(camera);
      if (p.z < -1 || p.z > 1) continue;
      const dx = r.left + (p.x + 1) / 2 * r.width - x;
      const dy = r.top + (1 - p.y) / 2 * r.height - y;
      if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; index = i / 3; }
    }
    return index;
  }

  attachBrainViews() {
    const b = this.getBrain();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const material = new THREE.PointsMaterial({ color: 0xffc04a, size: 8,
      sizeAttenuation: false, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    for (const [parent, layer] of [[b.cloudGroup, 0], [b.brainSpace, 1]]) {
      const point = new THREE.Points(geo, material);
      point.name = 'selected-neuron'; point.layers.set(layer);
      point.renderOrder = 5; point.visible = false; point.frustumCulled = false;
      parent.add(point); this.markers.push(point);
    }
  }

  select(index) {
    if (index !== this.selected) this.endStimulation();
    this.selected = index;
    const b = this.getBrain();
    for (const marker of this.markers) {
      marker.geometry.attributes.position.setXYZ(0, ...b.positions.subarray(index * 3, index * 3 + 3));
      marker.geometry.attributes.position.needsUpdate = true;
      marker.visible = true;
    }
    const a = b.asset;
    $('#neuron-detail').textContent = `${a.cell_types[a.type[index]]} · ${a.roles[a.role[index]]} · body ${a.body_id[index]}`;
    this.updateFeedback();
  }

  beginStimulation() {
    if (this.selected === null || !this.isReady()) return;
    this.stimulus = { index: this.selected, current: +$('#stimulus-strength').value };
    this.updateFeedback(); this.onChange(true);
  }

  endStimulation() {
    if (!this.stimulus) return;
    this.stimulus = null;
    this.updateFeedback(); this.onChange(true);
  }

  releaseGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (g) {
      clearTimeout(g.timer); g.orbit.enabled = true; g.canvas.style.cursor = '';
      if (g.target && g.canvas.hasPointerCapture(g.pointerId)) g.canvas.releasePointerCapture(g.pointerId);
    }
    this.endStimulation();
  }

  updateEyeButtons() {
    for (const [side, covered] of [['left', this.blindLeft], ['right', this.blindRight]]) {
      const button = $(`#cover-${side}`);
      button.setAttribute('aria-pressed', String(covered));
      button.textContent = covered ? `uncover ${side} eye` : `cover ${side} eye`;
    }
  }

  updateFeedback(applied = this.applied, inputSeq = this.inputSeq) {
    this.applied = applied; this.inputSeq = inputSeq;
    const button = $('#stimulate-neuron');
    button.disabled = this.selected === null || !this.isReady();
    button.setAttribute('aria-pressed', String(!!this.stimulus));
    const parts = [];
    if (!this.isReady()) parts.push('Start the demo to try the experiments.');
    else {
      parts.push('Model running');
      if (applied?.blindLeft) parts.push('left eye covered');
      if (applied?.blindRight) parts.push('right eye covered');
      if (applied?.stimulate) parts.push(this.stimulus ? 'stimulating selected neuron' : 'releasing stimulation…');
      else if (this.stimulus) parts.push('applying stimulation…');
    }
    const text = parts.join(' · ');
    if ($('#brain-feedback').textContent !== text) $('#brain-feedback').textContent = text;
  }

  reset() {
    this.releaseGesture(); this.blindLeft = this.blindRight = false;
    this.selected = null; this.applied = null;
    this.markers.forEach(m => { m.visible = false; });
    this.target.position.set(...TARGET_HOME); this.clampTarget(); this.color = 'red';
    this.target.material.color.setHex(0xff593d); this.target.visible = true;
    $('#target-enabled').checked = true;
    document.querySelectorAll('[data-target-color]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.targetColor === 'red')));
    $('#stimulus-strength').value = '0.75';
    $('#neuron-detail').textContent = 'Click a neuron in either brain view to select it.';
    this.updateEyeButtons(); this.updateFeedback(); this.onChange(true);
  }

  snapshot(origin, toEye = delta => delta.toArray()) {
    const p = this.target.position;
    const patches = this.target.visible && p.z > origin.z ? [{
      center: toEye(p.clone().sub(origin)),
      half_size: [0.12, 0.12], luminance: 1, chroma: this.color === 'red' ? 1 : 0,
    }] : [];
    return { patches, controls: { blindLeft: this.blindLeft, blindRight: this.blindRight,
      stimulate: this.stimulus && { ...this.stimulus } } };
  }

  screenPoint(index = null, pip = false) {
    const b = this.getBrain(), p = new THREE.Vector3();
    const canvas = pip ? this.pipRenderer.domElement : this.renderer.domElement;
    const camera = pip ? this.pipCam : this.camera;
    if (index === null) this.target.getWorldPosition(p);
    else {
      const cloud = pip ? b.cloudSketch : b.cloudPts;
      if (!cloud) return null;
      cloud.updateWorldMatrix(true, false);
      p.fromArray(b.positions, index * 3).applyMatrix4(cloud.matrixWorld);
    }
    p.project(camera); const r = canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  }

  status() {
    return { target: this.target.position.toArray(), color: this.color, visible: this.target.visible,
      selected: this.selected, controls: this.snapshot(new THREE.Vector3()).controls,
      applied: this.applied, inputSeq: this.inputSeq };
  }
}
