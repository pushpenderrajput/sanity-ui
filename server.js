require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

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
    // Create proper relational tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS instances (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        url        TEXT NOT NULL,
        token      TEXT DEFAULT '',
        cookie     TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS custom_apis (
        id         TEXT PRIMARY KEY,
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
        key        TEXT NOT NULL,
        value      TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (inst_id, key)
      );

      CREATE TABLE IF NOT EXISTS hidden_apis (
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        api_id     TEXT NOT NULL,
        PRIMARY KEY (inst_id, api_id)
      );

      CREATE TABLE IF NOT EXISTS api_payloads (
        inst_id    TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        api_id     TEXT NOT NULL,
        payload    TEXT,
        updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (inst_id, api_id)
      );
    `);

    // ── One-time migration from old blob table (if it exists and new tables are empty) ──
    const { rows: legacyCheck } = await client.query(`
      SELECT to_regclass('public.cerf_sms_config') AS tbl
    `);
    if (legacyCheck[0].tbl) {
      const { rows: instCount } = await client.query('SELECT COUNT(*) FROM instances');
      if (parseInt(instCount[0].count) === 0) {
        const { rows: legacy } = await client.query(
          "SELECT key, value FROM cerf_sms_config WHERE key = ANY($1)",
          [['ci','cp','cc','cv','ch']]
        );
        if (legacy.length > 0) {
          console.log('[DB] Migrating data from legacy blob table…');
          const m = {};
          legacy.forEach(r => { m[r.key] = r.value; });
          const oldInsts   = JSON.parse(m['ci'] || '[]');
          const oldApis    = JSON.parse(m['cc'] || '{}');
          const oldVars    = JSON.parse(m['cv'] || '{}');
          const oldHidden  = JSON.parse(m['ch'] || '{}');
          const oldPayloads= JSON.parse(m['cp'] || '{}');

          for (const inst of oldInsts) {
            await client.query(
              `INSERT INTO instances (id,name,url,token,cookie) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [inst.id, inst.name, inst.url, inst.token||'', inst.cookie||'']
            );
          }
          for (const [instId, apis] of Object.entries(oldApis)) {
            for (let i=0; i<apis.length; i++) {
              const a = apis[i];
              await client.query(
                `INSERT INTO custom_apis (id,inst_id,label,method,path,payload,channel,sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                [a.id, instId, a.label, a.method||'POST', a.path,
                 JSON.stringify(a.payload||{}), a.channel||'sms', i]
              );
            }
          }
          for (const [instId, vars] of Object.entries(oldVars)) {
            for (const [k,v] of Object.entries(vars)) {
              await client.query(
                `INSERT INTO inst_vars (inst_id,key,value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [instId, k, v||'']
              );
            }
          }
          for (const [instId, apiIds] of Object.entries(oldHidden)) {
            for (const apiId of apiIds) {
              await client.query(
                `INSERT INTO hidden_apis (inst_id,api_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                [instId, apiId]
              );
            }
          }
          for (const [key, payload] of Object.entries(oldPayloads)) {
            const under = key.indexOf('_');
            if (under < 0) continue;
            const instId = key.slice(0, under);
            const apiId  = key.slice(under + 1);
            await client.query(
              `INSERT INTO api_payloads (inst_id,api_id,payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [instId, apiId, payload]
            );
          }
          console.log('[DB] Migration complete');
        }
      }
    }

    console.log('[DB] Schema ready');
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/config/version ───────────────────────────────────────────────────
// Returns the latest updated_at across all tables — used for polling.
app.get('/api/config/version', async (req, res) => {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config ───────────────────────────────────────────────────────────
// Returns all shared config — same shape the frontend expects.
app.get('/api/config', async (req, res) => {
  try {
    const [instR, apiR, varR, hidR, payR] = await Promise.all([
      pool.query('SELECT * FROM instances ORDER BY updated_at'),
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
      payloads[r.inst_id + '_' + r.api_id] = r.payload;
    });

    res.json({ instances, customApis, instVars, hiddenApis, payloads });
  } catch (err) {
    console.error('[GET /api/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/config ──────────────────────────────────────────────────────────
// Syncs entire state — upserts new/changed rows, deletes removed rows.
app.post('/api/config', async (req, res) => {
  const {
    instances  = [],
    customApis = {},
    instVars   = {},
    hiddenApis = {},
    payloads   = {},
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Instances ────────────────────────────────────────────────────────────
    const instIds = instances.map(i => i.id);
    for (const inst of instances) {
      await client.query(
        `INSERT INTO instances (id, name, url, token, cookie, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE
           SET name=$2, url=$3, token=$4, cookie=$5, updated_at=now()`,
        [inst.id, inst.name, inst.url, inst.token||'', inst.cookie||'']
      );
    }
    // Delete instances no longer in the list
    if (instIds.length > 0) {
      await client.query(`DELETE FROM instances WHERE id <> ALL($1)`, [instIds]);
    } else {
      await client.query(`DELETE FROM instances`);
    }

    // ── Custom APIs ───────────────────────────────────────────────────────────
    const allApiIds = [];
    for (const [instId, apis] of Object.entries(customApis)) {
      for (let i = 0; i < apis.length; i++) {
        const a = apis[i];
        allApiIds.push(a.id);
        await client.query(
          `INSERT INTO custom_apis (id, inst_id, label, method, path, payload, channel, sort_order, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (id) DO UPDATE
             SET label=$3, method=$4, path=$5, payload=$6, channel=$7, sort_order=$8, updated_at=now()`,
          [a.id, instId, a.label, a.method||'POST', a.path,
           JSON.stringify(a.payload||{}), a.channel||'sms', i]
        );
      }
    }
    if (allApiIds.length > 0) {
      await client.query(`DELETE FROM custom_apis WHERE id <> ALL($1)`, [allApiIds]);
    } else {
      await client.query(`DELETE FROM custom_apis`);
    }

    // ── Instance variables ────────────────────────────────────────────────────
    // Replace per-instance (safe: only touches rows for instances in this save)
    for (const instId of instIds) {
      await client.query(`DELETE FROM inst_vars WHERE inst_id = $1`, [instId]);
      const vars = instVars[instId] || {};
      for (const [key, value] of Object.entries(vars)) {
        await client.query(
          `INSERT INTO inst_vars (inst_id, key, value, updated_at) VALUES ($1,$2,$3, now())`,
          [instId, key, value||'']
        );
      }
    }

    // ── Hidden APIs ───────────────────────────────────────────────────────────
    for (const instId of instIds) {
      await client.query(`DELETE FROM hidden_apis WHERE inst_id = $1`, [instId]);
      for (const apiId of (hiddenApis[instId] || [])) {
        await client.query(
          `INSERT INTO hidden_apis (inst_id, api_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [instId, apiId]
        );
      }
    }

    // ── Payload overrides ─────────────────────────────────────────────────────
    for (const [key, payload] of Object.entries(payloads)) {
      const under  = key.indexOf('_');
      if (under < 0) continue;
      const instId = key.slice(0, under);
      const apiId  = key.slice(under + 1);
      await client.query(
        `INSERT INTO api_payloads (inst_id, api_id, payload, updated_at)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (inst_id, api_id) DO UPDATE SET payload=$3, updated_at=now()`,
        [instId, apiId, payload]
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

// ── POST /api/proxy ───────────────────────────────────────────────────────────
// Forwards API calls server-side — bypasses browser CORS restrictions.
app.post('/api/proxy', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const t0 = Date.now();
  try {
    const opts = { method, headers };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const r   = await fetch(url, opts);
    const txt = await r.text();
    res.json({ status: r.status, ok: r.ok, body: txt, time: Date.now() - t0 });
  } catch (err) {
    console.error('[POST /api/proxy]', err.message, '→', url);
    res.status(502).json({ error: err.message, time: Date.now() - t0 });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
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
      console.log(`CERF API Sanity Runner  →  http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB init failed]', err.message);
    process.exit(1);
  });
