/**
 * meta-gen-tool - server.js
 * Node 18+ (uses global fetch)
 *
 * Quick: set ENV vars (see .env.example) and run: node server.js
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
app.use(express.json({ limit: '10kb' }));

// CORS - adjust to restrict to your domain in production
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true
}));

// Rate limiting: basic abuse prevention
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10), // per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Optional Redis for caching
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e.message || e));
}

// Helpers
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SEC || `${60 * 60 * 24}`, 10); // default 24h

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function getCache(k) {
  if (!redis) return null;
  try {
    const v = await redis.get(k);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    console.warn('Cache read error', e.message || e);
    return null;
  }
}
async function setCache(k, v, ttl = CACHE_TTL) {
  if (!redis) return;
  try {
    await redis.set(k, JSON.stringify(v), 'EX', ttl);
  } catch (e) {
    console.warn('Cache write error', e.message || e);
  }
}

// Build the prompt for models
function buildPrompt(keyword, note) {
  return `You are an expert SEO copywriter. For the keyword: "${keyword}", create:
1) An array called "titles" with 5 clickable meta titles (each <= 60 characters).
2) An array called "metas" with 3 meta descriptions (each <= 160 characters).
Return RESULT as strict JSON object ONLY. Example:
{"titles":["...","..."], "metas":["...","..."]}

Context: ${note || 'none'}. Respond ONLY with JSON.`;
}

// Parse JSON block from model text
function parseJsonFromModel(text) {
  if (!text || typeof text !== 'string') return { raw: text };
  // Try to find the first JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (err) {
      // fallback to raw text
    }
  }
  return { raw: text };
}

// Call Google Generative Language / Gemini (REST)
// NOTE: model path and endpoint can vary by Google API releases — supply GEMINI_MODEL env var
async function callGoogle(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('No GEMINI_API_KEY configured');

  const model = process.env.GEMINI_MODEL || 'models/text-bison-001'; // change if you have other models
  const url = `https://generativelanguage.googleapis.com/v1beta2/${model}:generateText`;
  // request body - keep small tokens
  const body = {
    "prompt": { "text": prompt },
    "maxOutputTokens": parseInt(process.env.GEMINI_MAX_TOKENS || '512', 10),
    "temperature": parseFloat(process.env.GEMINI_TEMPERATURE || '0.6')
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Google API error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  // generative language returns 'candidates' or text in different fields — try to extract
  const text = json?.candidates?.[0]?.content || json?.output?.[0]?.content || JSON.stringify(json);
  return { provider: 'google', raw: text, meta: json };
}

// Call OpenRouter (Chat completions)
async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY configured');

  const model = process.env.OPENROUTER_MODEL || 'gpt-4o-mini'; // change to a model you have access to
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '400', 10),
    temperature: parseFloat(process.env.OPENROUTER_TEMPERATURE || '0.6')
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
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

// Endpoint: health
app.get('/_health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'production' }));

// Main endpoint: meta generator
app.post('/api/meta-gen', async (req, res) => {
  try {
    const { keyword, note } = req.body || {};
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
      return res.status(400).json({ error: 'keyword is required and must be a short string' });
    }
    const trimmedKeyword = keyword.trim().slice(0, 200);
    const trimmedNote = (note || '').trim().slice(0, 1000);
    const key = sha1(`${trimmedKeyword}::${trimmedNote}`);

    // cache
    const cached = await getCache(`meta:${key}`);
    if (cached) return res.json({ fromCache: true, ...cached });

    const prompt = buildPrompt(trimmedKeyword, trimmedNote);

    // Try Google first
    try {
      const g = await callGoogle(prompt);
      const parsed = parseJsonFromModel(g.raw);
      const payload = { provider: g.provider, parsed, meta: g.meta };
      await setCache(`meta:${key}`, payload);
      return res.json(payload);
    } catch (err) {
      console.warn('Google failed:', err.message || err);
      // fallback to OpenRouter
      try {
        const o = await callOpenRouter(prompt);
        const parsed = parseJsonFromModel(o.raw);
        const payload = { provider: o.provider, parsed, meta: o.meta };
        await setCache(`meta:${key}`, payload);
        return res.json(payload);
      } catch (err2) {
        console.error('OpenRouter failed:', err2.message || err2);
        return res.status(500).json({ error: 'All providers failed', detail: err2.message });
      }
    }
  } catch (e) {
    console.error('Internal error', e);
    res.status(500).json({ error: e.message || 'server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MetaGen server listening on port ${PORT}`));


app.get("/", (req, res) => {
  res.send("MetaGen Tool API is running! Use the /generate endpoint to generate meta titles & descriptions.");
});



