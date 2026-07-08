require('dotenv').config();
const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DB pool ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// ── Schema bootstrap (runs once on startup) ───────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cerf_sms_config (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log('[DB] Schema ready');
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/config
 * Returns all shared config: instances, payloads, customApis, instVars, hiddenApis
 */
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM cerf_sms_config WHERE key = ANY($1)`,
      [['ci', 'cp', 'cc', 'cv', 'ch']]
    );
    const m = {};
    result.rows.forEach(r => { m[r.key] = r.value; });

    res.json({
      instances:  JSON.parse(m['ci'] || '[]'),
      payloads:   JSON.parse(m['cp'] || '{}'),
      customApis: JSON.parse(m['cc'] || '{}'),
      instVars:   JSON.parse(m['cv'] || '{}'),
      hiddenApis: JSON.parse(m['ch'] || '{}'),
    });
  } catch (err) {
    console.error('[GET /api/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config
 * Body: { instances, payloads, customApis, instVars, hiddenApis }
 * Upserts all keys atomically in a single transaction.
 */
app.post('/api/config', async (req, res) => {
  const { instances, payloads, customApis, instVars, hiddenApis } = req.body;

  const entries = [
    ['ci', instances],
    ['cp', payloads],
    ['cc', customApis],
    ['cv', instVars],
    ['ch', hiddenApis],
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of entries) {
      await client.query(
        `INSERT INTO cerf_sms_config (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [k, JSON.stringify(v)]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /api/config]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/health
 * Quick DB connectivity check.
 */
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS ts');
    res.json({ ok: true, db: 'connected', ts: rows[0].ts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CERF SMS Sanity Runner  →  http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB init failed]', err.message);
    process.exit(1);
  });
