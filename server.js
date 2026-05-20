require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3001;

/* ════════════════════════════════════════════════
   CONFIG — edit this block to change models/queries
   ════════════════════════════════════════════════ */

const MODELS = [
  { id: 'openai/gpt-4o',               name: 'GPT-4o',        provider: 'openai'     },
  { id: 'anthropic/claude-haiku-4-5',  name: 'Claude Haiku',  provider: 'anthropic'  },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini Flash',  provider: 'google'     },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3', provider: 'meta'    },
];

const NUM_QUERIES = 6;

/* ════════════════════════════════════════════════
   END CONFIG
   ════════════════════════════════════════════════ */

const OPENROUTER_KEY  = process.env.OPENROUTER_KEY || '';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'geometric-app-apify.html')));
app.get('/health', (req, res) => res.json({ ok: true, models: MODELS.map(m => m.name), ts: Date.now() }));

// ── Main scan endpoint ─────────────────────────────────────────────────────
// POST /scan
// Body: { brand, industry, competitors[] }
// Returns: full GEO analysis object
app.post('/scan', async (req, res) => {
  const { brand, industry, competitors = [] } = req.body || {};
  if (!brand)          return res.status(400).json({ error: 'brand is required' });
  if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_KEY not configured on server' });

  try {
    console.log(`\n▶ Scan started: "${brand}" | ${industry} | ${MODELS.length} models | ${NUM_QUERIES} queries`);

    // 1. Generate probe queries
    const queries = buildQueries(brand, industry, competitors, NUM_QUERIES);
    console.log(`  Queries: ${queries.map(q => `"${q.slice(0,40)}"`).join(', ')}`);

    // 2. Run all model × query combinations in parallel
    const tasks = [];
    for (const model of MODELS) {
      for (const query of queries) {
        tasks.push(runQuery(model, query, brand));
      }
    }

    console.log(`  Running ${tasks.length} parallel LLM calls…`);
    const raw_responses = await Promise.all(tasks);
    console.log(`  All calls complete.`);

    // 3. Aggregate into GEO analysis
    const result = aggregate(brand, industry, competitors, queries, raw_responses);
    console.log(`  GEO Score: ${result.overall_sentiment.score}/100 | Sentiment: ${result.overall_sentiment.label}`);

    res.json(result);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Build probe queries ────────────────────────────────────────────────────
function buildQueries(brand, industry, competitors, n) {
  const comp = competitors.length ? competitors[0] : null;
  const pool = [
    `Tell me about ${brand} — what do they do and who are they for?`,
    `What are the pros and cons of ${brand}?`,
    `Is ${brand} a good choice in the ${industry} space?`,
    `What are the main criticisms of ${brand}?`,
    `Best brands in the ${industry} industry in 2025`,
    comp ? `${brand} vs ${comp} — which is better?` : `Who are the top competitors of ${brand}?`,
    `What do users say about ${brand}?`,
    `Would you recommend ${brand}? Why or why not?`,
    `What is ${brand} known for in the ${industry} space?`,
    `${brand} honest review — strengths and weaknesses`,
    `Top recommended ${industry} brands and why`,
    `How does ${brand} compare to its competitors?`,
  ];
  return pool.slice(0, n);
}

// ── Run a single model × query call ───────────────────────────────────────
async function runQuery(model, query, brand) {
  const systemPrompt = `You are a knowledgeable AI assistant. Answer the user's question naturally and helpfully.
After your answer, on a new line, output EXACTLY this JSON (no markdown, no extra text):
GEO_META:{"cited":BOOL,"sentiment":"positive"/"neutral"/"negative","positioning":"leader"/"challenger"/"niche"/"unknown","recommendation":"high"/"medium"/"low"/"none","strengths":["..."],"weaknesses":["..."]}
Replace BOOL with true if you mentioned "${brand}" in your answer, false otherwise.`;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://geometric.app',
        'X-Title': 'GEO metric'
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: query }
        ]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  ⚠ ${model.name} | "${query.slice(0,30)}" → ${res.status}: ${err.slice(0,100)}`);
      return makeEmptyResult(model, query, brand);
    }

    const data  = await res.json();
    const text  = data.choices?.[0]?.message?.content || '';
    const parts = text.split('GEO_META:');
    const answer = parts[0].trim();

    let meta = { cited: false, sentiment: 'neutral', positioning: 'unknown', recommendation: 'none', strengths: [], weaknesses: [] };
    if (parts.length >= 2) {
      try { meta = { ...meta, ...JSON.parse(parts[1].trim()) }; } catch(e) {}
    }

    // Fallback: check if brand appears in answer text
    if (!meta.cited) {
      meta.cited = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i').test(answer);
    }

    console.log(`  ✓ ${model.name} | "${query.slice(0,35)}" | cited:${meta.cited} sent:${meta.sentiment}`);
    return {
      prompt:   query,
      llm:      model.provider,
      model:    model.id,
      model_name: model.name,
      response_text: answer,
      overall_sentiment: meta.sentiment,
      confidence: meta.sentiment === 'positive' ? 0.85 : meta.sentiment === 'negative' ? 0.8 : 0.7,
      brand_positioning: meta.positioning,
      recommendation_likelihood: meta.recommendation,
      key_strengths: meta.strengths || [],
      key_weaknesses: meta.weaknesses || [],
      cited: meta.cited,
      vs_competitors: {}
    };

  } catch (err) {
    console.warn(`  ✗ ${model.name} | "${query.slice(0,30)}" → ${err.message}`);
    return makeEmptyResult(model, query, brand);
  }
}

function makeEmptyResult(model, query, brand) {
  return {
    prompt: query, llm: model.provider, model: model.id, model_name: model.name,
    response_text: '', overall_sentiment: 'neutral', confidence: 0,
    brand_positioning: 'unknown', recommendation_likelihood: 'none',
    key_strengths: [], key_weaknesses: [], cited: false, vs_competitors: {}, error: true
  };
}

// ── Aggregate results into GEO analysis ───────────────────────────────────
function aggregate(brand, industry, competitors, queries, responses) {
  const valid = responses.filter(r => !r.error && r.response_text);

  // Per-model sentiment scores
  const perModel = {};
  MODELS.forEach(m => {
    const modelResps = valid.filter(r => r.llm === m.provider);
    if (!modelResps.length) return;
    const avg = sentAvg(modelResps);
    perModel[m.provider] = {
      score: toScore(avg),
      label: avg > 0.2 ? 'positive' : avg < -0.2 ? 'negative' : 'neutral',
      confidence: modelResps.reduce((s,r) => s + (r.confidence||0), 0) / modelResps.length
    };
  });

  // Overall
  const overallAvg   = sentAvg(valid);
  const overallScore = toScore(overallAvg);
  const citationRate = valid.filter(r => r.cited).length / (valid.length || 1);

  // Weighted GEO score: sentiment 50% + citation rate 35% + confidence 15%
  const avgConf = valid.reduce((s,r) => s + (r.confidence||0), 0) / (valid.length||1);
  const geoScore = Math.round(overallScore * 0.5 + citationRate * 100 * 0.35 + avgConf * 100 * 0.15);

  // Aggregate strengths / weaknesses (deduplicated, frequency-sorted)
  const strMap = {}, wkMap = {};
  valid.forEach(r => {
    (r.key_strengths||[]).forEach(s => { strMap[s] = (strMap[s]||0) + 1; });
    (r.key_weaknesses||[]).forEach(w => { wkMap[w] = (wkMap[w]||0) + 1; });
  });
  const key_strengths  = Object.entries(strMap).sort((a,b)=>b[1]-a[1]).map(e=>e[0]).slice(0,8);
  const key_weaknesses = Object.entries(wkMap).sort((a,b)=>b[1]-a[1]).map(e=>e[0]).slice(0,8);

  // Positioning (most common non-unknown)
  const posMap = {};
  valid.forEach(r => { if(r.brand_positioning && r.brand_positioning !== 'unknown') posMap[r.brand_positioning] = (posMap[r.brand_positioning]||0)+1; });
  const brand_positioning = Object.entries(posMap).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'unknown';

  // Recommendation likelihood
  const recMap = { high:3, medium:2, low:1, none:0 };
  const recAvg = valid.reduce((s,r) => s + (recMap[r.recommendation_likelihood]||0), 0) / (valid.length||1);
  const recommendation_likelihood = recAvg >= 2.5 ? 'high' : recAvg >= 1.5 ? 'medium' : recAvg >= 0.5 ? 'low' : 'none';

  // Narrative themes from most common strengths
  const narrative_themes = key_strengths.slice(0, 5);

  // vs_competitors: find comparison responses
  const vs_competitors = {};
  competitors.forEach(comp => {
    const compResps = valid.filter(r => r.prompt.toLowerCase().includes(comp.toLowerCase()));
    if (!compResps.length) return;
    const wins   = compResps.filter(r => r.overall_sentiment === 'positive' && r.cited).length;
    const losses = compResps.filter(r => r.overall_sentiment === 'negative').length;
    vs_competitors[comp] = { wins, losses, reason: wins > losses ? `${brand} favored in comparisons` : `${comp} mentioned favorably` };
  });

  const sentimentLabel = geoScore >= 70 ? 'positive' : geoScore >= 40 ? 'neutral' : 'negative';

  return {
    _type: 'geo_brand_sentiment',
    brand,
    industry,
    competitors,
    date: new Date().toISOString(),
    llms_tested: MODELS.map(m => m.id),
    total_responses_analyzed: valid.length,
    overall_sentiment: { score: geoScore, label: sentimentLabel, confidence: avgConf },
    per_llm_sentiment: perModel,
    brand_positioning,
    recommendation_likelihood,
    key_strengths,
    key_weaknesses,
    narrative_themes,
    vs_competitors,
    raw_responses: responses
  };
}

// ── Math helpers ───────────────────────────────────────────────────────────
function sentAvg(resps) {
  const map = { positive: 1, neutral: 0, negative: -1 };
  return resps.reduce((s,r) => s + (map[r.overall_sentiment]||0), 0) / (resps.length||1);
}
function toScore(avg) { return Math.round((avg + 1) / 2 * 100); }

app.listen(PORT, () => {
  console.log(`GEO metric running on :${PORT}`);
  console.log(`Models: ${MODELS.map(m=>m.name).join(', ')}`);
  console.log(`Queries per scan: ${NUM_QUERIES}`);
  console.log(`OpenRouter key: ${OPENROUTER_KEY ? '✓ set' : '✗ MISSING'}`);
});
