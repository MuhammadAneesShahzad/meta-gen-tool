Render deployment quick guide:

1. Create GitHub repo and push all files.
2. Sign in to Render (https://render.com) and create New → Web Service.
3. Connect your repo and select branch (main).
4. Set:
   - Environment: Node
   - Build Command: npm install
   - Start Command: npm start
5. In Render dashboard → Environment → add the following env vars:
   - GEMINI_API_KEY (your Google AI Studio API key)
   - GEMINI_MODEL (optional)
   - OPENROUTER_API_KEY
   - OPENROUTER_MODEL (optional)
   - REDIS_URL (optional, if you use Upstash)
   - ALLOWED_ORIGINS (e.g. https://yourdomain.com)
6. Deploy.
7. After deploy finish, find your Render URL e.g. https://meta-gen-tool.onrender.com
8. Test:
   curl -X POST https://meta-gen-tool.onrender.com/api/meta-gen -H "Content-Type: application/json" -d '{"keyword":"best wordpress hosting","note":"SEO tool"}'
