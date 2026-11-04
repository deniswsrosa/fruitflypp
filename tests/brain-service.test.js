'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleBrain } = require('../brain-service');

test('HTTP neural session binds neuron IDs, streams computed activity, and rejects invalid input',
  { timeout: 30000 }, async t => {
    const server = http.createServer((req, res) => {
      if (!handleBrain(req, res, new URL(req.url, 'http://localhost'))) {
        res.writeHead(404); res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(url + '/api/brain/stream', { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function nextEvent() {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const record = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(record)?.[1];
          const data = /^data: (.+)$/m.exec(record)?.[1];
          if (event && data) return { event, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, 'model stream must remain open');
        buffer += decoder.decode(value, { stream: true });
      }
    }
    const ready = await nextEvent();
    assert.equal(ready.event, 'ready');
    const asset = require('../public/brain/neurons.json');
    assert.deepEqual(ready.data.bodyIds, asset.body_id);
    assert.equal(ready.data.columns, 437);
    const post = (patches, extra = {}) => fetch(url + '/api/brain/eye?id=' + ready.data.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patches, ...extra }),
    });
    assert.equal((await post([{ center: [0, 0, -1] }])).status, 400);
    assert.equal((await fetch(url + '/api/brain/eye?id=unknown', { method: 'POST' })).status, 404);
    const stimulus = [{ center: [-0.7, 0, 1], half_size: [0.3, 0.3], luminance: 1, chroma: 1 }];
    assert.equal((await post(stimulus)).status, 204);
    let active = false, step = -1;
    for (let i = 0; i < 15; i++) {
      const frame = await nextEvent();
      assert.equal(frame.event, 'activity');
      assert.ok(frame.data.step > step);
      step = frame.data.step;
      const bytes = Buffer.from(frame.data.values, 'base64');
      assert.equal(bytes.length, asset.n_neurons);
      if (bytes.some(v => v !== 0)) { active = true; break; }
    }
    assert.ok(active, 'visual stimulus must change computed neuron rates');
    const control = stimulate => ({ blindLeft: false, blindRight: false, stimulate });
    assert.equal((await post([], { controls: control({ index: asset.n_neurons, current: 1 }) })).status, 400);
    assert.equal((await post([], { controls: control({ index: 0, current: 2 }) })).status, 400);
    assert.equal((await post([], { controls: { blindLeft: 'yes' } })).status, 400);
    assert.equal((await post([], { seq: 10, controls: control({ index: 0, current: 0.75 }) })).status, 204);
    async function until(predicate) {
      for (let i = 0; i < 50; i++) {
        const frame = await nextEvent();
        assert.equal(frame.event, 'activity');
        if (predicate(frame.data)) return frame.data;
      }
      assert.fail('model did not apply the input snapshot');
    }
    const stimulated = await until(f => f.inputSeq === 10 && f.controls.stimulate?.index === 0);
    assert.notEqual(Buffer.from(stimulated.values, 'base64')[0], 0);
    await post([], { seq: 11, controls: control(null) });
    await post([], { seq: 10, controls: control({ index: 0, current: 0.75 }) });
    await until(f => f.inputSeq === 11 && f.controls.stimulate === null);
    await post([], { seq: 12, controls: { ...control(null), blindLeft: true } });
    await until(f => f.inputSeq === 12 && f.controls.blindLeft);
    // A missed pointer-up or disconnected browser must not leave current injected.
    await post([], { seq: 13, controls: control({ index: 0, current: 0.75 }) });
    await until(f => f.inputSeq === 13 && f.controls.stimulate !== null);
    await until(f => f.inputSeq === 13 && f.controls.stimulate === null);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
