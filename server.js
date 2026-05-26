require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3001;

/* ════════════════════════════════════════════════
   CONFIG — edit to change models / query count
   ════════════════════════════════════════════════ */

const MODELS = [
  { id: 'perplexity/sonar-pro',          name: 'Sonar Pro',      provider: 'perplexity', search: true  },
  { id: 'perplexity/sonar',              name: 'Sonar',          provider: 'perplexity', search: true  },
  { id: 'openai/gpt-4o-search-preview',  name: 'GPT-4o Search',  provider: 'openai',     search: true  },
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

// ── Debug endpoint — test a single model with one query ───────────────────
// GET /test?brand=Nike&model=0
app.get('/test', async (req, res) => {
  if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_KEY not set' });
  const brand    = req.query.brand || 'Nike';
  const modelIdx = parseInt(req.query.model || '0');
  const model    = MODELS[modelIdx] || MODELS[0];
  const query    = `What are the pros and cons of ${brand}?`;

  console.log(`\n[TEST] model: ${model.id} | brand: ${brand}`);

  try {
    const instruction = `\n\nAfter your answer, output ONLY this JSON on a new line:\nGEO_META:{"cited":true,"sentiment":"positive","positioning":"challenger","recommendation":"medium","strengths":["example"],"weaknesses":["example"],"confidence":0.8}`;
    const messages = model.search
      ? [{ role: 'user', content: query + instruction }]
      : [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: query + instruction }];

    const apiRes = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://geometric.app',
        'X-Title': 'GEO metric test'
      },
      body: JSON.stringify({ model: model.id, max_tokens: 400, messages })
    });

    const rawText = await apiRes.text();
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch(e) {}

    res.json({
      model: model.id,
      http_status: apiRes.status,
      raw_truncated: rawText.slice(0, 800),
      content: parsed?.choices?.[0]?.message?.content?.slice(0, 600) || null,
      citations: parsed?.citations || [],
      error: parsed?.error || null
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Main scan endpoint ─────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { brand, industry, competitors = [], description = '', market = '', audience = '', usp = '', language = 'en' } = req.body || {};
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
function buildQueries(brand, industry, competitors, n, market = '') {
  const mkt = market ? ` in ${market}` : '';
  const base = [
    `What is ${brand} and what do they offer in the ${industry} space${mkt}?`,
    `What are the pros and cons of ${brand}?`,
    `Would you recommend ${brand} to someone looking for a ${industry} solution${mkt}? Why or why not?`,
    `What are the main criticisms or weaknesses of ${brand}?`,
    `Where does ${brand} sit in the ${industry} market${mkt} — is it a leader, challenger, or niche player?`,
    `What do users say about ${brand}?`,
    `Is ${brand} worth it in ${new Date().getFullYear()}${mkt}?`,
    `Best ${industry} brands${mkt} right now — does ${brand} make the list?`,
    `Describe ${brand} in 3 words and explain why.`,
    `What type of customer is ${brand} best suited for${mkt}?`,
    `${brand} honest review — what should I know before choosing them?`,
  ].slice(0, n);

  const compQueries = competitors.map(comp =>
    `${brand} vs ${comp} — which would you choose and why? Compare them across quality, price, and use case${mkt}.`
  );

  const all = [...base, ...compQueries];
  console.log(`  Built ${base.length} base + ${compQueries.length} competitor = ${all.length} queries`);
  return all;
}

// Build rich brand context injected into every LLM system prompt
function buildBrandContext(brand, description, industry, market, audience, usp, language) {
  const lines = [`Brand: ${brand}`];
  if (description) lines.push(`What they do: ${description}`);
  if (industry)    lines.push(`Industry: ${industry}`);
  if (market)      lines.push(`Market: ${market}`);
  if (audience)    lines.push(`Target audience: ${audience}`);
  if (usp)         lines.push(`What makes them different: ${usp}`);
  return lines.join('\n');
}

/* ════════════════════════════════════════════════
   OPENROUTER CALL
   Supports web-search models (Perplexity Sonar,
   GPT-4o Search) which return live web citations
   ════════════════════════════════════════════════ */
async function runQuery(model, query, brand, brandContext = '', language = 'en') {
  const langInstruction = language === 'fr' ? 'Answer in French.' : language === 'ar' ? 'Answer in Arabic.' : 'Answer in English.';
  const contextBlock = brandContext ? `\n\nBrand context (use this to inform your answer):\n${brandContext}` : '';
  const instruction = contextBlock + '\n\n' + langInstruction + '\n\nAfter your answer, on a new line output ONLY this JSON (no markdown):\n'
    + 'GEO_META:{"cited":BOOL,"sentiment":"positive"/"neutral"/"negative","positioning":"leader"/"challenger"/"niche"/"unknown","recommendation":"high"/"medium"/"low"/"none","strengths":["max 3 short phrases"],"weaknesses":["max 3 short phrases"],"confidence":0.0-1.0}\n'
    + 'Rules: cited=true if you mentioned "' + brand + '" by name. sentiment=your tone toward ' + brand + '. confidence=how sure you are (0-1).';

  // Search models work better without a system prompt
  const messages = model.search
    ? [{ role: 'user', content: query + instruction }]
    : [
        { role: 'system', content: 'You are a helpful AI assistant. Answer naturally, then output GEO_META JSON.' },
        { role: 'user',   content: query + instruction }
      ];

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://geometric.app',
        'X-Title': 'GEO metric'
      },
      body: JSON.stringify({ model: model.id, max_tokens: 700, messages })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`  ⚠ ${model.name} | "${query.slice(0,30)}" → HTTP ${res.status}: ${errText.slice(0,120)}`);
      return makeEmpty(model, query);
    }

    const data   = await res.json();
    const text   = data.choices?.[0]?.message?.content || '';
    const citations = extractCitations(data);
    const parts  = text.split('GEO_META:');
    const answer = parts[0].trim();

    let meta = { cited: false, sentiment: 'neutral', positioning: 'unknown', recommendation: 'none', strengths: [], weaknesses: [], confidence: 0.7 };
    if (parts.length >= 2) {
      try {
        const jsonMatch = parts[1].trim().match(/\{[\s\S]*\}/);
        if (jsonMatch) meta = { ...meta, ...JSON.parse(jsonMatch[0]) };
      } catch(e) {}
    }

    // Fallback citation check
    if (!meta.cited) {
      meta.cited = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer);
    }

    console.log(`  ✓ ${model.name.padEnd(14)} | cited:${String(meta.cited).padEnd(5)} sent:${meta.sentiment.padEnd(8)} rec:${meta.recommendation} | ${citations.length} web citations`);

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
      citations,
      vs_competitors: {}
    };

  } catch (err) {
    console.warn(`  ✗ ${model.name} | ${err.message}`);
    return makeEmpty(model, query);
  }
}

// Extract real citation URLs from search model API responses
function extractCitations(data) {
  const citations = [];
  const seen = new Set();

  function add(url, title) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    citations.push({ url, title: title || url });
  }

  // Perplexity Sonar — citations array at root level
  (data.citations || []).forEach(c => {
    if (typeof c === 'string') add(c, c);
    else if (c.url) add(c.url, c.title);
  });

  // GPT-4o Search — url_citation annotations
  const annotations = data.choices?.[0]?.message?.annotations || [];
  annotations.forEach(a => {
    if (a.type === 'url_citation' && a.url_citation?.url) {
      add(a.url_citation.url, a.url_citation.title);
    }
  });

  // Inline URLs in response text
  const text = data.choices?.[0]?.message?.content || '';
  const urlMatches = text.match(/https?:\/\/[^\s\)\]]+/g) || [];
  urlMatches.forEach(url => add(url.replace(/[.,;]+$/, ''), url));

  return citations.slice(0, 10);
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
   Context-aware — uses actual brand, industry,
   real weaknesses from responses, and competitor data
   ════════════════════════════════════════════════ */
function generateRecommendations(brand, industry, dimensions, perModel, competitors, responses) {
  const recs = [];

  // Extract real weakness themes from actual responses
  const negResponses = responses.filter(r => r.overall_sentiment === 'negative');
  const allWeaknesses = responses.flatMap(r => r.key_weaknesses || []);
  const weaknessFreq = {};
  allWeaknesses.forEach(w => { weaknessFreq[w] = (weaknessFreq[w]||0)+1; });
  const topWeaknesses = Object.entries(weaknessFreq).sort((a,b)=>b[1]-a[1]).map(e=>e[0]).slice(0,4);

  // Detect industry type for context-specific language
  const isFashion    = /fashion|apparel|clothing|wear|streetwear|running|athletic|sport/i.test(industry);
  const isSaaS       = /saas|software|tech|platform|app|tool|digital/i.test(industry);
  const isFood       = /food|beverage|restaurant|drink|cafe|coffee/i.test(industry);
  const isConsulting = /consulting|service|agency|marketing|pr|media/i.test(industry);

  // Helper: get context-specific proof formats
  function proofFormats() {
    if (isFashion)    return 'athlete testimonials, styling guides, and community run/event recaps';
    if (isSaaS)       return 'case studies with metrics, G2/Capterra reviews, and customer success stories';
    if (isFood)       return 'customer reviews, food blogger features, and social proof from community events';
    if (isConsulting) return 'client case studies, media mentions, and thought leadership articles';
    return 'customer testimonials, case studies, and third-party reviews';
  }

  function contentFormats() {
    if (isFashion)    return `"${brand} gear guide", "${brand} for [activity] — is it worth it?", and athlete or community feature stories`;
    if (isSaaS)       return `"What is ${brand}?", "${brand} pricing explained", and "${brand} vs [competitor] — honest comparison"`;
    if (isFood)       return `"${brand} story and sourcing", menu/product spotlights, and behind-the-scenes content`;
    if (isConsulting) return `"How ${brand} approaches [specialty]", client success stories, and industry insight pieces`;
    return `"What is ${brand}?", "pros and cons of ${brand}", and "${brand} for [use case]"`;
  }

  function authorityTargets() {
    if (isFashion)    return `running/sports magazines (Runner's World, Outside), gear review sites, and relevant subreddits (r/running, r/Ultramarathon)`;
    if (isSaaS)       return `G2, Capterra, Product Hunt, and industry blogs in the ${industry} space`;
    if (isFood)       return `food blogs, local press, and platforms like Yelp, Google Reviews`;
    if (isConsulting) return `industry publications, LinkedIn articles, and speaking at relevant events`;
    return `industry publications, review platforms, and relevant directories in the ${industry} space`;
  }

  function thoughtLeadershipFormat() {
    if (isFashion)    return `an annual gear roundup, a training guide, or a community race/event that ${brand} owns`;
    if (isSaaS)       return `an annual industry report, benchmark study, or open-source tool that gets cited`;
    if (isFood)       return `a sourcing transparency report, seasonal menu guide, or community food event`;
    if (isConsulting) return `an industry benchmark report, a framework, or a recurring event ${brand} hosts`;
    return `a definitive guide, annual report, or event that ${brand} owns in the ${industry} space`;
  }

  // ── CITATION RATE ───────────────────────────────────────────────────────
  if (dimensions.citation_rate.score < 60) {
    const gap = 60 - dimensions.citation_rate.score;
    recs.push({
      dimension: 'citation_rate',
      priority: dimensions.citation_rate.score < 30 ? 'high' : 'medium',
      title: 'Create content AI models can cite directly',
      description: `${brand} was missing from ${Math.round((1 - dimensions.citation_rate.score/100)*100)}% of relevant AI responses. Models cite what they can find. Publish ${contentFormats()} — these are the exact query formats AI models answer.`,
      action: `Start with 3 pages: (1) a detailed brand overview, (2) an honest pros/cons breakdown, (3) a comparison page vs your top competitor. Aim for 800+ words each, factual tone.`,
      lift: `+${Math.round(gap*0.4)}–${Math.round(gap*0.6)} pts on Citation Rate`,
      type: 'Content'
    });
  }

  if (dimensions.citation_rate.score < 80) {
    recs.push({
      dimension: 'citation_rate',
      priority: 'medium',
      title: `Get ${brand} mentioned in trusted ${industry} sources`,
      description: `AI models heavily weight citations from authoritative sources. ${brand} needs to appear in ${authorityTargets()}. Each quality mention multiplies visibility across all AI models simultaneously.`,
      action: `Identify 10 relevant publications or platforms. Pitch ${brand} for reviews, roundups, or features. One strong feature in the right publication can lift citation rate significantly.`,
      lift: `+5–10 pts on Citation Rate`,
      type: 'Authority'
    });
  }

  // ── SENTIMENT ───────────────────────────────────────────────────────────
  if (dimensions.sentiment_quality.score < 60) {
    const weakStr = topWeaknesses.length > 0
      ? topWeaknesses.join(', ')
      : 'pricing, availability, or competition';
    recs.push({
      dimension: 'sentiment_quality',
      priority: 'high',
      title: `Address "${topWeaknesses[0] || 'key weaknesses'}" head-on`,
      description: `AI models are flagging these specific weaknesses for ${brand}: ${weakStr}. These themes appear in ${negResponses.length} of ${responses.length} responses. The fix is not to ignore them — it's to publish content that reframes or directly addresses each one.`,
      action: `For each weakness, create one piece of content that addresses it honestly. Example: if "${topWeaknesses[0]}" is flagged, write "${brand} — ${topWeaknesses[0]} explained honestly" with real data and context.`,
      lift: `+${Math.round((60-dimensions.sentiment_quality.score)*0.5)}–${Math.round((60-dimensions.sentiment_quality.score)*0.7)} pts on Sentiment`,
      type: 'Sentiment'
    });
  }

  // ── RECOMMENDATION ──────────────────────────────────────────────────────
  if (dimensions.recommendation_likelihood.score < 60) {
    recs.push({
      dimension: 'recommendation_likelihood',
      priority: dimensions.recommendation_likelihood.score < 30 ? 'high' : 'medium',
      title: `Build ${industry}-specific social proof`,
      description: `AI models recommend brands that have been validated by real people. For ${brand} in ${industry}, the most effective proof formats are: ${proofFormats()}. These get indexed and cited by AI models when users ask "should I buy/use X?"`,
      action: `Collect and publish 5–10 real customer stories in the next 30 days. Make them specific — "how ${brand} helped me [specific outcome]" performs far better than generic praise.`,
      lift: `+${Math.round((60-dimensions.recommendation_likelihood.score)*0.4)}–${Math.round((60-dimensions.recommendation_likelihood.score)*0.6)} pts on Recommendation`,
      type: 'Reputation'
    });
  }

  // ── POSITIONING ─────────────────────────────────────────────────────────
  if (dimensions.brand_positioning.score < 66) {
    recs.push({
      dimension: 'brand_positioning',
      priority: 'medium',
      title: `Own a specific angle in the ${industry} conversation`,
      description: `AI models currently see ${brand} as a "${dimensions.brand_positioning.label.toLowerCase()}" — not yet a go-to reference. In ${industry}, owning one specific angle (community, sustainability, performance, design) is more effective than trying to compete on everything.`,
      action: `Launch ${thoughtLeadershipFormat()}. Promote it until it gets cited by at least 5 external sources. This single asset can shift how AI models categorize ${brand}.`,
      lift: `+${Math.round((66-dimensions.brand_positioning.score)*0.5)}–${Math.round((66-dimensions.brand_positioning.score)*0.7)} pts on Positioning`,
      type: 'Positioning'
    });
  }

  // ── COMPETITIVE ─────────────────────────────────────────────────────────
  if (dimensions.competitive_standing.score < 60 && competitors.length > 0) {
    const compList = competitors.slice(0,3).join(', ');
    recs.push({
      dimension: 'competitive_standing',
      priority: 'medium',
      title: `Publish honest comparisons vs ${competitors[0]}${competitors[1]?' and '+competitors[1]:''}`,
      description: `When users ask AI models "${brand} vs ${competitors[0]}?", ${brand} is currently losing that narrative. AI models cite balanced, factual comparison content — not marketing copy. A well-written comparison page gets cited directly in these queries.`,
      action: `Write one comparison page per competitor (${compList}). Structure: feature comparison table, who each is best for, honest pros/cons of each. Factual tone — AI models distrust one-sided content.`,
      lift: `+${Math.round((60-dimensions.competitive_standing.score)*0.3)}–${Math.round((60-dimensions.competitive_standing.score)*0.5)} pts on Competitive Standing`,
      type: 'Competitive'
    });
  }

  // ── MODEL-SPECIFIC ──────────────────────────────────────────────────────
  const modelGaps = Object.entries(perModel).filter(([,v]) => v.score < 50).map(([k]) => k);
  if (modelGaps.length > 0) {
    recs.push({
      dimension: 'per_model',
      priority: 'low',
      title: `Boost visibility on ${modelGaps.map(m=>m.charAt(0).toUpperCase()+m.slice(1)).join(' and ')}`,
      description: `${brand} scores below 50/100 on ${modelGaps.join(' and ')}. Each AI model has slightly different training data. Structured data and knowledge graph presence (Wikipedia, Wikidata, Crunchbase) improve scores uniformly across all models.`,
      action: `Add Organization + FAQ schema to your site. Ensure ${brand}'s Wikipedia or Wikidata entry exists and is accurate. Complete your Crunchbase and LinkedIn company pages consistently.`,
      lift: `+3–8 pts on affected models`,
      type: 'Technical'
    });
  }

  // ── ALWAYS INCLUDE ──────────────────────────────────────────────────────
  recs.push({
    dimension: 'general',
    priority: 'low',
    title: 'Add structured data to help AI models identify your brand',
    description: `Schema markup tells AI models exactly what ${brand} is, what it offers, and who it's for. This is especially impactful for ${industry} brands where AI models may confuse similar brand names or categories.`,
    action: `Implement Organization schema (name, logo, description, URL) on your homepage. Add FAQ schema to any Q&A pages. Test at validator.schema.org. One-time effort, lasting GEO impact.`,
    lift: `+2–5 pts across all dimensions`,
    type: 'Technical'
  });

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
