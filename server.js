require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3001;

/* ════════════════════════════════════════════════
   CONFIG — edit this block to switch Apify actors
   ════════════════════════════════════════════════ */
const ACTOR_ID = 'dltik~geo-brand-sentiment';

function buildActorInput(body) {
  return {
    brand:       body.brand       || '',
    industry:    body.industry    || '',
    competitors: body.competitors || []
  };
}
/* ════════════════════════════════════════════════
   END CONFIG — no need to edit below this line
   ════════════════════════════════════════════════ */

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_BASE  = 'https://api.apify.com/v2';

// ── CORS ───────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Serve frontend ─────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'geometric-app-apify.html'));
});
app.get('/health', (req, res) => res.json({ ok: true, actor: ACTOR_ID, ts: Date.now() }));

// ── STEP 1: Start the actor run, return runId immediately ──
app.post('/scan/start', async (req, res) => {
  if (!req.body?.brand) return res.status(400).json({ error: 'brand is required' });
  if (!APIFY_TOKEN)     return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  try {
    const startRes = await fetch(
      `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildActorInput(req.body))
      }
    );

    if (!startRes.ok) {
      const t = await startRes.text();
      throw new Error(`Failed to start actor: ${startRes.status} — ${t.slice(0, 200)}`);
    }

    const data  = await startRes.json();
    const runId = data?.data?.id;
    if (!runId) throw new Error('No run ID returned from Apify');

    console.log(`Run started | actor: ${ACTOR_ID} | runId: ${runId} | brand: ${req.body.brand}`);
    res.json({ runId, status: 'RUNNING' });

  } catch (err) {
    console.error('Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STEP 2: Poll run status ─────────────────────
app.get('/scan/status/:runId', async (req, res) => {
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  try {
    const poll = await fetch(`${APIFY_BASE}/actor-runs/${req.params.runId}?token=${APIFY_TOKEN}`);
    if (!poll.ok) throw new Error(`Apify status check failed: ${poll.status}`);

    const data   = await poll.json();
    const status = data?.data?.status;
    console.log(`Status check | runId: ${req.params.runId} | status: ${status}`);
    res.json({ status });

  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STEP 3: Fetch results once SUCCEEDED ───────
app.get('/scan/result/:runId', async (req, res) => {
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  try {
    const runData   = await (await fetch(`${APIFY_BASE}/actor-runs/${req.params.runId}?token=${APIFY_TOKEN}`)).json();
    const datasetId = runData?.data?.defaultDatasetId;
    if (!datasetId) throw new Error('No dataset ID found for this run');

    const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
    if (!itemsRes.ok) throw new Error('Failed to fetch dataset');

    const items = await itemsRes.json();
    const item  = Array.isArray(items) ? items[0] : items;
    if (!item)  throw new Error('Actor returned empty dataset');

    console.log(`Results fetched | runId: ${req.params.runId} | keys: ${Object.keys(item).join(', ')}`);
    res.json(item);

  } catch (err) {
    console.error('Result error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`GEO metric proxy running on :${PORT} | actor: ${ACTOR_ID}`));
