'use strict';
// Per-viewer Fly-Saber inference workers. SQL chart generation stays independent.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const sessions = new Map();
const localPython = path.join(__dirname, '.venv/bin/python');
const python = process.env.BRAIN_PYTHON || (fs.existsSync(localPython) ? localPython : 'python3');

function validPatches(patches) {
  const vector = (v, n, max) => Array.isArray(v) && v.length === n &&
    v.every(x => Number.isFinite(x) && Math.abs(x) <= max);
  const unit = v => Number.isFinite(v) && v >= 0 && v <= 1;
  return Array.isArray(patches) && patches.length <= 16 && patches.every(p =>
    p && vector(p.center, 3, 1000) && p.center[2] > 0 &&
    vector(p.half_size, 2, 10) && p.half_size.every(x => x >= 0) &&
    unit(p.luminance) && unit(p.chroma));
}

function validControls(controls, count) {
  if (controls === undefined) return true;
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) return false;
  if (typeof controls.blindLeft !== 'boolean' || typeof controls.blindRight !== 'boolean') return false;
  const stimulus = controls.stimulate;
  return stimulus === null || (!!stimulus && Number.isInteger(stimulus.index) &&
    stimulus.index >= 0 && stimulus.index < count && Number.isFinite(stimulus.current) &&
    stimulus.current > 0 && stimulus.current <= 1.5);
}

function handleBrain(req, res, url) {
  if (url.pathname === '/api/brain/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': starting connectome model\n\n');
    const id = randomUUID();
    const child = spawn(python, ['-u', path.join(__dirname, 'scripts/brain_worker.py')], {
      cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JAX_PLATFORMS: 'cpu', OMP_NUM_THREADS: '2' },
    });
    sessions.set(id, child);
    child.brainNeuronCount = 0;
    child.lastInputSeq = -1;
    let errorText = '', closed = false;
    const send = (event, data) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      sessions.delete(id);
      child.stdin.destroy();
      child.kill();
      // Inference can be compiling when the viewer disconnects.
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      force.unref();
      child.once('exit', () => clearTimeout(force));
    };
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const data = JSON.parse(line);
        const { event, ...payload } = data;
        if (event === 'ready') {
          child.brainNeuronCount = payload.neurons;
          send('ready', { id, ...payload });
        }
        else if (event === 'activity' && res.writableLength < 256 * 1024) send('activity', payload);
      } catch {
        errorText = 'Invalid response from neural model';
      }
    });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.once('error', error => {
      send('brain-error', { message: `Could not start neural model: ${error.message}` });
      finish();
      res.end();
    });
    child.once('exit', code => {
      if (!closed) {
        console.error('Neural model exited:', code, errorText);
        send('brain-error', { message: 'Neural model stopped. Check Python dependencies and server log.' });
        finish();
        res.end();
      }
    });
    res.once('close', finish);
    return true;
  }
  if (url.pathname === '/api/brain/eye' && req.method === 'POST') {
    const child = sessions.get(url.searchParams.get('id'));
    if (!child || child.stdin.destroyed) { res.writeHead(404); res.end(); return true; }
    let body = '', oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      body += chunk;
      if (body.length > 16 * 1024) { oversized = true; res.writeHead(413); res.end(); }
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        const { patches, controls, seq } = JSON.parse(body);
        if (!validPatches(patches) || !validControls(controls, child.brainNeuronCount) ||
            (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)))
          throw new Error('Invalid brain input');
        const sequence = seq === undefined ? child.lastInputSeq + 1 : seq;
        // An older in-flight request must never restart stimulation after release.
        if (sequence > child.lastInputSeq && child.stdin.writableLength < 32 * 1024) {
          child.lastInputSeq = sequence;
          child.stdin.write(JSON.stringify({ patches, controls, seq: sequence }) + '\n');
        }
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end('Invalid eye patches'); }
    });
    return true;
  }
  return false;
}

module.exports = { handleBrain, validPatches, validControls };
