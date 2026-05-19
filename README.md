# GEO metric — Deployment Guide

## What you have

| File | Purpose |
|------|---------|
| `geometric-app-apify.html` | Frontend — drop on any static host |
| `geometric-server.js` | Backend proxy — deploy on Node host |
| `package.json` | Node dependencies |

---

## Step 1 — Deploy the backend (5 min)

The backend is a tiny Express proxy that relays requests from your frontend
to Apify's API (CORS prevents calling Apify directly from the browser).

### Option A — Railway (recommended, free tier)
1. Create account at railway.app
2. New Project → Deploy from GitHub → push these files, or use "Deploy from local"
3. Add environment variable: `APIFY_TOKEN=apify_api_XXXXXXX`
4. Railway gives you a URL like `https://geometric-api.up.railway.app`

### Option B — Render
1. Create account at render.com
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env var: `APIFY_TOKEN=your_token`

### Option C — Fly.io / VPS
Standard Node deployment. Set `APIFY_TOKEN` as an env var. Port is 3001 by default
or whatever `$PORT` is set to.

---

## Step 2 — Get your Apify token (2 min)

1. Sign up at apify.com (free plan includes $5/month credit = 250 queries)
2. Go to Console → Settings → Integrations
3. Copy your API token (starts with `apify_api_`)

The app uses the `zhorex/perplexity-ai-scraper` actor which:
- Scrapes Perplexity's public web UI (no Perplexity API key needed)
- Costs ~$0.02 per query
- Returns: answer text, cited sources, brand mention detection

---

## Step 3 — Deploy the frontend (2 min)

Drop `geometric-app-apify.html` on any static host:

- **Netlify**: drag & drop at netlify.com/drop — live in 30 sec
- **Vercel**: `vercel --prod` or drag to vercel.com
- **GitHub Pages**: push to repo, enable Pages
- **Cloudflare Pages**: drag & drop

---

## Step 4 — Configure the app

On first visit, the app shows a setup modal:
1. Enter your Apify API token
2. Enter your backend URL (from Step 1)
3. Done — start scanning

---

## Cost estimate

| Usage | Approx. cost |
|-------|-------------|
| 1 scan (8 queries) | ~$0.16 |
| 10 scans/month | ~$1.60 |
| 100 scans/month | ~$16 |

Apify free plan gives $5 credit = ~30 scans/month for free.

---

## Monetization path

When you want to charge users instead of having them bring their own key:

1. Add auth (Clerk.dev or Supabase Auth — both have free tiers)
2. Move `APIFY_TOKEN` to server-only (already there in server.js)
3. Add usage tracking per user
4. Gate scans behind a subscription (Stripe Checkout is 30 min to integrate)

Suggested tiers:
- Starter $29/mo — 20 scans
- Growth $99/mo — 100 scans + competitor tracking
- Agency $299/mo — unlimited + white-label reports
