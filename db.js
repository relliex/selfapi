const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ponytail: auto-detect persistent storage. Railway injects RAILWAY_VOLUME_MOUNT_PATH
// when a volume is attached; otherwise probe /data; else fall back to local ./data
const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'selfapi.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS upstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upstream_models (
  upstream_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (upstream_id, model_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER,
  api_key_name TEXT,
  model TEXT,
  upstream_id INTEGER,
  upstream_name TEXT,
  status TEXT,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  input_body TEXT,
  output_body TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ponytail: lightweight migration for pre-existing DBs (ALTER ADD COLUMN is idempotent via try/catch)
for (const [col, def] of [['total_tokens','INTEGER'],['input_body','TEXT'],['output_body','TEXT']]) {
  try { db.exec(`ALTER TABLE logs ADD COLUMN ${col} ${def}`); } catch (_) {}
}

// upstreams
const stmtUp = {
  list: db.prepare('SELECT * FROM upstreams ORDER BY id'),
  get: db.prepare('SELECT * FROM upstreams WHERE id = ?'),
  insert: db.prepare('INSERT INTO upstreams (name, base_url, api_key, enabled) VALUES (?,?,?,?)'),
  update: db.prepare('UPDATE upstreams SET name=?, base_url=?, api_key=?, enabled=? WHERE id=?'),
  del: db.prepare('DELETE FROM upstreams WHERE id=?'),
  setModels: db.transaction((upstreamId, models) => {
    db.prepare('DELETE FROM upstream_models WHERE upstream_id=?').run(upstreamId);
    const ins = db.prepare('INSERT OR IGNORE INTO upstream_models (upstream_id, model_id) VALUES (?,?)');
    for (const m of models) ins.run(upstreamId, m);
  }),
  models: db.prepare('SELECT model_id FROM upstream_models WHERE upstream_id=? ORDER BY model_id'),
  upstreamsForModel: db.prepare(`
    SELECT u.* FROM upstreams u
    JOIN upstream_models m ON m.upstream_id = u.id
    WHERE u.enabled=1 AND m.model_id=?
    ORDER BY u.id
  `),
  allModelsWithUpstreams: db.prepare(`
    SELECT m.model_id, u.id AS upstream_id, u.name AS upstream_name, u.enabled
    FROM upstream_models m
    JOIN upstreams u ON u.id = m.upstream_id
    ORDER BY m.model_id, u.id
  `),
};

const stmtKey = {
  list: db.prepare('SELECT * FROM api_keys ORDER BY id DESC'),
  get: db.prepare('SELECT * FROM api_keys WHERE `key`=? AND enabled=1'),
  insert: db.prepare('INSERT INTO api_keys (`key`, name) VALUES (?,?)'),
  del: db.prepare('DELETE FROM api_keys WHERE id=?'),
  toggle: db.prepare('UPDATE api_keys SET enabled=? WHERE id=?'),
};

const stmtLog = {
  insert: db.prepare(`INSERT INTO logs
    (api_key_id, api_key_name, model, upstream_id, upstream_name, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, input_body, output_body, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  recent: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?'),
  clear: db.prepare('DELETE FROM logs'),
  stats: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens
    FROM logs
  `),
};

const stmtSet = {
  get: db.prepare('SELECT value FROM settings WHERE key=?'),
  set: db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  all: db.prepare('SELECT * FROM settings'),
};

function settingGet(key, def) {
  const row = stmtSet.get.get(key);
  return row ? row.value : def;
}
function settingSet(key, value) {
  stmtSet.set.run(key, value);
}

function logRequest({ apiKeyId, apiKeyName, model, upstream, status, latencyMs, promptTokens, completionTokens, totalTokens, inputBody, outputBody, error }) {
  const pt = promptTokens ?? null;
  const ct = completionTokens ?? null;
  const tt = totalTokens ?? (pt != null && ct != null ? pt + ct : null);
  stmtLog.insert.run(
    apiKeyId || null, apiKeyName || null, model || null,
    upstream ? upstream.id : null, upstream ? upstream.name : null,
    status, latencyMs ?? null, pt, ct, tt,
    inputBody ?? null, outputBody ?? null, error || null
  );
}

module.exports = { db, stmtUp, stmtKey, stmtLog, stmtSet, settingGet, settingSet, logRequest };
