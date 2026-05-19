/**
 * GEO metric — Backend proxy server
 * Routes Apify actor calls and handles CORS
 * 
 * Setup:
 *   npm install express node-fetch cors dotenv
 *   APIFY_TOKEN=your_token node server.js
 * 
 * Deploy: Railway, Render, Fly.io, or any Node host
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const APIFY_TOKEN  = process.env.APIFY_TOKEN || '';
const APIFY_BASE   = 'https://api.apify.com/v2';

// ─── Which Apify actor to use ───────────────────────────────────────────────
// zhorex/perplexity-ai-scraper: scrapes public Perplexity UI, no Perplexity
// API key needed. $0.02/query. Has brand_monitor mode built in.
const PERPLEXITY_ACTOR = 'zhorex~perplexity-ai-scraper';

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Run a single Perplexity query and return result ─────────────────────────
// POST /scan/query
// Body: { query: string, brandName: string }
app.post('/scan/query', async (req, res) => {
  const { query, brandName } = req.body;
  if (!query)     return res.status(400).json({ error: 'query is required' });
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  try {
    const runResp = await fetch(
      `${APIFY_BASE}/acts/${PERPLEXITY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: [query],
          // brand_monitor mode: actor returns isBrandMentioned field
          mode: 'brand_monitor',
          brandName: brandName || '',
          maxResults: 1
        })
      }
    );

    if (!runResp.ok) {
      const err = await runResp.text();
      return res.status(502).json({ error: 'Apify error: ' + err });
    }

    const items = await runResp.json();
    // items is an array of result objects from the dataset
    const item = Array.isArray(items) ? items[0] : items;

    res.json({
      query,
      answer:   item?.answer       || item?.text || '',
      cited:    item?.isBrandMentioned ?? containsBrand(item?.answer || '', brandName),
      sources:  item?.sources      || [],
      sentiment: guessSentiment(item?.answer || '', brandName)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Run multiple queries in one request ─────────────────────────────────────
// POST /scan/batch
// Body: { queries: string[], brandName: string }
app.post('/scan/batch', async (req, res) => {
  const { queries, brandName } = req.body;
  if (!queries || !queries.length) return res.status(400).json({ error: 'queries array is required' });
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured on server' });

  // Run queries sequentially (Apify actor handles batching internally)
  // For production: consider parallel calls with rate limiting
  const results = [];
  for (const query of queries) {
    try {
      const runResp = await fetch(
        `${APIFY_BASE}/acts/${PERPLEXITY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queries: [query],
            mode: 'brand_monitor',
            brandName: brandName || '',
            maxResults: 1
          })
        }
      );
      if (!runResp.ok) throw new Error(await runResp.text());
      const items = await runResp.json();
      const item  = Array.isArray(items) ? items[0] : items;
      results.push({
        query,
        answer:    item?.answer    || item?.text || '',
        cited:     item?.isBrandMentioned ?? containsBrand(item?.answer || '', brandName),
        sources:   item?.sources   || [],
        sentiment: guessSentiment(item?.answer || '', brandName)
      });
    } catch (err) {
      results.push({ query, answer: '', cited: false, sources: [], sentiment: 'neutral', error: err.message });
    }
  }
  res.json({ results });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function containsBrand(text, brand) {
  if (!brand || !text) return false;
  return new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
}

function guessSentiment(text, brand) {
  if (!text || !brand) return 'neutral';
  const lowerText = text.toLowerCase();
  const lowerBrand = brand.toLowerCase();
  const idx = lowerText.indexOf(lowerBrand);
  if (idx === -1) return 'not_mentioned';
  // look at surrounding 200 chars
  const window = lowerText.slice(Math.max(0, idx - 100), idx + 200);
  const pos = ['great','excellent','best','top','recommend','popular','leading','trusted','quality','innovative'].filter(w => window.includes(w)).length;
  const neg = ['avoid','poor','worst','bad','scam','overpriced','unreliable','disappointing','negative','issues'].filter(w => window.includes(w)).length;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

app.listen(PORT, () => console.log(`GEO metric proxy running on :${PORT}`));
