/**
 * meta-gen-tool - enhanced server.js
 * Adds /api/meta-from-url which fetches a page and generates:
 *  - main_keyword
 *  - 5 titles (<=60 chars, must include main_keyword)
 *  - 3 meta descriptions (150-160 chars target)
 *  - a recommended slug
 *
 * Uses Google Gemini (primary) and OpenRouter (fallback).
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const crypto = require('crypto');

require('dotenv').config();

const app = express();
app.use(helmet());
app.use(express.json({ limit: '30kb' }));

// CORS: read env or default; augment with www / non-www variants automatically
(function setupCors() {
  const raw = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const aug = new Set();

  raw.forEach(o => {
    try {
      // keep origin as-is
      aug.add(o);
      // add www / non-www variants if host appears
      const m = o.match(/^https?:\/\/(www\.)?(.+)$/i);
      if (m) {
        const host = m[2];
        aug.add(`https://${host}`);
        aug.add(`https://www.${host}`);
      }
    } catch (e) {
      // ignore
    }
  });

  const ALLOWED_ORIGINS = Array.from(aug.length ? aug : ['https://apextechagency.com', 'https://www.apextechagency.com', 'https://tools-api.apextechagency.com']);
  // flexible CORS: allow unknown origins only if ALLOWED_ORIGINS contains '*'
  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow server-to-server / curl
      if (ALLOWED_ORIGINS.indexOf('*') !== -1) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
        return callback(new Error('CORS policy: origin not allowed'), false);
      }
      return callback(null, true);
    }
  }));
})();

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Optional Redis caching
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e.message || e));
}
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SEC || `${60 * 60 * 24}`, 10);

// Helpers
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
async function getCache(k) { if (!redis) return null; try { const v = await redis.get(k); return v ? JSON.parse(v) : null; } catch (e) { console.warn('Cache read error', e.message || e); return null; } }
async function setCache(k, v, ttl = CACHE_TTL) { if (!redis) return; try { await redis.set(k, JSON.stringify(v), 'EX', ttl); } catch (e) { console.warn('Cache write error', e.message || e); } }

// Simple HTML extractors (no external libs)
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}
function extractMetaDescription(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i) ||
            html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?>/i);
  return m ? m[1].trim() : null;
}
function extractFirstH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]).trim() : null;
}
function stripTags(s) {
  return s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
          .replace(/<\/?[^>]+(>|$)/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
}
function extractBodySnippet(html, maxChars = 1200) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const raw = bodyMatch ? stripTags(bodyMatch[1]) : stripTags(html);
  return raw.slice(0, maxChars).trim();
}

// Heuristic: derive keyword from H1 > title > meta > body
function deriveKeyword({ h1, title, meta, body }) {
  const source = h1 || title || meta || body || '';
  // simple stopwords list
  const stopwords = new Set(['the','and','for','with','a','an','of','to','in','on','best','top','how','what','is','guide']);
  const words = source
    .replace(/[^\w\s-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !stopwords.has(w))
    .slice(0, 8);

  if (words.length === 0) {
    // fallback to whole title or domain parts
    return (title || '').split('|')[0].split('-')[0].trim() || '';
  }
  // choose top 2-3 words to form a short phrase (1-3 words)
  return words.slice(0, Math.min(3, words.length)).join(' ');
}

// Slugify utility
function slugify(text, maxlen = 80) {
  if (!text) return '';
  let s = text.toLowerCase().trim();
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); // remove diacritics
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > maxlen) s = s.slice(0, maxlen).replace(/-+$/,'');
  return s;
}

// Adjust title to be <= 60 chars and ensure keyword present
function adjustTitle(title, keyword, maxLen = 60) {
  if (!title) title = keyword || '';
  // ensure keyword present
  const hasKeyword = keyword && title.toLowerCase().includes(keyword.toLowerCase());
  if (!hasKeyword && keyword) {
    title = `${keyword} — ${title}`.trim();
  }
  // truncate safely (but keep keyword)
  if (title.length <= maxLen) return title;
  // if keyword present, attempt to keep it
  if (keyword && title.toLowerCase().includes(keyword.toLowerCase())) {
    // try to cut from the end but keep keyword intact
    const idx = title.toLowerCase().indexOf(keyword.toLowerCase());
    // if keyword occurs near end and truncation cuts after it, just cut after keyword
    if (idx + keyword.length <= maxLen) {
      // keep until maxLen
      return title.slice(0, maxLen).trim().replace(/\s+$/,'');
    } else {
      // keyword would be cut — move keyword to front
      let newTitle = `${keyword} - ${title.replace(new RegExp(keyword,'i'), '').trim()}`;
      if (newTitle.length > maxLen) newTitle = newTitle.slice(0, maxLen).trim();
      return newTitle;
    }
  } else {
    // no keyword, simple truncate to last space before maxLen
    const cut = title.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 35 ? cut.slice(0, lastSpace) : cut).trim();
  }
}

// Adjust meta: target ~158 chars, clamp to [140,160] (we choose slightly flexible min)
function adjustMeta(meta, keyword, target = 158, minLen = 140, maxLen = 160) {
  if (!meta) meta = '';
  meta = meta.replace(/\s{2,}/g, ' ').trim();
  // ensure keyword presence
  if (keyword && !meta.toLowerCase().includes(keyword.toLowerCase())) {
    // try to append keyword naturally
    meta = `${meta} — ${keyword}`;
  }
  // If length too long, cut at nearest space before maxLen
  if (meta.length > maxLen) {
    let cut = meta.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > Math.floor(maxLen * 0.6)) cut = cut.slice(0, lastSpace);
    meta = cut.trim();
  }
  // If too short, expand by appending supporting phrase
  if (meta.length < minLen) {
    // add a short CTA + title-ish extension to reach target
    const filler = ' Learn more about this topic and improve your results.';
    meta = (meta + filler).trim();
    if (meta.length > maxLen) meta = meta.slice(0, maxLen).trim();
  }
  // Final trim to ensure not exceeding max
  if (meta.length > maxLen) meta = meta.slice(0, maxLen).trim();
  return meta;
}

// Reuse your existing AI calls (ensure they exist in your file)
async function callGoogle(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('No GEMINI_API_KEY configured');

  const model = process.env.GEMINI_MODEL || 'models/text-bison-001';
  const url = `https://generativelanguage.googleapis.com/v1beta2/${model}:generateText`;
  const body = {
    "prompt": { "text": prompt },
    "maxOutputTokens": parseInt(process.env.GEMINI_MAX_TOKENS || '512', 10),
    "temperature": parseFloat(process.env.GEMINI_TEMPERATURE || '0.6')
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Google API error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content || json?.output?.[0]?.content || JSON.stringify(json);
  return { provider: 'google', raw: text, meta: json };
}

async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY configured');

  const model = process.env.OPENROUTER_MODEL || 'gpt-4o-mini';
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '400', 10),
    temperature: parseFloat(process.env.OPENROUTER_TEMPERATURE || '0.6')
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || JSON.stringify(json);
  return { provider: 'openrouter', raw: text, meta: json };
}

// Parse JSON block from AI model output
function parseJsonFromModel(text) {
  if (!text || typeof text !== 'string') return { raw: text };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (err) { /* fallthrough */ }
  }
  // fallback: try to find lines like "slug: ..." (not ideal)
  return { raw: text };
}

// Build a strict prompt for URL-based generation
function buildPromptForUrl({ main_keyword, title, h1, meta, snippet }) {
  // instruct model to return strict JSON only
  return `You are an expert SEO writer. Using the provided page content below, produce a strict JSON object with these fields:
- "main_keyword": a short phrase (1-4 words) that is the primary keyword for this page. It must EXACTLY match the main keyword you choose.
- "titles": an array of 5 SEO meta titles. Each title MUST include the main_keyword EXACTLY (case may vary). Each title must be <= 60 characters.
- "metas": an array of 3 meta descriptions. Each description MUST include the main_keyword EXACTLY, and each must be between 150 and 160 characters long (aim for ~158). Do not include URLs or extra quotes.
- "slug": a recommended URL-friendly slug (lowercase, hyphens, no spaces), up to 80 characters.

Return ONLY valid JSON (no explanations). Use the content to make titles and metas accurate and compelling.

PAGE CONTENT:
Title tag: "${title || ''}"
H1: "${h1 || ''}"
Meta description: "${meta || ''}"
Page snippet: "${snippet || ''}"

If main_keyword is provided to you, use it exactly. Otherwise select the best main keyword from the content.`;
}

// -------------------- End helpers -------------------- //

// Health route
app.get('/_health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'production' }));

// Existing endpoint: keep original behavior (keyword -> meta-gen)
app.post('/api/meta-gen', async (req, res) => {
  // Keep original behavior: if keyword provided, use existing buildPrompt and flow
  try {
    const { keyword, note } = req.body || {};
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
      return res.status(400).json({ error: 'keyword is required and must be a short string' });
    }
    const trimmedKeyword = keyword.trim().slice(0, 200);
    const trimmedNote = (note || '').trim().slice(0, 1000);
    const key = sha1(`meta:${trimmedKeyword}::${trimmedNote}`);

    const cached = await getCache(key);
    if (cached) return res.json({ fromCache: true, ...cached });

    const prompt = buildPrompt(trimmedKeyword, trimmedNote); // reuse existing prompt function if defined above in your file
    try {
      const g = await callGoogle(prompt);
      const parsed = parseJsonFromModel(g.raw);
      const payload = { provider: g.provider, parsed, meta: g.meta };
      await setCache(key, payload);
      return res.json(payload);
    } catch (err) {
      console.warn('Google failed:', err.message || err);
      try {
        const o = await callOpenRouter(prompt);
        const parsed = parseJsonFromModel(o.raw);
        const payload = { provider: o.provider, parsed, meta: o.meta };
        await setCache(key, payload);
        return res.json(payload);
      } catch (err2) {
        console.error('OpenRouter failed:', err2.message || err2);
        return res.status(500).json({ error: 'All providers failed', detail: err2.message });
      }
    }
  } catch (e) {
    console.error('Internal error', e);
    return res.status(500).json({ error: e.message || 'server error' });
  }
});

// NEW: Endpoint - create title/meta/slug from a URL
app.post('/api/meta-from-url', async (req, res) => {
  try {
    const { url, keyword: providedKeyword, note } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required (full https://...).' });
    }
    // simple URL validation
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'url must start with http:// or https://'});
    }

    const cacheKey = sha1(`urlmeta:${url}::${providedKeyword||''}::${note||''}`);
    const cached = await getCache(cacheKey);
    if (cached) return res.json({ fromCache: true, ...cached });

    // fetch page HTML
    let html;
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'MetaGenTool/1.0 (+https://apextechagency.com)' }, redirect: 'follow' });
      if (!resp.ok) {
        throw new Error(`Unable to fetch URL: status ${resp.status}`);
      }
      html = await resp.text();
    } catch (err) {
      console.error('Fetch failed:', err.message || err);
      return res.status(400).json({ error: 'Failed to fetch the provided URL', detail: err.message });
    }

    // extract content
    const titleTag = extractTitle(html) || '';
    const metaDesc = extractMetaDescription(html) || '';
    const h1 = extractFirstH1(html) || '';
    const snippet = extractBodySnippet(html, 1200) || '';

    // derive keyword
    const derived = deriveKeyword({ h1, title: titleTag, meta: metaDesc, body: snippet });
    const main_keyword = (providedKeyword && providedKeyword.trim()) ? providedKeyword.trim() : (derived || '').trim();
    if (!main_keyword) {
      return res.status(400).json({ error: 'Could not derive a main keyword from the page. Please provide a keyword.' });
    }

    // Build prompt for AI
    const prompt = buildPromptForUrl({ main_keyword, title: titleTag, h1, meta: metaDesc, snippet });

    // Call providers
    let aiResp;
    try {
      aiResp = await callGoogle(prompt);
    } catch (e1) {
      console.warn('Google failed for URL flow:', e1.message || e1);
      try {
        aiResp = await callOpenRouter(prompt);
      } catch (e2) {
        console.error('OpenRouter also failed:', e2.message || e2);
        return res.status(500).json({ error: 'All providers failed', detail: e2.message || e2 });
      }
    }

    const parsed = parseJsonFromModel(aiResp.raw);
    // if parsed doesn't include expected fields, fall back to simple generator
    let titles = (parsed.titles && Array.isArray(parsed.titles)) ? parsed.titles.slice(0,5) : [];
    let metas = (parsed.metas && Array.isArray(parsed.metas)) ? parsed.metas.slice(0,3) : [];
    let slug = (parsed.slug && typeof parsed.slug === 'string') ? parsed.slug : '';

    // Post-process and ensure constraints
    // If titles empty, create simple variants using title/h1 and keyword
    if (titles.length === 0) {
      const base = titleTag || h1 || snippet.split('.')[0] || main_keyword;
      titles = [
        `${main_keyword} – ${base}`.slice(0,60),
        `${main_keyword}: Key Tips & Best Practices`.slice(0,60),
        `How to ${main_keyword} – Complete Guide`.slice(0,60),
        `Top ${main_keyword} Strategies`.slice(0,60),
        `Best ${main_keyword} Resources`.slice(0,60),
      ];
    }

    // adjust each title
    titles = titles.map(t => adjustTitle(String(t), main_keyword, 60));

    // If metas empty, craft simple ones from snippet
    if (metas.length === 0) {
      const short = (metaDesc || snippet).replace(/\s+/g,' ').trim().slice(0,120);
      metas = [
        `${short} Improve results with ${main_keyword}. Learn key tips and best practices for better performance.`.slice(0,158),
        `${short} Discover how ${main_keyword} can boost your outcomes. Get step-by-step guidance and best actions.`.slice(0,158),
        `${short} Use practical ${main_keyword} strategies to increase effectiveness and ROI. Start today.`.slice(0,158)
      ];
    }

    // adjust metas to meet length and include keyword
    metas = metas.map(m => adjustMeta(String(m), main_keyword, 158, 140, 160));

    // ensure slug present
    if (!slug) {
      slug = slugify(`${main_keyword} ${titleTag || h1 || ''}`, 80);
    } else {
      slug = slugify(slug, 80);
    }

    const payload = {
      provider: aiResp.provider || 'unknown',
      main_keyword,
      extracted: { titleTag, h1, metaDesc, snippet },
      titles,
      metas,
      slug,
      note: note || '',
      timestamp: Date.now()
    };

    await setCache(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error('meta-from-url error:', err);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
});

// Root helpful message
app.get('/', (req, res) => res.send('MetaGen Tool API is running. Use POST /api/meta-gen or POST /api/meta-from-url'));





/**
 * URL-based Meta Generator
 * Paste this at the END of server.js
 */
const cheerio = require('cheerio');

app.post('/api/meta-gen-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required and must be a string' });
    }

    // Step 1: Fetch the page
    let html;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      html = await response.text();
    } catch (fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      return res.status(400).json({ error: 'Failed to fetch the provided URL' });
    }

    // Step 2: Load HTML into Cheerio
    const $ = cheerio.load(html);
    const pageTitle = $('title').text().trim() || '';
    const metaDescription = $('meta[name="description"]').attr('content') || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500); // optional sample text

    // Step 3: Build prompt for AI
    const promptText = `
You are an expert SEO copywriter. Analyze the following page and generate:
1) A meta title (<= 60 chars) that includes the main keywords.
2) A meta description (<= 160 chars) optimized for Google.
3) A slug suitable for a blog URL.

Page details:
Title: ${pageTitle}
Meta Description: ${metaDescription}
Content: ${bodyText}

Return ONLY strict JSON:
{"title":"...", "meta":"...", "slug":"..."}
`;

    // Step 4: Call AI (Google or OpenRouter fallback)
    const aiResult = await (async () => {
      try {
        const g = await callGoogle(promptText);
        return g.raw;
      } catch (gErr) {
        console.warn('Google failed, fallback to OpenRouter:', gErr.message || gErr);
        const o = await callOpenRouter(promptText);
        return o.raw;
      }
    })();

    // Step 5: Parse JSON from AI response
    const parsed = parseJsonFromModel(aiResult);

    // Step 6: Return result
    res.json({ provider: 'url-based', parsed });

  } catch (err) {
    console.error('URL meta generation error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});










// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MetaGen server listening on port ${PORT}`));












// Helper: build prompt for AI
function buildPrompt(keyword, note = '', maxTitleChars = 60, maxMetaChars = 160) {
  return `You are an expert SEO copywriter. Generate meta details for a blog post:

Keyword: "${keyword}"
Context: "${note}"

Requirements:
- Generate an array "titles" of 5 meta titles, each <= ${maxTitleChars} characters, include the keyword.
- Generate an array "metas" of 3 meta descriptions, each <= ${maxMetaChars} characters, include the keyword.
- Generate a slug suggestion suitable for a URL.
Return ONLY strict JSON like:
{
  "titles": ["...","..."],
  "metas": ["...","..."],
  "slug": "your-slug-here"
}`;
}










const fetch = global.fetch || require('node-fetch');

// Fetch page and extract main text (title, headings, meta description)
async function scrapePage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Grab text content
    const title = $('title').text() || '';
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const h1 = $('h1').first().text() || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 1000);

    // Combine for AI prompt
    const combined = [title, metaDesc, h1, bodyText].filter(Boolean).join('. ');

    return combined;
  } catch (err) {
    console.error('Scraper failed:', err.message);
    throw new Error('Failed to fetch the provided URL');
  }
}











// Endpoint: Generate meta from URL
app.post('/api/meta-gen-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required and must be a string' });
    }

    // Scrape the page content
    const content = await scrapePage(url);

    // Build AI prompt using scraped content
    const prompt = buildPrompt(content, 'Generate SEO metadata for this page');

    // Call Google AI first
    try {
      const g = await callGoogle(prompt);
      const parsed = parseJsonFromModel(g.raw);
      return res.json({ provider: g.provider, parsed, meta: g.meta });
    } catch (err) {
      console.warn('Google failed:', err.message);
      // fallback to OpenRouter
      const o = await callOpenRouter(prompt);
      const parsed = parseJsonFromModel(o.raw);
      return res.json({ provider: o.provider, parsed, meta: o.meta });
    }
  } catch (err) {
    console.error('URL meta-gen error', err);
    res.status(500).json({ error: err.message });
  }
});













