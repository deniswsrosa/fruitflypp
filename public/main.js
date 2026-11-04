// QueryFly client: a 3D fruit fly with the real MaleCNS connectome glowing inside
// its head, typing SQL++ on a keyboard. Character flashes feed the neural
// simulation; template-generated queries execute against Couchbase.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { GLTFLoader } from '/vendor/loaders/GLTFLoader.js';
import { BrainInteractions } from '/brain-interactions.js?v=3';
import { rigFrontLegs, tapNearestLeg, updateTypingLegs, startGrooming } from '/typing-legs.js?v=3';

const $ = s => document.querySelector(s);
const stage = $('#stage');

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);
scene.fog = new THREE.FogExp2(0x05070c, 0.03);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);   // ~30% more zoom vs the old 42° fov
camera.position.set(0, 0.7, 5.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.autoRotate = false;   // the zoomed-in framing clips the fly while orbiting; drag to orbit instead
controls.autoRotateSpeed = 0.45;
controls.target.set(0, -0.05, 0.45);
const Q = new URLSearchParams(location.search);
if (Q.has('nofly')) controls.target.set(0, 0, 0);
if (Q.has('still')) { // fixed 3/4 camera for screenshots
  controls.autoRotate = false;
  camera.position.set(2.1, 0.9, 3.6);
}

// ---------- side brain view (picture-in-picture, like Fly Saber's Neurons panel) ----------
const pipCam = new THREE.PerspectiveCamera(30, 1, 0.05, 10);
pipCam.zoom = 2.7;                      // another 50% increase over the previous 1.8 initial zoom
pipCam.updateProjectionMatrix();
pipCam.layers.set(1);                   // sees only the brain sketch + activity overlay (layer 1)
const pipRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
pipRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const pipContainer = $('#pip');
pipContainer.appendChild(pipRenderer.domElement);
function resizePip() {
  const w = pipContainer.clientWidth, h = pipContainer.clientHeight;
  pipRenderer.setSize(w, h);
  pipCam.aspect = w / h;
  pipCam.updateProjectionMatrix();
}
new ResizeObserver(resizePip).observe(pipContainer);
resizePip();
// drag to rotate, scroll to zoom (damped; updated from the PiP tick)
const pipControls = new OrbitControls(pipCam, pipRenderer.domElement);
pipControls.enableDamping = true;
pipControls.enablePan = false;
pipControls.minDistance = 0.2;
pipControls.maxDistance = 2;
const pipBox = new THREE.Box3(), pipTmp = new THREE.Vector3();
let brainFitted = false;
let brainCenter = null;                 // world center of the cloud, set on the first render
let pipRenders = 0;                     // debug: how many PiP frames actually rendered
// Static camera (only moves when the user drags) + a small library of viewing angles.
// The in-head brain follows the fly. The PiP shares its geometry and activity
// buffers through a separate fixed transform, keeping the orbit view steady.
const PIP_VIEWS = {
  iso:    [0.50, 0.34, 0.50],
  front:  [0.00, 0.05, 0.74],
  back:   [0.00, 0.05, -0.74],
  top:    [0.00, 0.78, 0.06],
  bottom: [0.00, -0.78, 0.06],
  left:   [-0.74, 0.05, 0.00],
  right:  [0.74, 0.05, 0.00],
};
function setPipView(name) {
  const v = PIP_VIEWS[name];
  if (!v || !brainCenter) return;
  pipCam.position.set(brainCenter.x + v[0], brainCenter.y + v[1], brainCenter.z + v[2]);
  pipControls.target.copy(brainCenter);
  pipControls.update();
}
// ~25 fps on its own clock; ease signed activity toward the latest model frame.
let pipLastTick = performance.now();
setInterval(() => {
  const tickNow = performance.now();
  const ease = 1 - Math.exp(-Math.min((tickNow - pipLastTick) / 1000, 0.1) / 0.12);
  pipLastTick = tickNow;
  if (!brainFitted) return;
  pipBox.setFromObject(cloudSketch).getCenter(pipTmp);
  if (!brainCenter) {
    brainCenter = pipTmp.clone();
    setPipView('iso');
  }
  if (sketchAct) {
    const live = performance.now() - activityReceivedAt < 1000;
    let any = false;
    for (let j = 0; j < sketchAct.length; j++) {
      const target = live ? activityTarget[j] : 0;
      const gap = target - sketchAct[j];
      if (gap === 0) continue;
      sketchAct[j] = Math.abs(gap) < 0.004 ? target : sketchAct[j] + gap * ease;
      any = true;
    }
    if (any) cloudActivity.geometry.attributes.activity.needsUpdate = true;
  }
  pipControls.update();
  pipRenderer.render(scene, pipCam);
  pipRenders++;
}, 40);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(2.5, 4, 3);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x7aa2ff, 0.6); // cool rim from behind
rim.position.set(-2, 1.5, -3);
scene.add(rim);

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// soft round sprite for point clouds — plain PointsMaterial draws squares
const DOT = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
// activity colors in Fly Saber's diverging style: excitation vermilion, inhibition blue
const EXCITE = new THREE.Color(0xff350a);
const INHIBIT = new THREE.Color(0x2455ff);

// ---------- connectome transform ----------
// cloudGroup applies the display orientation of the MaleCNS soma positions (data axes
// -> neuraxis front-to-back). fitBrain() then parks the cloud inside the fly's
// head. This export is the visual-to-motor brain circuit, not a full CNS cloud.
const CLOUD_ROT = [3.53, 0.119, 0];
const BRAIN_SCALE = 0.19;   // fallback if the model ships no headRadii
const HEAD_SAFETY = 0.82;   // legacy ellipsoid size, used only to preserve the PiP framing
const flyGroup = new THREE.Group();
flyGroup.position.z = 0.43;   // bring the front legs slightly farther over the letter rows
flyGroup.position.y = -0.035;
scene.add(flyGroup);
const brainAnchor = new THREE.Group();
flyGroup.add(brainAnchor);
const cloudGroup = new THREE.Group();
brainAnchor.add(cloudGroup);
const brainSpace = new THREE.Group();   // fixed transform for the independent PiP copy
scene.add(brainSpace);
let flyMeta = null;   // parsed /fly-meta.json (head capsule, wing pivots, hips)

// ---------- brain cloud (real MaleCNS soma positions) ----------
let positions = null;   // Float32Array 3N (cloud-local coords)
let brainAsset = null; // exact model neuron metadata and body IDs
let headFit = null; // uniform scale and center fitted to the actual CT head envelope
let activityTarget = null, activityReceivedAt = 0, activityStep = -1;
let brainStream = null, brainSession = null, eyeRequests = 0, eyeInputSeq = 0;
let regionOf = null;    // Uint8Array N: biological pathway role
let regionIndices = []; // region id -> Int32Array of point indices
let regionColors = [];  // region id -> THREE.Color
let regionNames = [];
let cloudPts = null;    // the connectome Points object (for click raycasts)
let cloudSketch = null; // faint layer-1-only copy for the side brain view
let cloudActivity = null; // separate, saturated per-neuron activity overlay
let sketchAct = null;   // per-neuron signed display activity in [-1, 1]

const interactions = new BrainInteractions({
  scene, camera, renderer, controls, pipCam, pipRenderer, pipControls,
  getBrain: () => ({ asset: brainAsset, positions, cloudPts, cloudSketch, cloudGroup, brainSpace }),
  isReady: () => !!brainSession,
  onChange: urgent => { if (urgent) sendBrainInput(true); },
});

async function loadBrain() {
  const [response, fitResponse] = await Promise.all([
    fetch('/brain/neurons.json'), fetch('/brain/head-fit.json'),
  ]);
  if (!response.ok || !fitResponse.ok) throw new Error('Could not load connectome model metadata');
  const bytes = await response.arrayBuffer();
  brainAsset = JSON.parse(new TextDecoder().decode(bytes));
  headFit = await fitResponse.json();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  if (headFit.assetSha256 !== hash || headFit.neuronCount !== brainAsset.n_neurons ||
      !headFit.rotation.every((angle, i) => angle === CLOUD_ROT[i])) {
    throw new Error('Brain fit does not match the neuron export; run scripts/fit_brain.py');
  }
  const n = brainAsset.n_neurons;
  if (brainAsset.body_id.length !== n || brainAsset.position_um.length !== n * 3 ||
      brainAsset.role.length !== n) throw new Error('Invalid connectome neuron metadata');
  positions = new Float32Array(n * 3);
  const bounds = brainAsset.bounds_um;
  const center = bounds.min.map((v, k) => (v + bounds.max[k]) / 2);
  const extent = Math.max(...bounds.max.map((v, k) => v - bounds.min[k]));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      // Rigid orientation and uniform scale, preserving every original index.
      positions[i * 3 + k] = (brainAsset.position_um[i * 3 + k] - center[k]) * 2 / extent * (k === 0 ? -1 : 1);
    }
  }
  regionOf = Uint8Array.from(brainAsset.role);
  regionNames = brainAsset.roles;
  activityTarget = new Float32Array(n);

  const buckets = regionNames.map(() => []);
  for (let i = 0; i < n; i++) buckets[regionOf[i]].push(i);
  regionIndices = buckets.map(b => Int32Array.from(b));

  const cols = new Float32Array(n * 3);
  const tmp = new THREE.Color();
  for (let r = 0; r < regionNames.length; r++) {
    tmp.setHSL(r / regionNames.length, 0.8, 0.68);
    regionColors.push(tmp.clone());
  }
  for (let i = 0; i < n; i++) {
    tmp.copy(regionColors[regionOf[i]]);
    tmp.offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
    cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  cloudPts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.003, vertexColors: true, transparent: true, opacity: 0.48,
    map: DOT, alphaTest: 0.02, depthWrite: false, sizeAttenuation: true,
  }));
  cloudPts.renderOrder = 2; // above the ghosted exoskeleton
  cloudGroup.add(cloudPts);
  // Keep the same neuron indices and coordinates in both views so every
  // activated soma has an exact counterpart in the side view.
  sketchAct = new Float32Array(n);
  const sketchGeo = new THREE.BufferGeometry();
  sketchGeo.setAttribute('position', geo.attributes.position);
  cloudSketch = new THREE.Points(sketchGeo, new THREE.PointsMaterial({
    size: 1.1, color: 0x8996ab, transparent: true, opacity: 0.10,
    map: DOT, alphaTest: 0.002, depthWrite: false, sizeAttenuation: false,
  }));
  cloudSketch.layers.set(1);
  cloudSketch.renderOrder = 2;
  cloudGroup.add(cloudSketch);

  // Fly-Saber uses a separate activity pass, fixed pixel sizes and normal
  // blending: dense flashes keep their hue instead of adding up to white.
  const activityGeo = new THREE.BufferGeometry();
  activityGeo.setAttribute('position', geo.attributes.position);
  activityGeo.setAttribute('activity', new THREE.BufferAttribute(sketchAct, 1));
  cloudActivity = new THREE.Points(activityGeo, new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: pipRenderer.getPixelRatio() },
      excite: { value: EXCITE }, inhibit: { value: INHIBIT },
    },
    vertexShader: `
      attribute float activity;
      uniform vec3 excite;
      uniform vec3 inhibit;
      uniform float pixelRatio;
      varying vec3 vColor;
      varying float vActivity;
      void main() {
        vColor = activity >= 0.0 ? excite : inhibit;
        vActivity = abs(activity);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = pixelRatio * mix(1.5, 3.5, abs(activity));
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vActivity;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5 || vActivity <= 0.004) discard;
        float alpha = vActivity * smoothstep(0.5, 0.25, d);
        gl_FragColor = vec4(vColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, blending: THREE.NormalBlending,
    depthWrite: false, depthTest: false,
  }));
  cloudActivity.layers.set(0);
  cloudActivity.renderOrder = 3;
  cloudGroup.add(cloudActivity);
}

// ---------- live connectome activity (Fly-Saber rate network, not random flashes) ----------
function brainMessage(message) {
  $('#piplabel').textContent = message;
}

function stopBrain() {
  if (brainStream) brainStream.close();
  brainStream = null;
  brainSession = null;
  activityStep = -1;
  activityReceivedAt = 0;
  if (activityTarget) activityTarget.fill(0);
  interactions.releaseGesture();
  interactions.updateFeedback(null);
}

function startBrain() {
  if (brainStream) return;
  brainMessage('starting connectome model…');
  const source = brainStream = new EventSource('/api/brain/stream');
  source.addEventListener('ready', async e => {
    try {
      await brainLoad;
      if (source !== brainStream) return;
      const ready = JSON.parse(e.data);
      if (ready.neurons !== brainAsset.n_neurons || !Array.isArray(ready.bodyIds) ||
          ready.bodyIds.length !== brainAsset.body_id.length ||
          !ready.bodyIds.every((id, i) => id === brainAsset.body_id[i])) {
        throw new Error('Model neuron IDs/order do not match the displayed brain');
      }
      brainSession = ready.id;
      activityStep = -1;
      interactions.updateFeedback(null);
      sendBrainInput(true);
      brainMessage(`${ready.neurons.toLocaleString()} neurons · simulated activity · drag to rotate, scroll to zoom`);
    } catch (error) {
      stopBrain();
      brainMessage('brain error: ' + error.message);
    }
  });
  source.addEventListener('activity', e => {
    if (!brainSession || source !== brainStream) return;
    try {
      const frame = JSON.parse(e.data);
      if (!Number.isInteger(frame.step) || frame.step <= activityStep) return;
      const binary = atob(frame.values);
      if (binary.length !== activityTarget.length) return;
      for (let i = 0; i < binary.length; i++) {
        const byte = binary.charCodeAt(i);
        const change = byte > 127 ? byte - 256 : byte;
        activityTarget[i] = Math.sign(change) * Math.min(1, Math.sqrt(Math.abs(change) / 32));
      }
      activityStep = frame.step;
      activityReceivedAt = performance.now();
      interactions.updateFeedback(frame.controls, frame.inputSeq);
    } catch (error) {
      stopBrain();
      brainMessage('brain error: ' + error.message);
    }
  });
  source.addEventListener('brain-error', e => {
    const { message } = JSON.parse(e.data);
    stopBrain();
    brainMessage(message);
  });
  source.onerror = () => {
    if (source !== brainStream) return;
    stopBrain();
    brainMessage('brain model disconnected — resume to reconnect');
  };
}

// The compound eye looks toward the keyboard. Only projected key flashes and
// colored targets enter the network; letter labels and SQL text are not inputs.
const eyeOrigin = new THREE.Vector3(), eyeForward = new THREE.Vector3();
const eyeRight = new THREE.Vector3(), eyeUp = new THREE.Vector3();
const gazeTarget = new THREE.Vector3(), eyeScratch = new THREE.Vector3();
function eyeCoordinates(delta) {
  return [delta.dot(eyeRight), delta.dot(eyeUp), delta.dot(eyeForward)];
}
async function sendBrainInput(urgent = false) {
  if (!brainSession || (eyeRequests && !urgent) || !brainFitted) return;
  brainAnchor.getWorldPosition(eyeOrigin);
  kbGroup.getWorldPosition(gazeTarget);
  eyeForward.copy(gazeTarget).sub(eyeOrigin).normalize();
  eyeRight.crossVectors(new THREE.Vector3(0, 1, 0), eyeForward).normalize();
  eyeUp.crossVectors(eyeForward, eyeRight).normalize();
  interactions.setVisualFrame(eyeOrigin, eyeForward, eyeRight, eyeUp);
  const snapshot = interactions.snapshot(eyeOrigin, eyeCoordinates);
  const patches = [...snapshot.patches];
  const litKeys = keycaps.filter(k => k.userData.flash > 0.03)
    .sort((a, b) => b.userData.flash - a.userData.flash);
  for (const key of litKeys.slice(0, 16 - patches.length)) {
    key.updateWorldMatrix(true, false);
    const { width, height, depth } = key.geometry.parameters;
    const corners = [];
    for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) {
      eyeScratch.set(x, height / 2, z).applyMatrix4(key.matrixWorld).sub(eyeOrigin);
      corners.push(eyeCoordinates(eyeScratch));
    }
    const lo = [0, 1, 2].map(k => Math.min(...corners.map(p => p[k])));
    const hi = [0, 1, 2].map(k => Math.max(...corners.map(p => p[k])));
    const center = lo.map((v, k) => (v + hi[k]) / 2);
    if (center[2] <= 0) continue;
    const flash = key.userData.flash;
    patches.push({ center, half_size: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2],
      luminance: 0.5 + 0.5 * flash,
      chroma: 0.5 + (key.userData.kind === 'kw' ? -0.5 : 0.5) * flash });
  }
  eyeRequests++;
  const id = brainSession;
  try {
    const response = await fetch('/api/brain/eye?id=' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patches, controls: snapshot.controls, seq: ++eyeInputSeq }),
    });
    if (!response.ok && id === brainSession) {
      stopBrain(); brainMessage('brain input disconnected — resume to reconnect');
    }
  } catch {
    if (id === brainSession) { stopBrain(); brainMessage('brain input disconnected — resume to reconnect'); }
  } finally { eyeRequests--; }
}
setInterval(() => { sendBrainInput(); }, 1000 / 30);

// ---------- the fly: real Drosophila mesh (adult fruit fly CT scan) ----------
const FLY_SCALE = 0.65;
const modelGroup = new THREE.Group();  // baked model space: head +z (toward camera), dorsal +y
modelGroup.rotation.x = -0.55;         // slight pitch back: body stays horizontal, face tips up to the camera
flyGroup.add(modelGroup);
const wings = [];                      // pivot groups at the wing roots
const frontLegs = [];                  // skinned CT forelegs with hip/knee/ankle joints
let flyReady = false;

// the exoskeleton is permanently x-rayed (0.06): the connectome is the star of
// the show; the fly itself reads as a faint ghost around it
const MAT = {
  body: new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.06, depthWrite: false, shininess: 25 }),
  head: new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.06, shininess: 80, depthWrite: false }),
  eyes: new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.06, shininess: 180, specular: 0xff8888, depthWrite: false }),
  wing: new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false, shininess: 110 }),
};

function loadFly() {
  return Promise.all([
    fetch('/fly-meta.json').then(r => r.json()),
    new GLTFLoader().loadAsync('/fly.glb'),
    fetch('/foreleg-rig.json').then(r => r.json()),
  ]).then(([m, glb, rig]) => {
    flyMeta = m;
    const meta = m;
    const holder = glb.scene;
    // Collect first: reparenting wings during traversal skips siblings and can
    // leave a wing rendered with its original opaque gray material.
    const meshes = [];
    holder.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const o of meshes) {
      o.renderOrder = 1;
      const name = o.name || (o.parent && o.parent.name) || '';
      if (name.startsWith('wing')) {
        // wrap in a pivot at the wing root so flutter rotates the whole paddle
        const p = name === 'wingL' ? meta.wingPivotL : meta.wingPivotR;
        const pivot = new THREE.Group();
        pivot.position.set(p[0], p[1], p[2]);
        pivot.rotation.x = -0.04;
        o.position.set(-p[0], -p[1], -p[2]);
        pivot.add(o);
        holder.add(pivot);
        o.material = MAT.wing;
        wings.push(pivot);
      } else {
        o.material = MAT[name] || MAT.body;
      }
    }
    const body = meshes.find(o => o.name === 'body');
    if (body) frontLegs.push(...rigFrontLegs(body, rig));
    modelGroup.add(holder);
    holderRef = holder;
    modelGroup.scale.setScalar(FLY_SCALE);
    modelGroup.updateWorldMatrix(true, true);
    // recenter: bbox center -> flyGroup origin
    const bb = new THREE.Box3().setFromObject(holder);
    const shift = bb.getCenter(new THREE.Vector3()).applyMatrix4(modelGroup.matrixWorld.clone().invert());
    holder.position.sub(shift);
    // park the connectome inside the head — holder's own translation handles
    // recentering, so model coordinates are used as-is (like the wing pivots)
    brainAnchor.position.set(...meta.headCenter);
    holder.add(brainAnchor);
    flyReady = true;
  });
}

// ---------- keyboard (real ANSI layout, labeled keycaps) ----------
const kbGroup = new THREE.Group();
kbGroup.position.set(0, -0.58, 0.92);
kbGroup.rotation.set(0.22, Math.PI, 0); // face the keyboard toward the fly, space bar nearest its legs
scene.add(kbGroup);
const keycaps = [];
const KEYMAP = {};
const ALIAS = { '*': '8', '(': '9', ')': '0', '%': '5', '_': '-', '+': '=', '"': "'", '<': ',', '>': '.', '?': '/', ':': ';', '!': '1', '@': '2', '#': '3', '$': '4', '&': '7', '^': '6', '|': '\\', '~': '`', '{': '[', '}': ']', '-': '-', "'": "'" };
const GLYPH = { BACK: '⌫', TAB: '⇥', CAPS: '⇪', ENTER: '⏎', LSHIFT: '⇧', RSHIFT: '⇧', LCTRL: 'ctrl', RCTRL: 'ctrl', LALT: 'alt', RALT: 'alt', SPACE: '' };
// [name, width in key units] per row; cumulative left alignment gives the ANSI stagger
const ROWS = [
  [['`', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['BACK', 2]],
  [['TAB', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1], ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1.5]],
  [['CAPS', 1.75], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1], ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ['\'', 1], ['ENTER', 2.25]],
  [['LSHIFT', 2.25], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1], ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['RSHIFT', 2.75]],
  [['LCTRL', 1.25], ['LALT', 1.25], ['SPACE', 6.25], ['RALT', 1.25], ['RCTRL', 1.25]],
];

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function labelTexture(glyph, isMod) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = isMod ? '#1d2635' : '#2e3b52';
  rr(ctx, 3, 3, 58, 58, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 2;
  rr(ctx, 4, 4, 56, 56, 8); ctx.stroke();
  if (glyph) {
    ctx.fillStyle = isMod ? '#8fa3bd' : '#e6eefb';
    ctx.font = `${isMod ? 600 : 700} ${isMod ? 19 : 30}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 32, 35);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 16;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function buildKeyboard() {
  const u = 0.155, cap = 0.135;
  const boardW = 15 * u + 0.06, boardD = 5 * u + 0.06;
  const sideMat = new THREE.MeshPhongMaterial({ color: 0x222d40, shininess: 50 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(boardW, 0.05, boardD), sideMat.clone());
  base.material.color.setHex(0x0e141d);
  kbGroup.add(base);
  // Cyan underglow on the front edge of the keyboard.
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(boardW, 0.014, 0.014),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee }),
  );
  glow.position.set(0, 0.012, boardD / 2);
  kbGroup.add(glow);
  const bottomMat = new THREE.MeshPhongMaterial({ color: 0x161e2b, shininess: 20 });

  ROWS.forEach((row, ri) => {
    const rowW = row.reduce((s, k) => s + k[1], 0);
    let left = -(rowW * u) / 2;
    for (const [name, w] of row) {
      const isMod = w > 1;
      const topMat = new THREE.MeshPhongMaterial({
        map: labelTexture(GLYPH[name] ?? name, isMod),
        emissive: 0x000000, shininess: 60,
      });
      const geo = new THREE.BoxGeometry(w * u - 0.022, 0.05, cap);
      const key = new THREE.Mesh(geo, [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat]);
      key.position.set(left + w * u / 2, 0.072, (ri - 2) * u * 1.02);  // digits row far (toward the fly), space row near the camera
      key.name = 'key:' + name;
      key.userData.baseY = key.position.y;
      key.userData.flash = 0;
      kbGroup.add(key);
      keycaps.push(key);
      KEYMAP[name] = key;
      left += w * u;
    }
  });
}

const typingQueue = [];
let typingJob = null, typingLeg = null, typedCharacters = 0, lastKey = null;
let pendingExecution = false, pendingResult = null, lastExecutedSql = '';
const KEY_COLORS = { kw: 0x22d3ee, id: 0xf472b6 };

function pressKey(character, kind, now) {
  const ch = character.toUpperCase();
  const name = character === ' ' ? 'SPACE' : (KEYMAP[ch] ? ch : ALIAS[ch]);
  const key = KEYMAP[name];
  if (!key) return; // Preserve unsupported text without flashing an unrelated key.
  key.userData.litAt = now;
  key.userData.flash = 1;
  key.userData.kind = kind;
  key.material[2].emissive.setHex(KEY_COLORS[kind]);
  flyGroup.userData.tapT = now;
  typingLeg = tapNearestLeg(frontLegs, key, now);
  key.userData.leg = typingLeg;
  lastKey = name;
  sendBrainInput(true);
}

function queueToken(token) {
  typingQueue.push({ ...token, characters: [...token.text, ' '], index: 0, span: null });
}

function updateTyping(now) {
  if (!es || typingLeg?.active) return;
  if (!typingJob && typingQueue.length) {
    typingJob = typingQueue.shift();
    typingJob.span = document.createElement('span');
    typingJob.span.className = typingJob.kind;
    sqlEl.insertBefore(typingJob.span, sqlEl.querySelector('.cursor'));
    typingJob.nextAt = now;
  }
  if (typingJob && now >= typingJob.nextAt) {
    const ch = typingJob.characters[typingJob.index++];
    typingJob.span.textContent += ch;
    pressKey(ch, typingJob.kind, now);
    typedCharacters++;
    typingJob.nextAt = now + Math.max(240, currentBpm / 2);
    if (typingJob.index >= typingJob.characters.length) typingJob = null;
  }
  if (!typingJob && !typingQueue.length && pendingExecution) {
    pendingExecution = false;
    if (pendingResult) {
      const result = pendingResult; pendingResult = null;
      lastExecutedSql = result.sql;
      publishResult(result);
    } else statusEl.textContent = 'executing against travel-sample…';
  } else if (!typingJob && !typingQueue.length && pendingResult) {
    const result = pendingResult; pendingResult = null;
    lastExecutedSql = result.sql; publishResult(result);
  }
}

function updateFlyAndKeyboard(now) {
  const t = now / 1000;
  let y = Math.sin(t * 1.4) * 0.012;
  const dtap = (now - flyGroup.userData.tapT) / 140;
  if (dtap < 1) y -= Math.sin(dtap * Math.PI) * 0.007;
  flyGroup.position.y = y - 0.035;
  updateTypingLegs(frontLegs, now);
  for (const key of keycaps) {
    const elapsed = now - (key.userData.litAt ?? -Infinity);
    const leg = key.userData.leg;
    const pressing = leg?.active && leg.key === key;
    const flash = Math.max(pressing ? 0.8 : 0, 1 - elapsed / 260);
    key.userData.flash = flash;
    key.material[2].emissive.setHex(KEY_COLORS[key.userData.kind] ?? 0).multiplyScalar(flash);
    const phase = pressing ? leg.phase : 0;
    const press = pressing ? Math.sin(Math.PI * THREE.MathUtils.clamp((phase - 0.2) / 0.7, 0, 1)) : 0;
    key.position.y = key.userData.baseY - press * 0.02;
  }
}

// ---------- audio ----------
let actx = null, master = null, muted = false;
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; }
  }
  if (actx && !master) {
    master = actx.createGain();
    master.connect(actx.destination);
  }
  return actx;
}

function blip(kind) {
  try {
    const ctx = audio(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = kind === 'kw' ? 'sawtooth' : kind === 'id' ? 'square' : 'sine';
    o.frequency.setValueAtTime(kind === 'kw' ? 587 : kind === 'id' ? 440 : 880, t);
    if (kind === 'ex') o.frequency.exponentialRampToValueAtTime(1760, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'ex' ? 0.3 : 0.16));
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.35);
  } catch { /* audio blocked until gesture */ }
}

function tick() {
  try {
    const ctx = audio(), t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 180;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.025, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.1);
  } catch { /* ignore */ }
}

// ---------- SQL panel + results ----------
const sqlEl = $('#sql'), statusEl = $('#status'), resultsEl = $('#results'), metaEl = $('#meta');

function resetSql() {
  typingQueue.length = 0; typingJob = null;
  pendingExecution = false; pendingResult = null; typedCharacters = 0; lastExecutedSql = '';
  sqlEl.innerHTML = '<span class="cursor"></span>';
  resultsEl.innerHTML = '<div class="sub">—</div>';
  metaEl.textContent = '';
}

function showResult(r) {
  if (!r.ok) {
    resultsEl.innerHTML = `<div class="sub" style="color:#f87171">ERROR: ${r.error}</div>`;
    metaEl.textContent = `${r.elapsed_ms} ms`;
    return;
  }
  if (!r.rows.length) {
    resultsEl.innerHTML = '<div class="sub">0 rows</div>';
    metaEl.textContent = `${r.elapsed_ms} ms`;
    return;
  }
  const keys = Object.keys(r.rows[0]);
  const head = keys.map(k => `<th>${k}</th>`).join('');
  const body = r.rows.slice(0, 12).map(row =>
    '<tr>' + keys.map(k => {
      const v = row[k];
      const s = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<td title="${s.replace(/"/g, '&quot;')}">${s.length > 40 ? s.slice(0, 40) + '…' : s}</td>`;
    }).join('') + '</tr>').join('');
  resultsEl.innerHTML = `<table><tr>${head}</tr>${body}</table>`;
  metaEl.textContent = `${r.rows.length} row${r.rows.length > 1 ? 's' : ''} · ${r.elapsed_ms} ms` +
    (r.rows.length > 12 ? ` (showing 12 of ${r.rows.length})` : '');
}

// ---------- SSE wiring ----------
const CHART_TITLES = ['airport lookup', 'top airport countries', 'routes + airline join', 'busiest weekday', 'landmarks to eat at'];
let es = null, lastChart = null, currentBpm = 550, nextChartTimer = null;
function publishResult(result) {
  showResult(result);
  startGrooming(frontLegs, performance.now());
  statusEl.textContent = result.ok ? 'done. the fly rests.' : 'query failed.';
  clearTimeout(nextChartTimer);
  nextChartTimer = setTimeout(() => {
    if (es) connect(lastChart === null ? null : (lastChart + 1) % CHART_TITLES.length);
  }, 5000);
}

function updateStat() {
  $('#stat').textContent = 'Keys light up character by character. Drag the colored target or hold a neuron to stimulate it.';
}

function markChip(i) {
  document.querySelectorAll('.chip').forEach(b =>
    b.classList.toggle('on', i != null && +b.dataset.chart === i));
}

function connect(chartIdx) {
  clearTimeout(nextChartTimer);
  startBrain();
  if (es) es.close();
  const params = new URLSearchParams({ bpm: currentBpm, once: 1 });
  if (chartIdx != null) params.set('chart', chartIdx);
  es = new EventSource('/api/stream?' + params);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED)
      statusEl.textContent = 'lost the fly — is server.js still running? reload the page.';
    else if (!lastChart)
      statusEl.textContent = 'connecting to the fly…';
  };
  es.addEventListener('chart', e => {
    const title = JSON.parse(e.data).title;
    lastChart = CHART_TITLES.indexOf(title);
    markChip(lastChart);
    resetSql();
    statusEl.textContent = 'chart: ' + title;
  });
  es.addEventListener('beat', () => tick());
  es.addEventListener('token', e => {
    const t = JSON.parse(e.data);
    queueToken(t);
  });
  es.addEventListener('execute', () => {
    pendingExecution = true;
    if (typingJob || typingQueue.length) statusEl.textContent = 'finishing the query…';
  });
  es.addEventListener('result', e => {
    const r = JSON.parse(e.data);
    pendingResult = r;
    es.close();
  });
}

function start() {
  $('#overlay').style.display = 'none';
  statusEl.textContent = 'waking the fly up…';
  audio();
  connect(lastChart);
  updateStat();
  $('#stop').textContent = 'pause the fly';
}

function stop() {
  clearTimeout(nextChartTimer);
  stopBrain();
  brainMessage('connectome model paused · drag to rotate, scroll to zoom');
  if (es) { es.close(); es = null; }
  $('#overlay').style.display = 'flex';
  $('#overlay').querySelector('button').textContent = '▶ resume';
  $('#stop').textContent = 'paused';
  statusEl.textContent = 'paused';
}

$('#start').addEventListener('click', start);
$('#stop').addEventListener('click', () => (es ? stop() : start()));
document.querySelectorAll('.chip').forEach(b =>
  b.addEventListener('click', () => connect(+b.dataset.chart)));
$('#skip').addEventListener('click', () =>
  connect(lastChart == null ? null : (lastChart + 1) % CHART_TITLES.length));
$('#bpm').addEventListener('input', e => {
  currentBpm = +e.target.value;
  connect(lastChart);
});
$('#sound').addEventListener('click', () => {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 1;
  $('#sound').textContent = muted ? 'sound off' : 'sound on';
});

// surface failures on the page instead of dying silently in the console
function showErr(msg) {
  const box = $('#overlay').firstElementChild;
  if (!box.querySelector('.err')) {
    const el = document.createElement('p');
    el.className = 'err';
    el.style.color = '#f87171';
    box.appendChild(el);
  }
  box.querySelector('.err').textContent = 'Error: ' + msg;
  statusEl.textContent = 'Error: ' + msg;
}
window.addEventListener('error', e => showErr(`${e.message} @ ${e.filename || ''}:${e.lineno || ''}`));
window.addEventListener('unhandledrejection', e => showErr(String(e.reason)));

if (new URLSearchParams(location.search).has('autostart')) start();

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  updateFlyAndKeyboard(now);
  updateTyping(now);
  controls.update();
  renderer.render(scene, camera);
}

// Keep a fixed PiP framing, then fit the in-head cloud to the actual CT head
// envelope. The in-head group remains parented to the animated head anchor.
function fitBrain() {
  if (!positions || !flyReady) return false;
  const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...CLOUD_ROT));
  const v = new THREE.Vector3();
  const n = regionOf.length;
  const rot = new Float32Array(n * 3);          // positions rotated into model frame
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(rotM);
    rot[i * 3] = v.x; rot[i * 3 + 1] = v.y; rot[i * 3 + 2] = v.z;
    cx += v.x; cy += v.y; cz += v.z; cnt++;
  }
  cx /= cnt; cy /= cnt; cz /= cnt;
  let scl = BRAIN_SCALE / FLY_SCALE;            // cloud units -> holder (model) units
  if (flyMeta && flyMeta.headRadii) {
    const Rd = flyMeta.headRadii;
    const perDir = Array.isArray(Rd[0]);        // [+,-] pairs vs plain symmetric
    const R = (k, s) => (perDir ? Rd[k][s > 0 ? 0 : 1] : Rd[k]) * HEAD_SAFETY;
    const A = flyMeta.headAxes || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      const px = rot[i * 3] - cx, py = rot[i * 3 + 1] - cy, pz = rot[i * 3 + 2] - cz;
      let d = 0;
      for (let k = 0; k < 3; k++) {
        const u = A[k][0] * px + A[k][1] * py + A[k][2] * pz;
        const q = u / R(k, u);
        d += q * q;
      }
      if (d > maxD) maxD = d;
    }
    scl = 1 / Math.sqrt(maxD);
  }
  cloudGroup.scale.setScalar(scl);
  cloudGroup.position.set(-cx * scl, -cy * scl, -cz * scl);
  cloudGroup.quaternion.setFromEuler(new THREE.Euler(...CLOUD_ROT));
  // Preserve the existing PiP size and zoom independently of the in-head fit.
  cloudGroup.updateWorldMatrix(true, false);
  cloudGroup.matrixWorld.decompose(brainSpace.position, brainSpace.quaternion, brainSpace.scale);
  brainSpace.add(cloudSketch);
  const pipActivity = new THREE.Points(cloudActivity.geometry, cloudActivity.material);
  pipActivity.layers.set(1);
  pipActivity.renderOrder = cloudActivity.renderOrder;
  brainSpace.add(pipActivity);
  brainSpace.updateWorldMatrix(true, true);

  if (flyMeta && headFit) {
    const scale = headFit.scale;
    const center = headFit.sourceCenter;
    cloudGroup.scale.setScalar(scale);
    cloudGroup.position.set(
      headFit.center[0] - flyMeta.headCenter[0] - center[0] * scale,
      headFit.center[1] - flyMeta.headCenter[1] - center[1] * scale,
      headFit.center[2] - flyMeta.headCenter[2] - center[2] * scale,
    );
  }
  return true;
}

flyGroup.userData.tapT = -1e9;

const brainLoad = loadBrain();
const loads = [brainLoad];
if (!Q.has('nofly')) {
  buildKeyboard();
  loads.push(loadFly().catch(e => showErr('fly model failed to load: ' + (e.message || e))));
}
Promise.all(loads).then(() => {
  if (Q.has('nofly')) flyReady = true;
  brainFitted = fitBrain();
  if (brainFitted) interactions.attachBrainViews();
  requestAnimationFrame(frame);
});

// tiny debug/testing hook
window.__qf = {
  stat: () => $('#stat').textContent,
  pipStatus: () => ({
    renders: pipRenders,
    center: brainCenter && brainCenter.toArray().map(n => +n.toFixed(2)),
    zoom: pipCam.zoom,
    size: [pipContainer.clientWidth, pipContainer.clientHeight],
    neurons: sketchAct && sketchAct.length,
    activityStep,
    live: activityReceivedAt > 0 && performance.now() - activityReceivedAt < 1000,
    active: sketchAct && sketchAct.reduce((n, a) => n + (Math.abs(a) > 0.01), 0),
    session: !!brainSession,
  }),
  interactions: () => interactions.status(),
  targetScreen: () => interactions.screenPoint(),
  neuronScreen: (i = 0, pip = true) => interactions.screenPoint(i, pip),
  typingStatus: () => ({ characters: typedCharacters, queued: typingQueue.length,
    lastKey, text: sqlEl.textContent.trim(), executedSql: lastExecutedSql,
    legs: frontLegs.map(leg => ({ side: leg.side, contacts: leg.contacts,
      tipWorld: leg.bones[2].localToWorld(leg.joints[3].clone().sub(leg.joints[2])).toArray(),
      lastContact: leg.lastContact, grooming: leg.grooming?.phase ?? null,
      joints: leg.bones.map(b => b.quaternion.toArray()) })) }),
  keyScreen(name) {
    const key = KEYMAP[name]; if (!key) return null;
    const p = key.getWorldPosition(new THREE.Vector3()).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  },
  cam(px, py, pz, tx, ty, tz) {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
    return camera.position.toArray();
  },
  scene: () => scene,
  debug() {
    const w = o => { const v = new THREE.Vector3(); o.getWorldPosition(v); return v.toArray().map(n => +n.toFixed(3)); };
    const bb = o => { const b = new THREE.Box3().setFromObject(o); return [b.min.toArray().map(n => +n.toFixed(2)), b.max.toArray().map(n => +n.toFixed(2))]; };
    return {
      brainAnchorPos: brainAnchor.position.toArray().map(n => +n.toFixed(1)),
      brainWorld: w(brainAnchor),
      brainSceneScale: +(cloudGroup.scale.x * FLY_SCALE).toFixed(3),
      cloudWorld: bb(cloudPts),
      flyChildren: modelGroup.children.map(c => c.name || c.type),
      holderPos: holderRef ? holderRef.position.toArray().map(n => +n.toFixed(1)) : null,
      wingPivots: wings.length,
    };
  },
};
let holderRef = null;
