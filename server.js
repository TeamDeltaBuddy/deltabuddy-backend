/**
 * DeltaBuddy Backend — Railway.app
 * Handles: NSE option chain, Yahoo Finance, Groq AI proxy
 * All CORS-safe, cookie-managed, rate-limited
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: '*', // Lock this down after Firebase auth is set up
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// Rate limiting — prevent abuse
const limiter = rateLimit({ windowMs: 60*1000, max: 120, message: { error: 'Too many requests' } });
app.use(limiter);

// ── NSE Cookie Management ─────────────────────────────────────────────────────
let nseCookies   = '';
let nseLastFetch = 0;
const NSE_COOKIE_TTL = 4 * 60 * 1000; // refresh every 4 minutes

const NSE_BASE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://www.nseindia.com/option-chain',
  'X-Requested-With': 'XMLHttpRequest',
  'Connection'     : 'keep-alive',
};

async function getNSECookies() {
  const now = Date.now();
  if (nseCookies && (now - nseLastFetch) < NSE_COOKIE_TTL) return nseCookies;

  try {
    console.log('[NSE] Refreshing cookies...');
    const res = await fetch('https://www.nseindia.com', {
      headers: {
        'User-Agent': NSE_BASE_HEADERS['User-Agent'],
        'Accept'    : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
    });
    const raw = res.headers.raw()['set-cookie'] || [];
    nseCookies   = raw.map(c => c.split(';')[0]).join('; ');
    nseLastFetch = now;
    console.log('[NSE] Cookies refreshed ✅');
  } catch(e) {
    console.error('[NSE] Cookie fetch failed:', e.message);
  }
  return nseCookies;
}

// ── NSE Option Chain ──────────────────────────────────────────────────────────
const INDEX_SYMBOLS  = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','NIFTYIT'];

app.get('/api/option-chain', async (req, res) => {
  const symbol  = (req.query.symbol || 'NIFTY').toUpperCase();
  const isIndex = INDEX_SYMBOLS.includes(symbol);
  const apiUrl  = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;

  try {
    const cookies = await getNSECookies();
    const response = await fetch(apiUrl, {
      headers: { ...NSE_BASE_HEADERS, Cookie: cookies },
      timeout: 15000,
    });

    if (!response.ok) {
      // Try refreshing cookies once on auth failure
      if (response.status === 401 || response.status === 403) {
        nseLastFetch = 0; // force refresh
        const freshCookies = await getNSECookies();
        const retry = await fetch(apiUrl, {
          headers: { ...NSE_BASE_HEADERS, Cookie: freshCookies },
          timeout: 15000,
        });
        if (!retry.ok) throw new Error(`NSE returned ${retry.status} after cookie refresh`);
        const data = await retry.json();
        return res.json(data);
      }
      throw new Error(`NSE returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch(err) {
    console.error('[NSE Option Chain Error]', err.message);
    res.status(502).json({ error: 'NSE fetch failed', detail: err.message });
  }
});

// ── NSE Live Quote (for spot price) ──────────────────────────────────────────
app.get('/api/quote', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  const apiUrl = `https://www.nseindia.com/api/quote-derivative?symbol=${symbol}`;
  try {
    const cookies = await getNSECookies();
    const response = await fetch(apiUrl, {
      headers: { ...NSE_BASE_HEADERS, Cookie: cookies },
      timeout: 10000,
    });
    if (!response.ok) throw new Error(`NSE quote returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch(err) {
    res.status(502).json({ error: 'NSE quote failed', detail: err.message });
  }
});

// ── Yahoo Finance Proxy ───────────────────────────────────────────────────────
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  'Accept'    : 'application/json, text/plain, */*',
};

app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { interval = '5m', range = '1d' } = req.query;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch(err) {
    res.status(502).json({ error: 'Yahoo fetch failed', detail: err.message });
  }
});

app.get('/api/yahoo/options/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch(err) {
    res.status(502).json({ error: 'Yahoo options failed', detail: err.message });
  }
});

app.get('/api/yahoo/quote/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  try {
    const response = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const price  = result?.meta?.regularMarketPrice || null;
    const change = result?.meta?.regularMarketChangePercent || null;
    res.json({ price, change, symbol });
  } catch(err) {
    res.status(502).json({ error: 'Yahoo quote failed', detail: err.message });
  }
});

// ── Groq AI Proxy ─────────────────────────────────────────────────────────────
app.post('/api/groq', async (req, res) => {
  const apiKey = req.headers['x-groq-key'] || req.headers['authorization']?.replace('Bearer ','');
  if (!apiKey) return res.status(401).json({ error: 'Groq API key required' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
      body   : JSON.stringify(req.body),
      timeout: 30000,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(err) {
    res.status(502).json({ error: 'Groq proxy failed', detail: err.message });
  }
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status   : 'ok',
    service  : 'DeltaBuddy Backend',
    version  : '1.0.0',
    timestamp: new Date().toISOString(),
    uptime   : Math.floor(process.uptime()) + 's',
  });
});

// ── NewsAPI Proxy ─────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { q, apiKey, pageSize = 10 } = req.query;
  if (!apiKey) return res.status(401).json({ error: 'NewsAPI key required' });
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${apiKey}`;
  try {
    const response = await fetch(url, { timeout: 10000 });
    const data = await response.json();
    res.json(data);
  } catch(err) {
    res.status(502).json({ error: 'NewsAPI failed', detail: err.message });
  }
});

// ── Telegram Proxy ────────────────────────────────────────────────────────────
// Bot token lives ONLY here as env var — never exposed to frontend users
app.post('/api/telegram', async (req, res) => {
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(503).json({ error: 'TG_BOT_TOKEN not set on server' });

  const { chat_id, text, parse_mode = 'HTML' } = req.body;
  if (!chat_id || !text) return res.status(400).json({ error: 'chat_id and text required' });

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ chat_id, text, parse_mode, disable_web_page_preview: true }),
      }
    );
    const data = await response.json();
    if (!data.ok) return res.status(400).json({ error: data.description || 'Telegram error' });
    res.json({ ok: true });
  } catch(err) {
    res.status(502).json({ error: 'Telegram proxy failed', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DeltaBuddy Backend running on port ${PORT}`);
  console.log(`📊 NSE Option Chain: http://localhost:${PORT}/api/option-chain?symbol=NIFTY`);
  console.log(`📈 Yahoo Chart:      http://localhost:${PORT}/api/yahoo/chart/^NSEI`);
  console.log(`❤️  Health:          http://localhost:${PORT}/api/health\n`);
  // Pre-fetch NSE cookies on startup
  getNSECookies();
});
