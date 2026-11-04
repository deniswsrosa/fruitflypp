'use strict';
// FruitFly++ server — Node 22+, no npm dependencies.
// Streams character typing, neural activity and Couchbase query results.
// Configuration: .env or environment variables (see .env.example).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { handleBrain } = require('./brain-service');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = +(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const CB_QUERY_URL = process.env.CB_QUERY_URL || '';
const CB_USER = process.env.CB_USER || '';
const CB_PASS = process.env.CB_PASS || '';
const CB_TLS_VERIFY = process.env.CB_TLS_VERIFY !== 'false';
const BEAT_MS = 550;
const TOKEN_EVERY_N_BEATS = 2;

const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');

// ---- query charts -----------------------------------------------------------
// A chart is a token list; the SQL is exactly the tokens joined with spaces,
// so whatever the fly "types" is exactly what runs. Placeholder values are
// sampled live from the bucket (see loadScents) so queries always hit data.

const kw = t => ({ t, k: 'kw' });   // keyword -> cyan keys
const id = t => ({ t, k: 'id' });   // identifier/literal -> pink keys

function esc(v) { return String(v).replace(/["\\]/g, ''); } // belt-and-braces; values come from the DB
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function buildCharts(p) {
  return [
    {
      title: 'airport lookup',
      tokens: [
        kw('SELECT'), id('airportname,'), id('city,'), id('faa'),
        kw('FROM'), id('`travel-sample`'),
        kw('WHERE'), id('type'), id('= "airport"'), kw('AND'), id('city'), id(`= "${esc(pick(p.airportCities))}"`),
      ],
    },
    {
      title: 'top airport countries',
      tokens: [
        kw('SELECT'), id('country,'), id('COUNT(*)'), kw('AS'), id('airports'),
        kw('FROM'), id('`travel-sample`'),
        kw('WHERE'), id('type'), id('= "airport"'),
        kw('GROUP'), kw('BY'), id('country'),
        kw('ORDER'), kw('BY'), id('airports'), kw('DESC'), kw('LIMIT'), id('5'),
      ],
    },
    {
      title: 'routes + airline join',
      tokens: [
        kw('SELECT'), id('r.sourceairport,'), id('r.destinationairport,'), id('al.name'), kw('AS'), id('airline'),
        kw('FROM'), id('`travel-sample`'), id('r'),
        kw('JOIN'), id('`travel-sample`'), id('al'), kw('ON'), kw('KEYS'), id('r.airlineid'),
        kw('WHERE'), id('r.type'), id('= "route"'), kw('AND'), id('r.sourceairport'), id(`= "${esc(pick(p.sources))}"`),
        kw('LIMIT'), id('5'),
      ],
    },
    {
      title: 'busiest weekday',
      tokens: [
        kw('SELECT'), id('s.day'), kw('AS'), id('weekday,'), id('COUNT(*)'), kw('AS'), id('flights'),
        kw('FROM'), id('`travel-sample`'), id('r'),
        kw('UNNEST'), id('r.schedule'), id('s'),
        kw('WHERE'), id('r.type'), id('= "route"'),
        kw('GROUP'), kw('BY'), id('s.day'),
        kw('ORDER'), kw('BY'), id('flights'), kw('DESC'),
      ],
    },
    {
      title: 'landmarks to eat at',
      build: p => {
        const pair = pick(p.landmarkPairs);
        return [
          kw('SELECT'), id('name,'), id('activity,'), id('city'),
          kw('FROM'), id('`travel-sample`'),
          kw('WHERE'), id('type'), id('= "landmark"'),
          kw('AND'), id('activity'), id(`= "${esc(pair.activity)}"`),
          kw('AND'), id('city'), id(`= "${esc(pair.city)}"`),
          kw('LIMIT'), id('5'),
        ];
      },
    },
  ];
}

// ---- Couchbase helpers ------------------------------------------------------

// One SQL++ call, with TLS verification enabled by default.
function n1ql(statement) {
  if (!CB_QUERY_URL || !CB_USER || !CB_PASS) {
    return Promise.reject(new Error('Set CB_QUERY_URL, CB_USER and CB_PASS in .env to execute queries.'));
  }
  return new Promise((resolve, reject) => {
    const u = new URL(CB_QUERY_URL);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      rejectUnauthorized: CB_TLS_VERIFY,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CB_USER}:${CB_PASS}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (body.errors) reject(new Error(body.errors.map(e => e.msg).join('; ')));
          else resolve(body.results || []);
        } catch {
          reject(new Error(`bad N1QL response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('N1QL request timed out')); });
    req.write(new URLSearchParams({ statement }).toString());
    req.end();
  });
}

async function loadScents() {
  const fallback = {
    airportCities: ['San Francisco', 'Paris', 'London'],
    sources: ['SFO', 'JFK', 'LHR'],
    landmarkCities: ['Paris', 'London', 'New Orleans'],
    activities: ['eat', 'see', 'drink'],
  };
  try {
    const [cities, sources, lmPairs] = await Promise.all([
      n1ql('SELECT DISTINCT city FROM `travel-sample` WHERE type = "airport" AND city IS NOT NULL'),
      n1ql('SELECT DISTINCT sourceairport FROM `travel-sample` WHERE type = "route"'),
      n1ql('SELECT activity, city FROM `travel-sample` WHERE type = "landmark" AND activity IS NOT NULL AND city IS NOT NULL'),
    ]);
    return {
      airportCities: cities.map(r => r.city).filter(Boolean),
      sources: sources.map(r => r.sourceairport).filter(Boolean),
      landmarkPairs: lmPairs.map(r => ({ activity: r.activity, city: r.city })).filter(p => p.city),
      activities: ['eat', 'see', 'drink', 'do'],
    };
  } catch (e) {
    console.warn(`scent queries failed (${e.message}); using fallback params`);
    return { ...fallback, landmarkPairs: fallback.activities.flatMap(a => fallback.landmarkCities.map(c => ({ activity: a, city: c }))) };
  }
}

async function runQuery(sql) {
  const t0 = Date.now();
  try {
    const rows = await n1ql(sql);
    return { ok: true, rows: rows.slice(0, 25), elapsed_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, elapsed_ms: Date.now() - t0 };
  }
}

// ---- SSE performance --------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function perform(res, scents, opts = {}) {
  const beatMs = Math.min(1200, Math.max(200, opts.beatMs || BEAT_MS));
  const charts = buildCharts(scents);
  const start = opts.startChart != null && charts[opts.startChart]
    ? opts.startChart
    : Math.floor(Math.random() * charts.length);
  for (let i = 0; i < (opts.once ? 1 : charts.length); i++) {
    const chart = charts[(start + i) % charts.length];
    const tokens = chart.build ? chart.build(scents) : chart.tokens;
    const sql = tokens.map(tk => tk.t).join(' ');
    send(res, 'chart', { title: chart.title });
    let typingDelay = beatMs * TOKEN_EVERY_N_BEATS;
    for (const tk of tokens) {
      await sleep(typingDelay);
      if (res.writableEnded) return;
      send(res, 'beat', {});
      send(res, 'token', { text: tk.t, kind: tk.k });
      typingDelay = Math.max(beatMs * TOKEN_EVERY_N_BEATS,
        ([...tk.t].length + 1) * Math.max(240, beatMs / 2) + 100);
    }
    await sleep(typingDelay);
    if (res.writableEnded) return;
    send(res, 'execute', { sql });
    const result = await runQuery(sql);
    if (res.writableEnded) return;
    send(res, 'result', { sql, ...result });
    console.log(`fly executed [${chart.title}] in ${result.elapsed_ms}ms -> ${result.ok ? `${result.rows.length} rows` : 'ERROR: ' + result.error}`);
    if (!opts.once) await sleep(5000);
  }
}

// ---- static + routing --------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
};

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

// any file under public/ or data/, with traversal guard
function staticPath(url) {
  if (url === '/') return path.join(PUB, 'index.html');
  for (const root of [PUB, DATA]) {
    const p = path.normalize(path.join(root, decodeURIComponent(url)));
    if (p.startsWith(root + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

async function main() {
  let scents = await loadScents();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'fruitflypp' }));
      return;
    }
    if (handleBrain(req, res, new URL(req.url, 'http://localhost'))) return;
    const url = req.url.split('?')[0];
    const file = staticPath(url);
    if (file) return serveFile(res, file);
    if (url === '/api/stream') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const bpm = Math.min(1200, Math.max(200, +q.get('bpm') || BEAT_MS));
      const startChart = Number.isInteger(+q.get('chart')) ? +q.get('chart') : null;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      (async () => {
        let first = true;
        while (!res.writableEnded) {
          scents = await loadScents(); // fresh params every round
          const once = q.get('once') === '1';
          await perform(res, scents, { beatMs: bpm, startChart: first ? startChart : null, once });
          if (once) { res.end(); break; }
          first = false;
        }
      })().catch(e => console.warn('stream ended:', e.message));
      req.on('close', () => res.end());
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  server.listen(PORT, HOST, () => {
    console.log(`FruitFly++ demo:  http://${HOST}:${PORT}/`);
    console.log(`Couchbase N1QL: ${CB_QUERY_URL} (user ${CB_USER})`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
