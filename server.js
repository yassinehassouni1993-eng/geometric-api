require('dotenv').config();
const express = require('express');
const app  = express();
const PORT = process.env.PORT || 3001;

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_BASE  = 'https://api.apify.com/v2';

// Two actors to try in order — fall back if one fails
const ACTORS = [
  'zhorex~perplexity-ai-scraper',
  'scraping_samurai~perplexity-ai-instant-response-actor'
];

// ── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.json({ status: 'GEO metric API running' }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Single query — async poll pattern ─────────────────────────────────────
app.post('/scan/query', async (req, res) => {
  const { query, brandName } = req.body || {};
  if (!query)       return res.status(400).json({ error: 'query is required' });
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  for (const actor of ACTORS) {
    try {
      const result = await runActor(actor, query, brandName);
      if (result) return res.json(result);
    } catch(err) {
      console.error(`Actor ${actor} failed:`, err.message);
    }
  }

  // All actors failed — return graceful empty result so scan continues
  return res.json({
    query,
    answer:    '',
    cited:     false,
    sources:   [],
    sentiment: 'neutral',
    error:     'Could not retrieve Perplexity answer'
  });
});

// ── Run actor + poll for result ────────────────────────────────────────────
async function runActor(actorId, query, brandName) {
  // 1. Start run (async)
  const startRes = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildInput(actorId, query, brandName))
    }
  );

  if (!startRes.ok) {
    const t = await startRes.text();
    throw new Error(`Failed to start ${actorId}: ${startRes.status} ${t.slice(0,200)}`);
  }

  const startData = await startRes.json();
  const runId     = startData?.data?.id;
  if (!runId) throw new Error('No run ID returned');

  console.log(`Run started: ${runId} | ${actorId} | "${query.slice(0,40)}"`);

  // 2. Poll until SUCCEEDED or failed (max 3 min, every 5s)
  let status = 'RUNNING';
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const poll = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!poll.ok) continue;
    status = (await poll.json())?.data?.status;
    console.log(`  poll ${i+1}: ${status}`);
    if (status === 'SUCCEEDED') break;
    if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) throw new Error(`Run ${status}`);
  }

  if (status !== 'SUCCEEDED') throw new Error(`Run did not succeed (${status})`);

  // 3. Fetch dataset items
  const runData   = await (await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
  const datasetId = runData?.data?.defaultDatasetId;
  const itemsRes  = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
  if (!itemsRes.ok) throw new Error('Failed to fetch dataset');

  const items = await itemsRes.json();
  const item  = Array.isArray(items) ? items[0] : items;
  if (!item)  throw new Error('Empty dataset');

  const answer = item.answer || item.text || item.response || item.output || '';
  return {
    query,
    answer,
    cited:     item.isBrandMentioned ?? containsBrand(answer, brandName),
    sources:   item.sources || item.citations || [],
    sentiment: guessSentiment(answer, brandName)
  };
}

function buildInput(actorId, query, brandName) {
  if (actorId.includes('instant-response')) {
    return { startQuery: query, cleanText: true };
  }
  return { queries: [query], mode: 'brand_monitor', brandName: brandName || '', maxResults: 1 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function containsBrand(text, brand) {
  if (!brand || !text) return false;
  return new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
}

function guessSentiment(text, brand) {
  if (!text || !brand) return 'neutral';
  const lower = text.toLowerCase();
  const bl    = brand.toLowerCase();
  if (!lower.includes(bl)) return 'not_mentioned';
  const idx = lower.indexOf(bl);
  const win = lower.slice(Math.max(0, idx - 120), idx + 240);
  const pos = ['great','excellent','best','top','recommend','popular','leading','trusted','quality','innovative','renowned','premium','durable','comfortable'].filter(w => win.includes(w)).length;
  const neg = ['avoid','poor','worst','bad','scam','overpriced','unreliable','disappointing','issues','problems'].filter(w => win.includes(w)).length;
  return pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
}

app.listen(PORT, () => console.log(`GEO metric proxy running on :${PORT}`));
