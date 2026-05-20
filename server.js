require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3001;

/* ════════════════════════════════════════════════
   CONFIG — edit to change models / query count
   ════════════════════════════════════════════════ */

const MODELS = [
  { id: 'openai/gpt-4o',                    name: 'GPT-4o',       provider: 'openai'    },
  { id: 'anthropic/claude-haiku-4-5',       name: 'Claude Haiku', provider: 'anthropic' },
  { id: 'google/gemini-2.0-flash-001',      name: 'Gemini Flash', provider: 'google'    },
  { id: 'meta-llama/llama-3.3-70b-instruct',name: 'Llama 3.3',   provider: 'meta'      },
];

const NUM_QUERIES = 6;

/* ════════════════════════════════════════════════
   SCORING WEIGHTS — adjust these to tune the GEO Score
   Must add up to 100
   ════════════════════════════════════════════════ */
const WEIGHTS = {
  citation_rate:            30,   // How often brand is mentioned
  sentiment_quality:        25,   // Positive vs negative tone
  recommendation_likelihood: 20,  // Do models actively recommend?
  brand_positioning:        15,   // Leader / Challenger / Niche / Unknown
  competitive_standing:     10,   // Win rate vs competitors
};

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
app.get('/health', (req, res) => res.json({ ok: true, models: MODELS.map(m => m.name), weights: WEIGHTS, ts: Date.now() }));

// ── Main scan endpoint ─────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { brand, industry, competitors = [] } = req.body || {};
  if (!brand)          return res.status(400).json({ error: 'brand is required' });
  if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_KEY not configured on server' });

  try {
    console.log(`\n▶ Scan: "${brand}" | ${industry} | ${MODELS.length} models × ${NUM_QUERIES} queries`);

    // 1. Generate targeted queries covering all 5 scoring dimensions
    const queries = buildQueries(brand, industry, competitors, NUM_QUERIES);

    // 2. Run all model × query combos in parallel
    const tasks = [];
    for (const model of MODELS) {
      for (const query of queries) {
        tasks.push(runQuery(model, query, brand));
      }
    }
    const raw_responses = await Promise.all(tasks);
    const valid = raw_responses.filter(r => !r.error && r.response_text);
    console.log(`  ${valid.length}/${raw_responses.length} responses valid`);

    // 3. Score each dimension independently
    const dimensions = scoreDimensions(brand, valid, competitors);

    // 4. Compute weighted GEO Score
    const geoScore = computeGeoScore(dimensions);

    // 5. Generate model-specific insights
    const perModel = scorePerModel(valid);

    // 6. Generate targeted recommendations based on dimension gaps
    const recommendations = generateRecommendations(brand, industry, dimensions, perModel, competitors, valid);

    // 7. Aggregate strengths / weaknesses
    const { key_strengths, key_weaknesses } = aggregateKeywords(valid);

    // 8. Build vs_competitors
    const vs_competitors = buildCompetitorData(brand, competitors, valid);

    const sentimentLabel = geoScore >= 70 ? 'positive' : geoScore >= 40 ? 'neutral' : 'negative';
    const positioning    = getTopValue(valid, 'brand_positioning', 'unknown');
    const recLikelihood  = getTopValue(valid, 'recommendation_likelihood', 'none');

    const result = {
      _type: 'geo_brand_sentiment',
      brand, industry, competitors,
      date: new Date().toISOString(),
      llms_tested: MODELS.map(m => m.id),
      total_responses_analyzed: valid.length,

      // GEO Score + dimension breakdown
      geo_score: geoScore,
      dimensions,                   // per-dimension scores + explanations
      overall_sentiment: {
        score: geoScore,
        label: sentimentLabel,
        confidence: avg(valid.map(r => r.confidence || 0))
      },
      per_llm_sentiment: perModel,
      brand_positioning: positioning,
      recommendation_likelihood: recLikelihood,
      key_strengths,
      key_weaknesses,
      narrative_themes: key_strengths.slice(0, 5),
      vs_competitors,
      recommendations,              // rich, dimension-linked recommendations
      raw_responses,
    };

    console.log(`  ✓ GEO Score: ${geoScore}/100 | Dimensions: ${Object.entries(dimensions).map(([k,v])=>`${k}:${v.score}`).join(', ')}`);
    res.json(result);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   QUERY BUILDER
   6 queries designed to cover all 5 dimensions
   ════════════════════════════════════════════════ */
function buildQueries(brand, industry, competitors, n) {
  // Base queries — cover all 5 scoring dimensions
  const base = [
    `What is ${brand} and what do they offer in the ${industry} space?`,
    `What are the pros and cons of ${brand}?`,
    `Would you recommend ${brand} to someone looking for a solution in ${industry}? Why or why not?`,
    `What are the main criticisms or weaknesses of ${brand}?`,
    `Where does ${brand} sit in the ${industry} market — is it a leader, challenger, or niche player?`,
    `What do users say about ${brand}?`,
    `Is ${brand} worth it in ${new Date().getFullYear()}?`,
    `Best ${industry} brands right now — does ${brand} make the list?`,
    `Describe ${brand} in 3 words and explain why.`,
    `What type of customer is ${brand} best suited for?`,
    `${brand} honest review — what should I know before choosing them?`,
  ].slice(0, n);

  // One comparison query per competitor — additive on top of base queries
  const compQueries = competitors.map(comp =>
    `${brand} vs ${comp} — which would you choose and why? Compare them across quality, price, and use case.`
  );

  const all = [...base, ...compQueries];
  console.log(`  Built ${base.length} base queries + ${compQueries.length} competitor queries = ${all.length} total`);
  return all;
}

/* ════════════════════════════════════════════════
   OPENROUTER CALL
   Each response self-reports structured metadata
   ════════════════════════════════════════════════ */
async function runQuery(model, query, brand) {
  const system = `You are a knowledgeable AI assistant. Answer the user's question naturally and helpfully in 3-5 sentences.

After your answer, on a new line output ONLY this JSON (no markdown fences):
GEO_META:{"cited":BOOL,"sentiment":"positive"/"neutral"/"negative","positioning":"leader"/"challenger"/"niche"/"unknown","recommendation":"high"/"medium"/"low"/"none","strengths":["max 3 short phrases"],"weaknesses":["max 3 short phrases"],"confidence":0.0-1.0}

Rules:
- cited = true if you mentioned "${brand}" by name in your answer
- sentiment = your overall tone toward ${brand} in the answer
- positioning = where ${brand} sits in the market based on your knowledge
- recommendation = how strongly you would recommend ${brand}
- confidence = how confident you are in your answer (0-1)`;

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
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: query  }
        ]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  ⚠ ${model.name} | "${query.slice(0,30)}" → HTTP ${res.status}`);
      return makeEmpty(model, query);
    }

    const data   = await res.json();
    const text   = data.choices?.[0]?.message?.content || '';
    const parts  = text.split('GEO_META:');
    const answer = parts[0].trim();

    let meta = { cited: false, sentiment: 'neutral', positioning: 'unknown', recommendation: 'none', strengths: [], weaknesses: [], confidence: 0.7 };
    if (parts.length >= 2) {
      try { meta = { ...meta, ...JSON.parse(parts[1].trim()) }; } catch(e) {}
    }

    // Fallback citation check
    if (!meta.cited) {
      meta.cited = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer);
    }

    console.log(`  ✓ ${model.name.padEnd(12)} | cited:${String(meta.cited).padEnd(5)} sent:${meta.sentiment.padEnd(8)} rec:${meta.recommendation}`);
    return {
      prompt: query, llm: model.provider, model: model.id, model_name: model.name,
      response_text: answer,
      overall_sentiment: meta.sentiment,
      confidence: Math.min(1, Math.max(0, meta.confidence || 0.7)),
      brand_positioning: meta.positioning,
      recommendation_likelihood: meta.recommendation,
      key_strengths:  meta.strengths  || [],
      key_weaknesses: meta.weaknesses || [],
      cited: meta.cited,
      vs_competitors: {}
    };

  } catch (err) {
    console.warn(`  ✗ ${model.name} | ${err.message}`);
    return makeEmpty(model, query);
  }
}

function makeEmpty(model, query) {
  return { prompt: query, llm: model.provider, model: model.id, model_name: model.name,
    response_text: '', overall_sentiment: 'neutral', confidence: 0,
    brand_positioning: 'unknown', recommendation_likelihood: 'none',
    key_strengths: [], key_weaknesses: [], cited: false, vs_competitors: {}, error: true };
}

/* ════════════════════════════════════════════════
   DIMENSION SCORING
   Each dimension scores 0-100 independently
   ════════════════════════════════════════════════ */
function scoreDimensions(brand, responses, competitors) {

  // 1. CITATION RATE (0-100)
  // % of responses where brand was mentioned
  const citedCount  = responses.filter(r => r.cited).length;
  const citationPct = responses.length ? citedCount / responses.length : 0;
  const citation_rate = {
    score: Math.round(citationPct * 100),
    weight: WEIGHTS.citation_rate,
    label: citationPct >= 0.8 ? 'Excellent' : citationPct >= 0.6 ? 'Good' : citationPct >= 0.4 ? 'Fair' : 'Poor',
    explanation: `Brand was mentioned in ${citedCount} of ${responses.length} AI responses (${Math.round(citationPct*100)}%).`,
    detail: citationPct < 0.5
      ? `${brand} is not being cited enough. AI models are answering questions in your category without mentioning you.`
      : `${brand} has solid citation coverage across AI models.`
  };

  // 2. SENTIMENT QUALITY (0-100)
  // Weighted: positive=100, neutral=50, negative=0
  const sentMap  = { positive: 100, neutral: 50, negative: 0 };
  const sentScores = responses.map(r => sentMap[r.overall_sentiment] ?? 50);
  const avgSent    = sentScores.reduce((a,b) => a+b, 0) / (sentScores.length || 1);
  const posPct     = responses.filter(r => r.overall_sentiment === 'positive').length / (responses.length || 1);
  const negPct     = responses.filter(r => r.overall_sentiment === 'negative').length / (responses.length || 1);
  const sentiment_quality = {
    score: Math.round(avgSent),
    weight: WEIGHTS.sentiment_quality,
    label: avgSent >= 75 ? 'Positive' : avgSent >= 50 ? 'Neutral' : 'Negative',
    explanation: `${Math.round(posPct*100)}% positive, ${Math.round((1-posPct-negPct)*100)}% neutral, ${Math.round(negPct*100)}% negative responses.`,
    detail: negPct > 0.3
      ? `High negative sentiment detected (${Math.round(negPct*100)}% of responses). AI models are associating ${brand} with negative themes.`
      : avgSent >= 75
      ? `Strong positive sentiment — AI models speak favorably about ${brand}.`
      : `Mixed sentiment — some models are neutral or negative about ${brand}.`
  };

  // 3. RECOMMENDATION LIKELIHOOD (0-100)
  // high=100, medium=66, low=33, none=0
  const recMap   = { high: 100, medium: 66, low: 33, none: 0 };
  const recScores = responses.map(r => recMap[r.recommendation_likelihood] ?? 0);
  const avgRec    = recScores.reduce((a,b) => a+b, 0) / (recScores.length || 1);
  const highRec   = responses.filter(r => r.recommendation_likelihood === 'high').length;
  const recommendation_likelihood = {
    score: Math.round(avgRec),
    weight: WEIGHTS.recommendation_likelihood,
    label: avgRec >= 75 ? 'High' : avgRec >= 45 ? 'Medium' : avgRec >= 20 ? 'Low' : 'None',
    explanation: `${highRec} of ${responses.length} responses actively recommend ${brand}.`,
    detail: avgRec < 45
      ? `AI models are not proactively recommending ${brand}. Users asking for recommendations may not hear about you.`
      : `AI models are willing to recommend ${brand} in relevant contexts.`
  };

  // 4. BRAND POSITIONING (0-100)
  // leader=100, challenger=66, niche=40, unknown=10
  const posMap  = { leader: 100, challenger: 66, niche: 40, unknown: 10 };
  const posScores = responses.map(r => posMap[r.brand_positioning] ?? 10);
  const avgPos    = posScores.reduce((a,b) => a+b, 0) / (posScores.length || 1);
  const topPos    = getTopValue(responses, 'brand_positioning', 'unknown');
  const brand_positioning = {
    score: Math.round(avgPos),
    weight: WEIGHTS.brand_positioning,
    label: topPos.charAt(0).toUpperCase() + topPos.slice(1),
    explanation: `Most AI models position ${brand} as a "${topPos}" in the market.`,
    detail: topPos === 'unknown'
      ? `AI models don't have a clear sense of where ${brand} sits in the market. Stronger brand presence and content can fix this.`
      : topPos === 'leader'
      ? `${brand} is perceived as a market leader by AI models — strong positioning.`
      : `${brand} is seen as a ${topPos}. Building more authority content can move this toward "leader".`
  };

  // 5. COMPETITIVE STANDING (0-100)
  // Based on win/loss ratio in comparison queries
  const compResponses = responses.filter(r =>
    competitors.some(c => r.prompt.toLowerCase().includes(c.toLowerCase()))
  );
  let compScore = 50; // neutral default if no competitor queries
  let compDetail = `No direct competitor comparisons were run.`;
  if (compResponses.length > 0) {
    const wins   = compResponses.filter(r => r.overall_sentiment === 'positive' && r.cited).length;
    const losses = compResponses.filter(r => r.overall_sentiment === 'negative').length;
    const total  = compResponses.length;
    compScore    = Math.round((wins / total) * 100);
    compDetail   = `${brand} won ${wins} of ${total} competitor comparisons (${Math.round(wins/total*100)}% win rate).`;
  }
  const competitive_standing = {
    score: compScore,
    weight: WEIGHTS.competitive_standing,
    label: compScore >= 70 ? 'Strong' : compScore >= 45 ? 'Competitive' : 'Weak',
    explanation: compDetail,
    detail: compScore < 45
      ? `${brand} is losing in competitor comparisons. Create dedicated comparison content to shift this narrative.`
      : `${brand} holds its own against competitors in AI model comparisons.`
  };

  return { citation_rate, sentiment_quality, recommendation_likelihood, brand_positioning, competitive_standing };
}

/* ════════════════════════════════════════════════
   GEO SCORE COMPUTATION
   Weighted average of 5 dimension scores
   ════════════════════════════════════════════════ */
function computeGeoScore(dimensions) {
  const total = Object.values(WEIGHTS).reduce((a,b) => a+b, 0); // should be 100
  const weighted = Object.entries(dimensions).reduce((sum, [key, dim]) => {
    return sum + (dim.score * (WEIGHTS[key] || 0));
  }, 0);
  return Math.round(weighted / total);
}

/* ════════════════════════════════════════════════
   RECOMMENDATIONS
   Each rec is tied to a specific failing dimension
   Ranked by estimated score impact
   ════════════════════════════════════════════════ */
function generateRecommendations(brand, industry, dimensions, perModel, competitors, responses) {
  const recs = [];

  // ── CITATION RATE gaps ──────────────────────────────────────────────────
  if (dimensions.citation_rate.score < 60) {
    const gap = 60 - dimensions.citation_rate.score;
    recs.push({
      dimension: 'citation_rate',
      priority: dimensions.citation_rate.score < 30 ? 'high' : 'medium',
      title: 'Publish FAQ and definition content',
      description: `AI models answered ${Math.round((1 - dimensions.citation_rate.score/100)*100)}% of relevant queries without mentioning ${brand}. Create "What is ${brand}?", "How does ${brand} work?" and "Is ${brand} right for me?" pages. These exact formats are what AI models cite.`,
      action: `Write 3–5 long-form pages targeting the question patterns: "What is [brand]", "pros and cons of [brand]", "[brand] vs competitors".`,
      lift: `+${Math.round(gap * 0.4)}–${Math.round(gap * 0.6)} pts on Citation Rate`,
      type: 'Content'
    });
  }

  if (dimensions.citation_rate.score < 80) {
    recs.push({
      dimension: 'citation_rate',
      priority: 'medium',
      title: 'Get cited by authoritative third-party sources',
      description: `AI models cite sources they trust. ${brand} needs mentions in industry publications, review sites, and directories. Even 5–10 high-quality backlinks from trusted domains significantly increases citation rate.`,
      action: `Target: G2, Capterra, Trustpilot (reviews), industry blogs (guest posts), and press mentions. Each citation source multiplies your visibility across all AI models.`,
      lift: `+5–10 pts on Citation Rate`,
      type: 'Authority'
    });
  }

  // ── SENTIMENT gaps ──────────────────────────────────────────────────────
  if (dimensions.sentiment_quality.score < 60) {
    const negKeywords = responses
      .filter(r => r.overall_sentiment === 'negative')
      .flatMap(r => r.key_weaknesses)
      .slice(0, 3);
    recs.push({
      dimension: 'sentiment_quality',
      priority: 'high',
      title: 'Address negative narrative themes directly',
      description: `${Math.round((1 - dimensions.sentiment_quality.score/100)*50)}% of AI responses carry negative or neutral sentiment about ${brand}. The recurring themes are: ${negKeywords.join(', ') || 'cost, complexity, competition'}. These need to be addressed with dedicated content.`,
      action: `Publish direct response content: "Is ${brand} too expensive? Here's the real cost breakdown", customer success stories, and comparison pages showing your advantages.`,
      lift: `+${Math.round((60 - dimensions.sentiment_quality.score) * 0.5)}–${Math.round((60 - dimensions.sentiment_quality.score) * 0.7)} pts on Sentiment`,
      type: 'Sentiment'
    });
  }

  // ── RECOMMENDATION gaps ─────────────────────────────────────────────────
  if (dimensions.recommendation_likelihood.score < 60) {
    recs.push({
      dimension: 'recommendation_likelihood',
      priority: dimensions.recommendation_likelihood.score < 30 ? 'high' : 'medium',
      title: 'Build social proof AI models can cite',
      description: `AI models are not proactively recommending ${brand} (score: ${dimensions.recommendation_likelihood.score}/100). Models recommend brands they've seen validated by others. Reviews on G2, Capterra and Trustpilot are heavily weighted in AI training data.`,
      action: `Get 20+ verified reviews on G2 or Capterra. Ask satisfied customers directly. Also publish 2–3 detailed case studies with measurable results — these are cited in "should I use X" queries.`,
      lift: `+${Math.round((60 - dimensions.recommendation_likelihood.score) * 0.4)}–${Math.round((60 - dimensions.recommendation_likelihood.score) * 0.6)} pts on Recommendation Rate`,
      type: 'Reputation'
    });
  }

  // ── POSITIONING gaps ────────────────────────────────────────────────────
  if (dimensions.brand_positioning.score < 66) {
    recs.push({
      dimension: 'brand_positioning',
      priority: 'medium',
      title: `Strengthen ${brand}'s category authority`,
      description: `AI models currently position ${brand} as "${dimensions.brand_positioning.label.toLowerCase()}" in the ${industry} market. To shift toward "leader", ${brand} needs to own the conversation in its niche with consistent, authoritative content.`,
      action: `Publish a definitive industry guide or annual report for ${industry}. Get it cited by at least 10 external sources. "Thought leadership" content directly influences how AI models categorize brands.`,
      lift: `+${Math.round((66 - dimensions.brand_positioning.score) * 0.5)}–${Math.round((66 - dimensions.brand_positioning.score) * 0.7)} pts on Positioning`,
      type: 'Positioning'
    });
  }

  // ── COMPETITIVE gaps ────────────────────────────────────────────────────
  if (dimensions.competitive_standing.score < 60 && competitors.length > 0) {
    recs.push({
      dimension: 'competitive_standing',
      priority: 'medium',
      title: `Win the "${brand} vs competitors" narrative`,
      description: `${brand} is underperforming in competitor comparison queries. AI models are favoring competitors when users ask "X vs Y". Dedicated comparison pages directly fix this — they get cited in exactly these queries.`,
      action: `Create one page per competitor: "${brand} vs ${competitors[0]}", "${brand} vs ${competitors[1] || 'alternatives'}", etc. Be objective and factual — AI models distrust biased content but do cite balanced comparisons.`,
      lift: `+${Math.round((60 - dimensions.competitive_standing.score) * 0.3)}–${Math.round((60 - dimensions.competitive_standing.score) * 0.5)} pts on Competitive Standing`,
      type: 'Competitive'
    });
  }

  // ── MODEL-SPECIFIC gaps ─────────────────────────────────────────────────
  const modelGaps = Object.entries(perModel)
    .filter(([, v]) => v.score < 50)
    .map(([k]) => k);
  if (modelGaps.length > 0) {
    recs.push({
      dimension: 'per_model',
      priority: 'low',
      title: `Improve visibility on ${modelGaps.join(', ')}`,
      description: `${brand} scores below 50/100 on ${modelGaps.join(' and ')}. Different AI models have different training data emphases. Improving structured data (schema.org) and Wikipedia/Wikidata presence tends to lift scores across all models uniformly.`,
      action: `Implement Organization schema on your homepage. Add or update your Wikipedia/Wikidata entry. Ensure your Crunchbase, LinkedIn company page and industry directories are complete and consistent.`,
      lift: `+3–8 pts on affected models`,
      type: 'Technical'
    });
  }

  // ── ALWAYS INCLUDE ──────────────────────────────────────────────────────
  recs.push({
    dimension: 'general',
    priority: 'low',
    title: 'Add structured data (schema.org)',
    description: `Schema markup helps AI models accurately identify, describe and categorize ${brand}. Organization, Product, and FAQ schema are the highest-impact for GEO. This is a one-time technical implementation with lasting impact.`,
    action: `Add Organization schema to homepage, FAQ schema to support/FAQ pages, and Product schema to product pages. Validate at schema.org/validator.`,
    lift: `+2–5 pts across all dimensions`,
    type: 'Technical'
  });

  // Sort: high → medium → low, then by estimated lift (descending)
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority]);
}

/* ════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════ */
function scorePerModel(responses) {
  const perModel = {};
  MODELS.forEach(m => {
    const mr = responses.filter(r => r.llm === m.provider);
    if (!mr.length) return;
    const sentMap = { positive: 100, neutral: 50, negative: 0 };
    const avgSent = mr.reduce((s,r) => s + (sentMap[r.overall_sentiment]||50), 0) / mr.length;
    const citPct  = mr.filter(r => r.cited).length / mr.length;
    const recMap  = { high: 100, medium: 66, low: 33, none: 0 };
    const avgRec  = mr.reduce((s,r) => s + (recMap[r.recommendation_likelihood]||0), 0) / mr.length;
    // Mini weighted score per model
    const score   = Math.round(avgSent * 0.4 + citPct * 100 * 0.35 + avgRec * 0.25);
    perModel[m.provider] = {
      score,
      label: score >= 70 ? 'positive' : score >= 40 ? 'neutral' : 'negative',
      confidence: avg(mr.map(r => r.confidence || 0)),
      cited_rate: Math.round(citPct * 100),
      model_name: m.name
    };
  });
  return perModel;
}

function aggregateKeywords(responses) {
  const strMap = {}, wkMap = {};
  responses.forEach(r => {
    (r.key_strengths  || []).forEach(s => { strMap[s] = (strMap[s]||0) + 1; });
    (r.key_weaknesses || []).forEach(w => { wkMap[w]  = (wkMap[w] ||0) + 1; });
  });
  return {
    key_strengths:  Object.entries(strMap).sort((a,b)=>b[1]-a[1]).map(e=>e[0]).slice(0,8),
    key_weaknesses: Object.entries(wkMap) .sort((a,b)=>b[1]-a[1]).map(e=>e[0]).slice(0,8),
  };
}

function buildCompetitorData(brand, competitors, responses) {
  const vs = {};
  competitors.forEach(comp => {
    const cr = responses.filter(r => r.prompt.toLowerCase().includes(comp.toLowerCase()));
    if (!cr.length) return;
    const wins   = cr.filter(r => r.overall_sentiment === 'positive' && r.cited).length;
    const losses = cr.filter(r => r.overall_sentiment === 'negative').length;
    vs[comp] = {
      wins, losses,
      reason: wins > losses
        ? `${brand} favored in direct comparisons`
        : losses > wins
        ? `${comp} mentioned more favorably`
        : `Mixed results in comparisons`
    };
  });
  return vs;
}

function getTopValue(responses, field, fallback) {
  const map = {};
  responses.forEach(r => {
    const v = r[field];
    if (v && v !== 'unknown') map[v] = (map[v]||0) + 1;
  });
  return Object.entries(map).sort((a,b)=>b[1]-a[1])[0]?.[0] || fallback;
}

function avg(arr) {
  return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
}

app.listen(PORT, () => {
  console.log(`GEO metric running on :${PORT}`);
  console.log(`Models: ${MODELS.map(m=>m.name).join(', ')}`);
  console.log(`Weights: ${Object.entries(WEIGHTS).map(([k,v])=>`${k}:${v}%`).join(', ')}`);
  console.log(`OpenRouter key: ${OPENROUTER_KEY ? '✓ set' : '✗ MISSING'}`);
});
