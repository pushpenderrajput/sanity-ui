require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cerf-dev-secret-change-in-prod';
if (!process.env.JWT_SECRET)
  console.warn('[WARN] JWT_SECRET not set — using insecure default. Set it in .env for production.');

// ── DB pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// ── Schema bootstrap ──────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Core tables — user_id is stored for audit only, never used to filter data
    await client.query(`
      CREATE TABLE IF NOT EXISTS instances (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        token      TEXT DEFAULT '',
        cookie     TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS custom_apis (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        label      TEXT NOT NULL,
        method     TEXT DEFAULT 'POST',
        path       TEXT NOT NULL,
        payload    JSONB DEFAULT '{}',
        channel    TEXT DEFAULT 'sms',
        sort_order INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS inst_vars (
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        user_id    TEXT,
        key        TEXT NOT NULL,
        value      TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (inst_id, key)
      );

      CREATE TABLE IF NOT EXISTS hidden_apis (
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        user_id    TEXT,
        api_id     TEXT NOT NULL,
        PRIMARY KEY (inst_id, api_id)
      );

      CREATE TABLE IF NOT EXISTS api_payloads (
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        user_id    TEXT,
        api_id     TEXT NOT NULL,
        payload    TEXT,
        updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (inst_id, api_id)
      );
    `);

    // Safe migration: add user_id column to pre-existing tables (no-op if already present).
    // Drop the FK constraint if it exists so user_id becomes a plain audit TEXT column.
    for (const tbl of ['instances','custom_apis','inst_vars','hidden_apis','api_payloads']) {
      await client.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS user_id TEXT`);
    }

    console.log('[DB] Schema ready');
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
// Validates the JWT. All data routes are behind this — but data is NOT scoped
// to the user. Login is required to use the tool; data is shared by the team.
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized — please log in' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
  }
}

function newId() { return require('crypto').randomUUID(); }

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id   = newId();
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [id, email.toLowerCase().trim(), hash]
    );
    const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email, userId: id });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'An account with that email already exists' });
    console.error('[register]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok)    return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, userId: user.id });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/config/version ───────────────────────────────────────────────────
// Returns the latest updated_at across ALL shared data — used for team polling.
app.get('/api/config/version', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT GREATEST(
        (SELECT MAX(updated_at) FROM instances),
        (SELECT MAX(updated_at) FROM custom_apis),
        (SELECT MAX(updated_at) FROM inst_vars),
        (SELECT MAX(updated_at) FROM api_payloads)
      ) AS updated_at
    `);
    res.json({ updatedAt: rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/config ───────────────────────────────────────────────────────────
// Returns ALL shared team data — visible to every logged-in user.
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const [instR, apiR, varR, hidR, payR] = await Promise.all([
      pool.query('SELECT * FROM instances   ORDER BY updated_at'),
      pool.query('SELECT * FROM custom_apis ORDER BY inst_id, sort_order, updated_at'),
      pool.query('SELECT * FROM inst_vars'),
      pool.query('SELECT * FROM hidden_apis'),
      pool.query('SELECT * FROM api_payloads'),
    ]);

    const instances = instR.rows.map(r => ({
      id: r.id, name: r.name, url: r.url, token: r.token, cookie: r.cookie,
    }));

    const customApis = {};
    apiR.rows.forEach(r => {
      if (!customApis[r.inst_id]) customApis[r.inst_id] = [];
      customApis[r.inst_id].push({
        id: r.id, label: r.label, method: r.method,
        path: r.path, payload: r.payload, channel: r.channel,
      });
    });

    const instVars = {};
    varR.rows.forEach(r => {
      if (!instVars[r.inst_id]) instVars[r.inst_id] = {};
      instVars[r.inst_id][r.key] = r.value;
    });

    const hiddenApis = {};
    hidR.rows.forEach(r => {
      if (!hiddenApis[r.inst_id]) hiddenApis[r.inst_id] = [];
      hiddenApis[r.inst_id].push(r.api_id);
    });

    const payloads = {};
    payR.rows.forEach(r => {
      payloads[`${r.inst_id}_${r.api_id}`] = r.payload;
    });

    res.json({ instances, customApis, instVars, hiddenApis, payloads });
  } catch (e) {
    console.error('[GET /api/config]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Granular write endpoints — require auth; data is SHARED (no user_id filter).
// user_id is recorded on each row as an audit trail only.
// ═════════════════════════════════════════════════════════════════════════════

// ── Instances ─────────────────────────────────────────────────────────────────
app.post('/api/instances', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { id, name, url, token = '', cookie = '' } = req.body;
  if (!id || !name || !url) return res.status(400).json({ error: 'id, name, url required' });
  try {
    await pool.query(
      `INSERT INTO instances (id, user_id, name, url, token, cookie, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE
         SET user_id=$2, name=$3, url=$4, token=$5, cookie=$6, updated_at=now()`,
      [id, uid, name, url, token, cookie]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/instances/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM instances WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Custom APIs ───────────────────────────────────────────────────────────────
app.post('/api/apis', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { id, instId, label, method = 'POST', path: apiPath, payload = {}, channel = 'sms', sortOrder = 0 } = req.body;
  if (!id || !instId || !label || !apiPath) return res.status(400).json({ error: 'id, instId, label, path required' });
  try {
    await pool.query(
      `INSERT INTO custom_apis (id, user_id, inst_id, label, method, path, payload, channel, sort_order, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (id) DO UPDATE
         SET user_id=$2, label=$4, method=$5, path=$6, payload=$7, channel=$8, sort_order=$9, updated_at=now()`,
      [id, uid, instId, label, method, apiPath, JSON.stringify(payload), channel, sortOrder]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/apis/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM custom_apis WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Variables ─────────────────────────────────────────────────────────────────
app.post('/api/variables', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { instId, key, value = '' } = req.body;
  if (!instId || !key) return res.status(400).json({ error: 'instId and key required' });
  try {
    await pool.query(
      `INSERT INTO inst_vars (inst_id, user_id, key, value, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (inst_id, key) DO UPDATE SET user_id=$2, value=$4, updated_at=now()`,
      [instId, uid, key, value]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/variables/:instId/:key', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM inst_vars WHERE inst_id=$1 AND key=$2',
      [req.params.instId, decodeURIComponent(req.params.key)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/variables/:instId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM inst_vars WHERE inst_id=$1', [req.params.instId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Payloads ──────────────────────────────────────────────────────────────────
app.post('/api/payloads', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { instId, apiId, payload } = req.body;
  if (!instId || !apiId) return res.status(400).json({ error: 'instId and apiId required' });
  try {
    await pool.query(
      `INSERT INTO api_payloads (inst_id, user_id, api_id, payload, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (inst_id, api_id) DO UPDATE SET user_id=$2, payload=$4, updated_at=now()`,
      [instId, uid, apiId, payload ?? '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/payloads/:instId/:apiId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM api_payloads WHERE inst_id=$1 AND api_id=$2',
      [req.params.instId, req.params.apiId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hidden APIs ───────────────────────────────────────────────────────────────
app.post('/api/hidden', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { instId, apiId } = req.body;
  if (!instId || !apiId) return res.status(400).json({ error: 'instId and apiId required' });
  try {
    await pool.query(
      `INSERT INTO hidden_apis (inst_id, user_id, api_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [instId, uid, apiId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/hidden/:instId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM hidden_apis WHERE inst_id=$1', [req.params.instId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/proxy ───────────────────────────────────────────────────────────
// Forwards API calls server-side — bypasses browser CORS. Auth required.
app.post('/api/proxy', requireAuth, async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const t0 = Date.now();
  try {
    const opts = { method, headers };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD')
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const r   = await fetch(url, opts);
    const txt = await r.text();
    res.json({ status: r.status, ok: r.ok, body: txt, time: Date.now() - t0 });
  } catch (e) {
    console.error('[POST /api/proxy]', e.message, '→', url);
    res.status(502).json({ error: e.message, time: Date.now() - t0 });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS ts');
    res.json({ ok: true, db: 'connected', ts: rows[0].ts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CERF API Sanity Runner  →  http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB init failed]', err.message);
    process.exit(1);
  });
