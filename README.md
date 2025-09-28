# Meta Title & Description Generator (Render-ready)

This repository contains a small Node.js API that generates SEO meta titles and descriptions using Google Gemini (primary) with OpenRouter as a fallback. It's built to be deployed to Render (or another host) and used by a frontend widget / iframe.

## Features
- Primary provider: Google Gemini (Generative Language API)
- Fallback: OpenRouter
- Optional Redis caching (via REDIS_URL)
- Per-IP rate limiting
- Minimal, secure server (keys kept server-side)

## Quick start (local)
1. Copy `.env.example` to `.env` and fill your API keys.
2. Install deps:
