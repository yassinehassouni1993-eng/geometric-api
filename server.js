require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3001;

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_BASE  = 'https://api.apify.com/v2';
const ACTOR       = 'dltik~geo-brand-sentiment';

// ── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Serve frontend ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'geometric-app-apify.html'));
});
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Main scan endpoint ─────────────────────────────────────────────────────
// POST /scan
// Body: { brand, industry, competitors: [] }
app.post('/scan', async (req, res) => {
  const { brand, industry, competitors } = req.body || {};
  if (!brand)       return res.status(400).json({ error: 'brand is required' });
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  try {
    // 1. Start the actor run
    const startRes = await fetch(
      `${APIFY_BASE}/acts/${ACTOR}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          industry:    industry    || '',
          competitors: competitors || []
        })
      }
    );

    if (!startRes.ok) {
      const t = await startRes.text();
      throw new Error(`Failed to start actor: ${startRes.status} ${t.slice(0, 200)}`);
    }

    const runId = (await startRes.json())?.data?.id;
    if (!runId) throw new Error('No run ID returned from Apify');
    console.log(`Run started: ${runId} | brand: ${brand}`);

    // 2. Poll until done (every 8s, max 10 min)
    let status = 'RUNNING';
    for (let i = 0; i < 75; i++) {
      await sleep(8000);
      const poll = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      if (!poll.ok) continue;
      status = (await poll.json())?.data?.status;
      console.log(`  poll ${i + 1}: ${status}`);
      if (status === 'SUCCEEDED') break;
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Actor run ${status}`);
    }

    if (status !== 'SUCCEEDED') throw new Error(`Actor did not finish in time (${status})`);

    // 3. Fetch dataset items
    const runData   = await (await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
    const datasetId = runData?.data?.defaultDatasetId;
    const itemsRes  = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
    if (!itemsRes.ok) throw new Error('Failed to fetch dataset');

    const items = await itemsRes.json();
    const item  = Array.isArray(items) ? items[0] : items;
    if (!item)  throw new Error('Empty dataset — actor returned no results');

    console.log('Result keys:', Object.keys(item));
    res.json(item);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`GEO metric proxy running on :${PORT}`));
