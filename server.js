const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { stmtUp, stmtKey, stmtLog, logRequest } = require('./db');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/admin/static', express.static(path.join(__dirname, 'public')));

// ---- config ----
const PORT = process.env.PORT || 3000;
// Default admin password (override on Railway via ADMIN_PASSWORD env var)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sk7$mP2!nQ9xR4vL';
const ADMIN_TOKEN = process.env.ADMIN_PASSWORD || 'Sk7$mP2!nQ9xR4vL';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // optional, for display

// ponytail: round-robin counter in memory, resets on restart. Fine for self-use.
const rrCounters = {};

// ---- admin auth ----
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: { message: 'unauthorized' } });
  next();
}

// ---- helpers ----
function genKey() {
  return 'sk-selfapi-' + crypto.randomBytes(24).toString('hex');
}

function normalizeBase(u) {
  let b = (u.base_url || '').trim().replace(/\/+$/, '');
  // tolerate users pasting the /v1 suffix
  b = b.replace(/\/v1\/?$/, '');
  return b + '/v1';
}

async function fetchUpstreamModels(upstream) {
  const base = normalizeBase(upstream);
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${upstream.api_key}` },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const list = Array.isArray(data) ? data : (data.data || data.models || []);
  return list.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
}

// ============ admin: login (no-op verify, just echo token back) ============
app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: { message: 'invalid password' } });
  res.json({ token: ADMIN_TOKEN });
});

// ============ admin: upstreams ============
app.get('/admin/upstreams', adminAuth, (req, res) => {
  const list = stmtUp.list.all().map(u => ({
    ...u,
    enabled: !!u.enabled,
    models: stmtUp.models.all(u.id).map(r => r.model_id),
  }));
  res.json(list);
});

app.post('/admin/upstreams', adminAuth, async (req, res) => {
  const { name, base_url, api_key, enabled = true } = req.body || {};
  if (!name || !base_url || !api_key) return res.status(400).json({ error: { message: 'name, base_url, api_key required' } });
  const info = stmtUp.insert.run(name, base_url, api_key, enabled ? 1 : 0);
  const upstream = stmtUp.get.get(info.lastInsertRowid);
  // auto-fetch models on add
  try {
    const models = await fetchUpstreamModels(upstream);
    stmtUp.setModels(upstream.id, models);
    return res.json({ ...upstream, enabled: !!upstream.enabled, models });
  } catch (e) {
    return res.status(201).json({ ...upstream, enabled: !!upstream.enabled, models: [], fetch_error: e.message });
  }
});

app.put('/admin/upstreams/:id', adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  const cur = stmtUp.get.get(id);
  if (!cur) return res.status(404).json({ error: { message: 'not found' } });
  const { name, base_url, api_key, enabled } = req.body || {};
  stmtUp.update.run(
    name ?? cur.name,
    base_url ?? cur.base_url,
    api_key ?? cur.api_key,
    enabled === undefined ? cur.enabled : (enabled ? 1 : 0),
    id
  );
  res.json({ ...stmtUp.get.get(id), enabled: !!stmtUp.get.get(id).enabled });
});

app.delete('/admin/upstreams/:id', adminAuth, (req, res) => {
  stmtUp.del.run(Number(req.params.id));
  res.json({ ok: true });
});

// refresh models for an upstream
app.post('/admin/upstreams/:id/refresh', adminAuth, async (req, res) => {
  const upstream = stmtUp.get.get(Number(req.params.id));
  if (!upstream) return res.status(404).json({ error: { message: 'not found' } });
  try {
    const models = await fetchUpstreamModels(upstream);
    stmtUp.setModels(upstream.id, models);
    res.json({ upstream_id: upstream.id, models });
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

// ============ admin: aggregated models view ============
app.get('/admin/models', adminAuth, (req, res) => {
  const rows = stmtUp.allModelsWithUpstreams.all();
  const map = new Map();
  for (const r of rows) {
    if (!r.enabled) continue;
    if (!map.has(r.model_id)) map.set(r.model_id, []);
    map.get(r.model_id).push({ upstream_id: r.upstream_id, upstream_name: r.upstream_name });
  }
  res.json([...map.entries()].map(([model, upstreams]) => ({ model, upstreams })));
});

// ============ admin: api keys ============
app.get('/admin/keys', adminAuth, (req, res) => {
  res.json(stmtKey.list.all().map(k => ({ ...k, enabled: !!k.enabled })));
});

app.post('/admin/keys', adminAuth, (req, res) => {
  const { name } = req.body || {};
  const key = genKey();
  stmtKey.insert.run(key, name || 'default');
  res.json({ key, name: name || 'default', enabled: true });
});

app.delete('/admin/keys/:id', adminAuth, (req, res) => {
  stmtKey.del.run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/admin/keys/:id/toggle', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const k = stmtKey.list.all().find(x => x.id === id);
  if (!k) return res.status(404).json({ error: { message: 'not found' } });
  stmtKey.toggle.run(k.enabled ? 0 : 1, id);
  res.json({ ok: true });
});

// ============ admin: logs & stats ============
app.get('/admin/logs', adminAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(stmtLog.recent.all(limit));
});

app.get('/admin/stats', adminAuth, (req, res) => {
  res.json(stmtLog.stats.get() || {});
});

app.get('/admin/info', adminAuth, (req, res) => {
  res.json({
    public_base_url: PUBLIC_BASE_URL || `http://localhost:${PORT}`,
    downstream_base: PUBLIC_BASE_URL || `http://localhost:${PORT}`,
    openai_endpoint: (PUBLIC_BASE_URL || `http://localhost:${PORT}`) + '/v1',
  });
});

// root -> admin panel
app.get('/', (req, res) => res.redirect('/admin/static/index.html'));

// ============ downstream auth ============
function downstreamAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const k = token ? stmtKey.get.get(token) : null;
  if (!k) return res.status(401).json({ error: { message: 'invalid api key' } });
  req.apiKey = k;
  next();
}

// ============ OpenAI-compatible: /v1/models ============
app.get('/v1/models', downstreamAuth, (req, res) => {
  const rows = stmtUp.allModelsWithUpstreams.all();
  const seen = new Set();
  const data = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    if (seen.has(r.model_id)) continue;
    seen.add(r.model_id);
    data.push({ id: r.model_id, object: 'model', owned_by: r.upstream_name });
  }
  res.json({ object: 'list', data });
});

// ============ OpenAI-compatible: /v1/chat/completions (with rotation) ============
app.post('/v1/chat/completions', downstreamAuth, async (req, res) => {
  const body = req.body || {};
  const model = body.model;
  const stream = !!body.stream;
  if (!model) return res.status(400).json({ error: { message: 'model is required' } });

  const upstreams = stmtUp.upstreamsForModel.all(model);
  if (!upstreams.length) {
    return res.status(404).json({ error: { message: `model '${model}' not available. GET /v1/models for the list.` } });
  }

  // round-robin starting index
  const startIdx = (rrCounters[model] || 0) % upstreams.length;
  rrCounters[model] = (rrCounters[model] + 1) % upstreams.length;

  const failures = [];
  for (let i = 0; i < upstreams.length; i++) {
    const idx = (startIdx + i) % upstreams.length;
    const up = upstreams[idx];
    const base = normalizeBase(up);
    const t0 = Date.now();

    try {
      const upstreamRes = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${up.api_key}`,
        },
        body: JSON.stringify(body),
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        const errMsg = `HTTP ${upstreamRes.status}: ${errText.slice(0, 300)}`;
        failures.push({ upstream: up.name, error: errMsg });
        logRequest({
          apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name,
          model, upstream: up, status: 'error',
          latencyMs: Date.now() - t0, error: errMsg,
        });
        continue; // try next upstream, downstream sees nothing yet
      }

      // success path
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const reader = upstreamRes.body.getReader();
        let firstChunk = true;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstChunk) { firstChunk = false; }
            res.write(value);
          }
          res.end();
          logRequest({
            apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name,
            model, upstream: up, status: 'success',
            latencyMs: Date.now() - t0,
          });
        } catch (streamErr) {
          // stream broke mid-flight; cannot retry transparently. End cleanly if possible.
          logRequest({
            apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name,
            model, upstream: up, status: 'error',
            latencyMs: Date.now() - t0, error: 'stream broken: ' + streamErr.message,
          });
          try { res.end(); } catch (_) {}
        }
        return;
      }

      // non-stream: parse and forward
      const data = await upstreamRes.json();
      res.json(data);
      logRequest({
        apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name,
        model, upstream: up, status: 'success',
        latencyMs: Date.now() - t0,
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      });
      return;
    } catch (e) {
      failures.push({ upstream: up.name, error: e.message });
      logRequest({
        apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name,
        model, upstream: up, status: 'error',
        latencyMs: Date.now() - t0, error: e.message,
      });
      continue;
    }
  }

  // all upstreams failed
  res.status(502).json({
    error: {
      message: `all upstreams failed for model '${model}'`,
      type: 'upstream_rotation_exhausted',
      failures,
    },
  });
});

// ============ OpenAI-compatible: /v1/embeddings (best-effort rotation) ============
app.post('/v1/embeddings', downstreamAuth, async (req, res) => {
  const body = req.body || {};
  const model = body.model;
  if (!model) return res.status(400).json({ error: { message: 'model is required' } });
  const upstreams = stmtUp.upstreamsForModel.all(model);
  if (!upstreams.length) return res.status(404).json({ error: { message: `model '${model}' not available` } });

  const startIdx = (rrCounters[model] || 0) % upstreams.length;
  rrCounters[model] = (rrCounters[model] + 1) % upstreams.length;

  for (let i = 0; i < upstreams.length; i++) {
    const up = upstreams[(startIdx + i) % upstreams.length];
    const t0 = Date.now();
    try {
      const r = await fetch(`${normalizeBase(up)}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${up.api_key}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        logRequest({ apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name, model, upstream: up, status: 'error', latencyMs: Date.now() - t0, error: `HTTP ${r.status}: ${t.slice(0,200)}` });
        continue;
      }
      const data = await r.json();
      res.json(data);
      logRequest({ apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name, model, upstream: up, status: 'success', latencyMs: Date.now() - t0, promptTokens: data.usage?.prompt_tokens ?? null });
      return;
    } catch (e) {
      logRequest({ apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name, model, upstream: up, status: 'error', latencyMs: Date.now() - t0, error: e.message });
      continue;
    }
  }
  res.status(502).json({ error: { message: `all upstreams failed for model '${model}'` } });
});

app.listen(PORT, () => {
  console.log(`selfapi listening on :${PORT}`);
  console.log(`admin panel: http://localhost:${PORT}/`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`\n[!] Using default admin password. Set ADMIN_PASSWORD env var on Railway!\n    default: ${ADMIN_PASSWORD}\n`);
  }
});
