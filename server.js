/**
 * DeltaBuddy Backend
 * NSE Option Chain + Yahoo Finance + Groq AI + Angel One WebSocket
 */

const express   = require('express');
const cors      = require('cors');
const fetch     = require('node-fetch');
const WebSocket = require('ws');
const { totp }  = require('otplib');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','x-groq-key'] }));
const limiter = rateLimit({ windowMs: 60*1000, max: 200, message: { error: 'Too many requests' } });
app.use(limiter);

// ══════════════════════════════════════════════════════════════════════════════
// DHAN BROKER INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════

const DHAN_CLIENT_ID    = process.env.DHAN_CLIENT_ID;
const DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
const DHAN_BASE_URL     = process.env.DHAN_BASE_URL || 'https://api.dhan.co';

// Helper: make authenticated Dhan API call
async function dhanAPI(path, method = 'GET', body = null) {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) throw new Error('Dhan credentials not configured');
  const opts = {
    method,
    headers: {
      'Content-Type'  : 'application/json',
      'access-token'  : DHAN_ACCESS_TOKEN,
      'client-id'     : DHAN_CLIENT_ID,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${DHAN_BASE_URL}${path}`, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch(e) { throw new Error(`Dhan API error ${r.status}: ${text.substring(0,200)}`); }
}

// GET /api/dhan/status
app.get('/api/dhan/status', (req, res) => {
  res.json({
    configured : !!(DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN),
    clientId   : DHAN_CLIENT_ID || 'NOT SET',
    baseUrl    : DHAN_BASE_URL,
  });
});

// GET /api/dhan/funds — account balance and limits
app.get('/api/dhan/funds', async (req, res) => {
  try {
    const data = await dhanAPI('/v2/fundlimit');
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/dhan/positions — current open positions
app.get('/api/dhan/positions', async (req, res) => {
  try {
    const data = await dhanAPI('/v2/positions');
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/dhan/holdings — equity holdings
app.get('/api/dhan/holdings', async (req, res) => {
  try {
    const data = await dhanAPI('/v2/holdings');
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/dhan/orders — order book
app.get('/api/dhan/orders', async (req, res) => {
  try {
    const data = await dhanAPI('/v2/orders');
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/dhan/portfolio — combined funds + positions + holdings
app.get('/api/dhan/portfolio', async (req, res) => {
  try {
    const [funds, positions, holdings] = await Promise.all([
      dhanAPI('/v2/fundlimit').catch(e => ({ error: e.message })),
      dhanAPI('/v2/positions').catch(e => ({ error: e.message })),
      dhanAPI('/v2/holdings').catch(e => ({ error: e.message })),
    ]);
    res.json({ funds, positions, holdings });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/dhan/order — place an order
app.post('/api/dhan/order', async (req, res) => {
  try {
    const data = await dhanAPI('/v2/orders', 'POST', req.body);
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// DELETE /api/dhan/order/:orderId — cancel an order
app.delete('/api/dhan/order/:orderId', async (req, res) => {
  try {
    const data = await dhanAPI(`/v2/orders/${req.params.orderId}`, 'DELETE');
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── MAX PAIN + EXPIRY TOOLS — defined after getNSECookies below ───────────────



// ── NSE Cookie Management ─────────────────────────────────────────────────────
let nseCookies = '', nseLastFetch = 0;
const NSE_COOKIE_TTL = 4 * 60 * 1000;
const NSE_BASE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://www.nseindia.com/option-chain',
  'X-Requested-With': 'XMLHttpRequest',
};

async function getNSECookies() {
  if (nseCookies && (Date.now() - nseLastFetch) < NSE_COOKIE_TTL) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': NSE_BASE_HEADERS['User-Agent'], 'Accept': 'text/html,*/*' },
      timeout: 10000,
    });
    const raw = res.headers.raw()['set-cookie'] || [];
    nseCookies   = raw.map(c => c.split(';')[0]).join('; ');
    nseLastFetch = Date.now();
  } catch(e) { console.error('[NSE] Cookie fail:', e.message); }
  return nseCookies;
}

const INDEX_SYMBOLS = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','NIFTYIT'];

app.get('/api/option-chain', async (req, res) => {
  const symbol  = (req.query.symbol || 'NIFTY').toUpperCase();
  const isIndex = INDEX_SYMBOLS.includes(symbol);
  const apiUrl  = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;
  try {
    const cookies = await getNSECookies();
    const response = await fetch(apiUrl, { headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 15000 });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        nseLastFetch = 0;
        const fresh = await getNSECookies();
        const retry = await fetch(apiUrl, { headers: { ...NSE_BASE_HEADERS, Cookie: fresh }, timeout: 15000 });
        if (!retry.ok) throw new Error(`NSE ${retry.status} after retry`);
        return res.json(await retry.json());
      }
      throw new Error(`NSE ${response.status}`);
    }
    res.json(await response.json());
  } catch(e) {
    res.status(502).json({ error: 'NSE fetch failed', detail: e.message });
  }
});

app.get('/api/quote', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  try {
    const cookies = await getNSECookies();
    const r = await fetch(`https://www.nseindia.com/api/quote-derivative?symbol=${symbol}`, {
      headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 10000,
    });
    if (!r.ok) throw new Error(`NSE quote ${r.status}`);
    res.json(await r.json());
  } catch(e) { res.status(502).json({ error: 'NSE quote failed', detail: e.message }); }
});

// ── Yahoo Finance ──────────────────────────────────────────────────────────────
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

// Helper: fetch one symbol — returns {price, change, prevClose} or null
async function fetchYahooQuote(symbol) {
  // Use range=5d so previousClose is always populated in meta
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || null;
    // Calculate change from prevClose (most reliable)
    let change = 0;
    if (prevClose && prevClose > 0) {
      change = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));
    } else if (meta.regularMarketChangePercent) {
      change = parseFloat(meta.regularMarketChangePercent.toFixed(2));
    }
    return { price: Math.round(price), change, prevClose: prevClose ? Math.round(prevClose) : null };
  } catch(e) { return null; }
}

app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  const { interval = '5m', range = '1d' } = req.query;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.params.symbol)}?interval=${interval}&range=${range}`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    res.json(await r.json());
  } catch(e) { res.status(502).json({ error: 'Yahoo failed', detail: e.message }); }
});

// Batch price endpoint — returns price+change+prevClose for multiple symbols at once
// Usage: GET /api/prices?symbols=RELIANCE.NS,TCS.NS,^NSEI
app.get('/api/prices', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  const results = {};
  // Fetch in parallel, 8 at a time to avoid rate limits
  const CHUNK = 8;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const fetched = await Promise.all(chunk.map(sym => fetchYahooQuote(sym)));
    chunk.forEach((sym, idx) => { if (fetched[idx]) results[sym] = fetched[idx]; });
  }
  res.json(results);
});

app.get('/api/yahoo/quote/:symbol', async (req, res) => {
  const data = await fetchYahooQuote(req.params.symbol);
  if (!data) return res.status(502).json({ error: 'Yahoo quote failed' });
  res.json({ ...data, symbol: req.params.symbol });
});

// ── Groq AI Proxy ──────────────────────────────────────────────────────────────
app.post('/api/groq', async (req, res) => {
  const apiKey = req.headers['x-groq-key'] || req.headers['authorization']?.replace('Bearer ','');
  if (!apiKey) return res.status(401).json({ error: 'Groq key required' });
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
      body   : JSON.stringify(req.body),
      timeout: 30000,
    });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(502).json({ error: 'Groq proxy failed', detail: e.message }); }
});

// ── Gemini Flash AI Proxy ──────────────────────────────────────────────────────
app.post('/api/gemini', async (req, res) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ contents: [{ parts: [{ text: req.body.prompt }] }] }),
      timeout: 20000,
    });
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ text });
  } catch(e) { res.status(502).json({ error: 'Gemini failed', detail: e.message }); }
});

// ── AI helper: Groq first, Gemini fallback ─────────────────────────────────────
function fetchWithTimeout(url, options, ms = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    fetch(url, options)
      .then(r  => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function askAI(prompt, groqModel = 'llama-3.1-8b-instant') {
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  // Try Groq first
  if (GROQ_KEY) {
    try {
      const r = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body   : JSON.stringify({
            model      : groqModel,
            messages   : [{ role: 'user', content: prompt }],
            max_tokens : 300,
            temperature: 0.1,
          }),
        },
        12000
      );
      if (r.ok) {
        const d    = await r.json();
        const text = d?.choices?.[0]?.message?.content || '';
        if (text) { console.log('[AI] Groq ok'); return text; }
        console.warn('[AI] Groq empty:', JSON.stringify(d).substring(0, 200));
      } else {
        const err = await r.text();
        console.warn(`[AI] Groq ${r.status}:`, err.substring(0, 200));
      }
    } catch(e) { console.warn('[AI] Groq error:', e.message); }
  } else {
    console.warn('[AI] GROQ_API_KEY missing');
  }

  // Fallback to Gemini Flash
  if (GEMINI_KEY) {
    try {
      const r = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({
            contents        : [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
          }),
        },
        15000
      );
      if (r.ok) {
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) { console.log('[AI] Gemini ok'); return text; }
        console.warn('[AI] Gemini empty:', JSON.stringify(data).substring(0, 200));
      } else {
        const err = await r.text();
        console.warn(`[AI] Gemini ${r.status}:`, err.substring(0, 200));
      }
    } catch(e) { console.warn('[AI] Gemini error:', e.message); }
  } else {
    console.warn('[AI] GEMINI_API_KEY missing');
  }

  return null;
}



// ── ALERT ENGINE — RSS-based, AI-first smart filtering ────────────────────────

const RSS_FEEDS = [
  // Reuters — globally accessible, finance-focused
  'https://feeds.reuters.com/reuters/businessNews',
  'https://feeds.reuters.com/reuters/INtopNews',
  // Financial Times RSS
  'https://www.ft.com/rss/home/uk',
  // Yahoo Finance India
  'https://finance.yahoo.com/rss/2.0/headline?s=^NSEI&region=IN&lang=en-IN',
  // Investing.com India news
  'https://www.investing.com/rss/news_25.rss',
  // NDTV Business
  'https://feeds.feedburner.com/ndtvprofit-latest',
];

// First-pass filter — only pass news that could plausibly move markets
const BROAD_RELEVANCE_KEYWORDS = [
  // Indian indices & regulators
  'nifty','sensex','nse','bse','rbi','sebi',
  // Global macro
  'fed reserve','federal reserve','interest rate','repo rate','inflation','gdp',
  'imf','world bank','opec','oil price','crude oil','crude price',
  // Geopolitical at country/global level only
  'war','airstrike','missile','nuclear','sanctions','trade war','tariff',
  'iran','russia','ukraine','china','pakistan','nato','israel',
  // Heavy-weight stocks — only major news
  'reliance industries','adani group','adani enterprises','tata group',
  'hdfc bank','icici bank','sbi bank','infosys','wipro',
  // Market events
  'market crash','circuit breaker','trading halt','stock market',
  'fii','dii','foreign investor','rupee falls','rupee crashes',
  'default','bankruptcy','fraud','scam','ponzi',
];

// Hard block — these topics can NEVER be market-moving regardless of keywords
const DEFINITE_NOISE = [
  // Local accidents & crime
  'car accident','road accident','overturns','speeding car','divider','pothole',
  'bike accident','truck accident','train accident','plane crash investigation',
  'murder','rape','assault','robbery','theft','arrested','police','fir filed',
  'court hearing','bail','acquitted','sentenced',
  // Local politics & government
  'cm visits','pm visits','minister inaugurates','ribbon cutting','yojana',
  'village','gram panchayat','municipal corporation','ward',
  // Entertainment & lifestyle
  'cricket','ipl','football','sports','film','bollywood','celebrity',
  'wedding','divorce','actor','actress','singer','web series',
  'recipe','travel','fashion','lifestyle','horoscope',
  'temple','mosque','church','religious','festival celebration',
  // Health (unless epidemic-scale)
  'hospital','doctor','patient','surgery','disease','covid case',
  'health tips','fitness','diet','yoga',
  // Weather (unless catastrophic)
  'rain','flood warning','weather forecast','temperature',
];

const sentAlerts  = new Set();
let engineStarted = false;

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function fetchRSSFeed(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeltaBuddy/1.0)' },
      timeout: 8000,
    });
    if (!r.ok) return [];
    const xml  = await r.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title       = (block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title[^>]*>(.*?)<\/title>/))?.[1]?.trim() || '';
      const description = (block.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description[^>]*>(.*?)<\/description>/))?.[1]?.replace(/<[^>]+>/g,'').trim() || '';
      const pubDate     = (block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/))?.[1]?.trim() || '';
      const link        = (block.match(/<link[^>]*>(.*?)<\/link>/))?.[1]?.trim() || '';
      if (title) items.push({ title, description: description.substring(0, 400), pubDate, link });
    }
    return items;
  } catch(e) { return []; }
}

// Pre-filter before calling AI — saves API calls
function passesPreFilter(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  if (DEFINITE_NOISE.some(n => text.includes(n))) return false;
  return BROAD_RELEVANCE_KEYWORDS.some(kw => text.includes(kw));
}

// AI is the REAL judge — reads context, not just keywords
async function aiJudge(title, description) {
  const prompt = `You are a strict Indian stock market alert filter. Your job is to BLOCK irrelevant news, not find creative ways to connect it to markets.

Rate this news 1-10 for DIRECT and IMMEDIATE impact on Nifty50/BankNifty/Sensex TODAY.

HEADLINE: ${title}
DETAILS: ${description.substring(0, 200)}

SCORING RULES — read carefully:
✅ Score 8-10 ONLY: War/airstrike, RBI/Fed emergency rate action, Nifty circuit breaker, Adani/Reliance crisis (like Russia oil ban), major bank collapse, oil price shock >5%
✅ Score 6-7: Scheduled RBI/Fed rate decision surprise, major corporate fraud discovery, OPEC output cut, rupee crash >2%
⚠️ Score 3-5: Routine earnings results, regular economic data, expected policy decisions
❌ Score 1-2: Local accidents, crime, weather, sports, entertainment, local politics, hospital news, road accidents, state-level news, anything without direct financial impact

CRITICAL: Do NOT invent indirect market connections. A car accident is NOT oil market news. A local murder is NOT a market event. A temple inauguration is NOT bullish. Score these 1-2 and move on.

Reply ONLY in JSON:
{"score":2,"impact":"neutral","reason":"local road accident, zero market relevance","sectors":"none","action":"ignore"}

impact must be: bullish, bearish, or neutral`;

  try {
    const response = await askAI(prompt);
    if (!response) return null;
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) { console.warn('[Alert] No JSON in AI response:', response.substring(0,100)); return null; }
    const json = JSON.parse(jsonMatch[0]);
    if (typeof json.score !== 'number') return null;
    return json;
  } catch(e) {
    console.warn('[Alert] aiJudge parse failed:', e.message);
    return null;
  }
}

async function sendTelegramAlert(chatIds, message) {
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  if (!BOT_TOKEN || !chatIds?.length) return;
  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
    } catch(e) { console.warn('[TG] Send failed:', e.message); }
  }
}

// In-memory subscriber store — seeded from env var on startup
// TG_CHAT_IDS = comma-separated list e.g. "123456789,987654321"
const alertSubscribers = new Set(
  (process.env.TG_CHAT_IDS || process.env.TG_CHAT_ID || '')
    .split(',').map(x => x.trim()).filter(Boolean)
);

console.log(`[Alerts] Loaded ${alertSubscribers.size} subscriber(s) from env vars.`);

// POST /api/alert-subscribe
app.post('/api/alert-subscribe', (req, res) => {
  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  alertSubscribers.add(String(chat_id));
  console.log(`[Alerts] Subscriber added: ${chat_id} — total: ${alertSubscribers.size}`);
  res.json({ ok: true, subscribers: alertSubscribers.size });
});

// GET /api/alert-subscribers
app.get('/api/alert-subscribers', (req, res) => {
  res.json({ count: alertSubscribers.size, ids: [...alertSubscribers] });
});

// GET /api/alert-status — debug
app.get('/api/alert-status', (req, res) => {
  res.json({
    subscribers     : alertSubscribers.size,
    subscriberIds   : [...alertSubscribers],
    sentAlertsCount : sentAlerts.size,
    engineStarted,
    feeds           : RSS_FEEDS.length,
    groqKeySet      : !!process.env.GROQ_API_KEY,
    geminiKeySet    : !!process.env.GEMINI_API_KEY,
    tgBotSet        : !!process.env.TG_BOT_TOKEN,
    tgChatIdEnv     : process.env.TG_CHAT_ID || process.env.TG_CHAT_IDS || 'NOT SET',
  });
});

// GET /api/alert-test — manually fire a test alert to all subscribers
app.get('/api/alert-test', async (req, res) => {
  if (!alertSubscribers.size) {
    return res.json({ ok: false, error: 'No subscribers. Add TG_CHAT_ID to Render env vars or subscribe via frontend.' });
  }
  const msg = `✅ <b>DeltaBuddy Alert Engine — TEST</b>

🔔 Alert system is working correctly.
👥 Subscribers: ${alertSubscribers.size}
📡 Feeds: ${RSS_FEEDS.length}
🕐 ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

You will receive alerts when high-impact market news breaks.`;

  await sendTelegramAlert([...alertSubscribers], msg);
  res.json({ ok: true, sent_to: [...alertSubscribers] });
});

// GET /api/ai-test — verify AI keys are working
app.get('/api/ai-test', async (req, res) => {
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const results    = { groq: null, gemini: null };

  if (GROQ_KEY) {
    try {
      const r = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body   : JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 }),
        },
        10000
      );
      const body = await r.text();
      results.groq = { status: r.status, ok: r.ok, body: body.substring(0, 300) };
    } catch(e) { results.groq = { error: e.message }; }
  } else { results.groq = { error: 'GROQ_API_KEY not set' }; }

  if (GEMINI_KEY) {
    try {
      const r = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] }),
        },
        12000
      );
      const body = await r.text();
      results.gemini = { status: r.status, ok: r.ok, body: body.substring(0, 300) };
    } catch(e) { results.gemini = { error: e.message }; }
  } else { results.gemini = { error: 'GEMINI_API_KEY not set' }; }

  res.json(results);
});

// GET /api/alert-reset — clear seen items so current news gets re-evaluated
app.get('/api/alert-reset', (req, res) => {
  const before = sentAlerts.size;
  sentAlerts.clear();
  console.log(`[Alerts] Reset — cleared ${before} seen items`);
  res.json({ ok: true, clearedItems: before, message: 'Seen list cleared. Next engine cycle will re-evaluate all current news.' });
});

// GET /api/alert-run — manually trigger one scan cycle
app.get('/api/alert-run', async (req, res) => {
  const before = sentAlerts.size;
  await runAlertEngine(false);
  res.json({ ok: true, subscribers: alertSubscribers.size, seenBefore: before, seenAfter: sentAlerts.size });
});

// GET /api/alert-run — manually trigger one scan cycle
app.get('/api/alert-run', async (req, res) => {
  const before = sentAlerts.size;
  await runAlertEngine(false);
  res.json({ ok: true, subscribers: alertSubscribers.size, seenBefore: before, seenAfter: sentAlerts.size });
});

// GET /api/alert-dryrun — scan latest RSS and show AI scores WITHOUT sending alerts
app.get('/api/alert-dryrun', async (req, res) => {
  try {
    const allItems = [];
    for (const feed of RSS_FEEDS) {
      const items = await fetchRSSFeed(feed);
      allItems.push(...items);
    }
    // Take latest 10 that pass pre-filter, ignore dedup
    const candidates = allItems
      .filter(item => passesPreFilter(item.title, item.description))
      .slice(0, 10);

    const results = [];
    for (const item of candidates) {
      const ai = await aiJudge(item.title, item.description);
      results.push({
        title  : item.title,
        score  : ai?.score ?? 'AI_FAILED',
        impact : ai?.impact ?? '-',
        reason : ai?.reason ?? '-',
        action : ai?.action ?? '-',
        wouldSend: ai?.score >= 6,
      });
      await new Promise(r => setTimeout(r, 500));
    }
    res.json({ total_fetched: allItems.length, candidates: candidates.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function runAlertEngine(isStartup = false) {
  if (!alertSubscribers.size) return;

  const allItems = [];
  for (const feed of RSS_FEEDS) {
    const items = await fetchRSSFeed(feed);
    allItems.push(...items);
  }

  // Startup: silently mark all current items as seen — no alerts on restart
  if (isStartup) {
    let wouldAlert = 0;
    for (const item of allItems) {
      sentAlerts.add(hashStr(item.title));
      if (passesPreFilter(item.title, item.description)) wouldAlert++;
    }
    console.log(`[Alerts] Startup — ${allItems.length} items marked seen (${wouldAlert} passed pre-filter). Watching for NEW news.`);
    return;
  }

  // Step 1: dedup only — don't filter by age (RSS feeds cache articles 15-30 mins)
  const fresh = allItems.filter(item => {
    const h = hashStr(item.title);
    if (sentAlerts.has(h)) return false;
    return true;
  });

  if (!fresh.length) return;

  // Step 2: cheap pre-filter (no API call)
  const candidates = fresh.filter(item => {
    if (!passesPreFilter(item.title, item.description)) {
      sentAlerts.add(hashStr(item.title));
      return false;
    }
    return true;
  });

  if (!candidates.length) return;
  console.log(`[Alerts] ${candidates.length} candidate(s) → sending to AI judge...`);

  // Step 3: AI is the real gate
  for (const item of candidates.slice(0, 5)) {
    sentAlerts.add(hashStr(item.title));

    const ai = await aiJudge(item.title, item.description);

    if (!ai) {
      console.log(`[Alerts] AI failed for: ${item.title}`);
      continue;
    }

    console.log(`[Alerts] Score ${ai.score}/10 (${ai.impact}): ${item.title}`);

    if (ai.score < 7) continue; // below threshold — skip silently

    // Format and send
    const emoji = ai.impact === 'bearish' ? '🔴' : ai.impact === 'bullish' ? '🟢' : '🟡';
    const urgency = ai.score >= 9 ? '🚨 BREAKING' : ai.score >= 8 ? '⚠️ ALERT' : '📊 UPDATE';
    const scoreBar = '█'.repeat(ai.score - 5) + '░'.repeat(10 - ai.score);

    const msg =
`${emoji} <b>${urgency} — ${ai.impact.toUpperCase()}</b>

📰 <b>${item.title}</b>

📊 Impact: ${ai.score}/10  ${scoreBar}
💡 ${ai.reason}
🏭 Sectors: ${ai.sectors}
⚡ Action: <b>${ai.action}</b>

🕐 ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
<a href="${item.link}">Read full story →</a>`;

    await sendTelegramAlert([...alertSubscribers], msg);
    console.log(`[Alerts] ✅ SENT (${ai.score}/10): ${item.title}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (sentAlerts.size > 1000) {
    const arr = [...sentAlerts];
    arr.slice(0, 500).forEach(h => sentAlerts.delete(h));
  }
}

function startAlertEngine() {
  if (engineStarted) return;
  engineStarted = true;
  console.log('[Alerts] Engine starting...');
  runAlertEngine(true).then(() => {
    console.log('[Alerts] Watching for breaking news every 3 minutes.');
    setInterval(() => runAlertEngine(false), 3 * 60 * 1000);
  });
}




// ── RSS News Endpoint — free, no API key ───────────────────────────────────────
app.get('/api/rss-news', async (req, res) => {
  try {
    const allItems = [];
    for (const feed of RSS_FEEDS.slice(0, 4)) { // use first 4 feeds
      const items = await fetchRSSFeed(feed);
      allItems.push(...items);
    }
    // Deduplicate by title, sort by date, take top 20
    const seen = new Set();
    const articles = allItems
      .filter(item => { if (seen.has(item.title)) return false; seen.add(item.title); return true; })
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 20)
      .map(item => ({
        url        : item.link,
        title      : item.title,
        description: item.description,
        source     : { name: new URL(item.link || 'https://example.com').hostname.replace('www.','') },
        publishedAt: item.pubDate || new Date().toISOString(),
      }));
    res.json({ articles });
  } catch(e) {
    res.status(502).json({ articles: [], error: e.message });
  }
});


app.post('/api/telegram', async (req, res) => {
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(503).json({ error: 'TG_BOT_TOKEN not set' });
  const { chat_id, text, parse_mode = 'HTML' } = req.body;
  if (!chat_id || !text) return res.status(400).json({ error: 'chat_id and text required' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id, text, parse_mode, disable_web_page_preview: true }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: data.description });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: 'Telegram failed', detail: e.message }); }
});

// ── F&O Ban List ───────────────────────────────────────────────────────────────
app.get('/api/nse/fno-ban', async (req, res) => {
  try {
    const url = 'https://www.nseindia.com/api/fo-banlist-securities';
    const r = await fetch(url, { headers: { ...NSE_BASE_HEADERS, Cookie: await getNSECookies() } });
    if (!r.ok) throw new Error(`NSE ban list ${r.status}`);
    const data = await r.json();
    // NSE returns array of strings or {symbol} objects
    const securities = Array.isArray(data)
      ? data.map(d => typeof d === 'string' ? d : d.symbol || d.tradingSymbol || JSON.stringify(d))
      : (data.data || data.securities || []).map(d => typeof d === 'string' ? d : d.symbol || d.tradingSymbol || '');
    res.json({ securities: securities.filter(Boolean), date: new Date().toISOString() });
  } catch(e) {
    // Return empty list gracefully — don't break the UI
    res.json({ securities: [], error: e.message, date: new Date().toISOString() });
  }
});

// ── RAZORPAY SUBSCRIPTION ─────────────────────────────────────────────────────
const crypto = require('crypto');

const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RZP_PLAN_ID    = process.env.RAZORPAY_PLAN_ID; // set after creating plan once

function rzpAuth() {
  return 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64');
}

// POST /api/rzp/create-plan — run ONCE to create the ₹299/quarter plan
// Call this from browser after setting keys: POST /api/rzp/create-plan
app.post('/api/rzp/create-plan', async (req, res) => {
  if (!RZP_KEY_ID) return res.status(503).json({ error: 'Razorpay keys not set' });
  try {
    const r = await fetch('https://api.razorpay.com/v1/plans', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': rzpAuth() },
      body   : JSON.stringify({
        period  : 'monthly',
        interval: 3,           // every 3 months = quarterly
        item    : {
          name    : 'DeltaBuddy Pro',
          amount  : 29900,     // ₹299 in paise
          currency: 'INR',
          description: 'DeltaBuddy Pro — Quarterly subscription',
        },
        notes: { plan_type: 'quarterly_299' },
      }),
    });
    const data = await r.json();
    res.json({ plan_id: data.id, data });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rzp/create-subscription — called when user clicks Subscribe
// Body: { userId, email, name }
app.post('/api/rzp/create-subscription', async (req, res) => {
  if (!RZP_KEY_ID || !RZP_PLAN_ID) return res.status(503).json({ error: 'Razorpay not configured' });
  const { userId, email, name } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    // Create/fetch Razorpay customer
    const custR = await fetch('https://api.razorpay.com/v1/customers', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': rzpAuth() },
      body   : JSON.stringify({ name: name || email, email, notes: { firebase_uid: userId } }),
    });
    const cust = await custR.json();

    // Create subscription with 3-month trial
    const subR = await fetch('https://api.razorpay.com/v1/subscriptions', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': rzpAuth() },
      body   : JSON.stringify({
        plan_id           : RZP_PLAN_ID,
        customer_id       : cust.id,
        quantity          : 1,
        total_count       : 48,        // 4 years max
        start_at          : Math.floor(Date.now() / 1000) + (90 * 24 * 3600), // starts after 3 months
        customer_notify   : 1,
        notes             : { firebase_uid: userId, email },
      }),
    });
    const sub = await subR.json();
    if (sub.error) return res.status(400).json({ error: sub.error.description });
    res.json({ subscription_id: sub.id, short_url: sub.short_url, status: sub.status });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rzp/verify-payment — called after Razorpay checkout success
// Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, userId }
app.post('/api/rzp/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, userId } = req.body;
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment fields' });
  }
  try {
    // Verify signature
    const body = razorpay_payment_id + '|' + razorpay_subscription_id;
    const expected = crypto.createHmac('sha256', RZP_KEY_SECRET).update(body).digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid signature — payment tampered' });
    }
    res.json({ ok: true, verified: true, subscription_id: razorpay_subscription_id });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rzp/webhook — Razorpay sends events here (subscription activated, payment failed etc)
// Set this URL in Razorpay Dashboard → Webhooks
app.post('/api/rzp/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig      = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (sig !== expected) return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  const event = JSON.parse(req.body);
  console.log('[RZP Webhook]', event.event, JSON.stringify(event).substring(0, 200));
  // Frontend handles status via Firebase — webhook just logs for now
  res.json({ ok: true });
});

// GET /api/rzp/subscription/:subId — check subscription status
app.get('/api/rzp/subscription/:subId', async (req, res) => {
  if (!RZP_KEY_ID) return res.status(503).json({ error: 'Razorpay not configured' });
  try {
    const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${req.params.subId}`, {
      headers: { 'Authorization': rzpAuth() },
    });
    const data = await r.json();
    res.json({ status: data.status, current_end: data.current_end, paid_count: data.paid_count });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/expiry-tools?symbol=NIFTY — max pain, PCR, key strikes, expected move
app.get('/api/expiry-tools', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  try {
    const cookies = await getNSECookies();
    const isIndex = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'].includes(symbol);
    const apiUrl  = isIndex
      ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
      : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;
    const r = await fetch(apiUrl, { headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 15000 });
    const json = await r.json();
    const records   = json?.records?.data       || [];
    const expDates  = json?.records?.expiryDates|| [];
    const spotPrice = json?.records?.underlyingValue || 0;
    const nearExpiry = expDates[0] || '';
    const nearRecords = records.filter(d => d.expiryDate === nearExpiry);

    // Max Pain
    const strikes = [...new Set(nearRecords.map(d => d.strikePrice))].sort((a,b)=>a-b);
    let maxPainStrike = 0, minLoss = Infinity;
    for (const ts of strikes) {
      let loss = 0;
      for (const d of nearRecords) {
        if (ts < d.strikePrice) loss += (d.strikePrice - ts) * (d.CE?.openInterest || 0);
        if (ts > d.strikePrice) loss += (ts - d.strikePrice) * (d.PE?.openInterest || 0);
      }
      if (loss < minLoss) { minLoss = loss; maxPainStrike = ts; }
    }

    // PCR
    let totalCE_OI=0, totalPE_OI=0, totalCE_Vol=0, totalPE_Vol=0;
    for (const d of nearRecords) {
      totalCE_OI  += d.CE?.openInterest      || 0;
      totalPE_OI  += d.PE?.openInterest      || 0;
      totalCE_Vol += d.CE?.totalTradedVolume || 0;
      totalPE_Vol += d.PE?.totalTradedVolume || 0;
    }
    const pcrOI  = totalCE_OI  ? +(totalPE_OI  / totalCE_OI ).toFixed(3) : 0;
    const pcrVol = totalCE_Vol ? +(totalPE_Vol / totalCE_Vol).toFixed(3) : 0;

    // Top OI strikes
    const topCE = [...nearRecords].sort((a,b)=>(b.CE?.openInterest||0)-(a.CE?.openInterest||0))
      .slice(0,3).map(d=>({ strike:d.strikePrice, oi:d.CE?.openInterest||0, ltp:d.CE?.lastPrice||0, iv:d.CE?.impliedVolatility||0 }));
    const topPE = [...nearRecords].sort((a,b)=>(b.PE?.openInterest||0)-(a.PE?.openInterest||0))
      .slice(0,3).map(d=>({ strike:d.strikePrice, oi:d.PE?.openInterest||0, ltp:d.PE?.lastPrice||0, iv:d.PE?.impliedVolatility||0 }));

    // ATM & straddle
    const atmStrike = strikes.reduce((p,c) => Math.abs(c-spotPrice)<Math.abs(p-spotPrice)?c:p, strikes[0]||0);
    const atmRow = nearRecords.find(d => d.strikePrice === atmStrike) || {};
    const straddlePremium = (atmRow.CE?.lastPrice||0) + (atmRow.PE?.lastPrice||0);
    const atmIV = ((atmRow.CE?.impliedVolatility||0) + (atmRow.PE?.impliedVolatility||0)) / 2;

    // OI chart data (for visualization)
    const oiChartData = nearRecords
      .filter(d => Math.abs(d.strikePrice - spotPrice) < spotPrice * 0.05) // ±5% of spot
      .sort((a,b) => a.strikePrice - b.strikePrice)
      .map(d => ({
        strike: d.strikePrice,
        ceOI: d.CE?.openInterest || 0,
        peOI: d.PE?.openInterest || 0,
        ceLTP: d.CE?.lastPrice || 0,
        peLTP: d.PE?.lastPrice || 0,
        ceIV: d.CE?.impliedVolatility || 0,
        peIV: d.PE?.impliedVolatility || 0,
      }));

    res.json({
      symbol, spotPrice, nearExpiry,
      maxPain: { strike: maxPainStrike, pct: +((maxPainStrike-spotPrice)/spotPrice*100).toFixed(2) },
      pcr: { oi: pcrOI, volume: pcrVol, bias: pcrOI>1.2?'Bullish':pcrOI<0.8?'Bearish':'Neutral' },
      resistance: topCE, support: topPE,
      atmStrike, atmIV: +atmIV.toFixed(2),
      straddlePremium: +straddlePremium.toFixed(2),
      expectedMove: { up: +(spotPrice+straddlePremium).toFixed(0), down: +(spotPrice-straddlePremium).toFixed(0) },
      oiChartData,
      fetchedAt: new Date().toISOString(),
    });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({
    status        : 'ok',
    service       : 'DeltaBuddy Backend',
    dhanConfigured: !!(DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN),
    uptime        : Math.floor(process.uptime()) + 's',
    timestamp     : new Date().toISOString(),
  });
});

// ── EXPIRY TOOLS — Max Pain, PCR, OI Chart ────────────────────────────────────
app.get('/api/expiry-tools', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  try {
    // Fetch NSE option chain
    const nseUrl = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
    const r = await fetch(nseUrl, {
      headers: {
        'User-Agent'  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'      : 'application/json',
        'Referer'     : 'https://www.nseindia.com/option-chain',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) throw new Error(`NSE returned ${r.status}`);
    const json = await r.json();
    const records = json?.records?.data || [];
    const expiry  = json?.records?.expiryDates?.[0] || '';
    const spot    = json?.records?.underlyingValue || 0;

    // Aggregate CE and PE OI per strike
    const strikeMap = {};
    for (const rec of records) {
      const k = rec.strikePrice;
      if (!strikeMap[k]) strikeMap[k] = { strike:k, ceOI:0, peOI:0, ceLTP:0, peLTP:0, ceIV:0, peIV:0, ceVol:0, peVol:0 };
      if (rec.CE) { strikeMap[k].ceOI += rec.CE.openInterest||0; strikeMap[k].ceLTP = rec.CE.lastPrice||0; strikeMap[k].ceIV = rec.CE.impliedVolatility||0; strikeMap[k].ceVol += rec.CE.totalTradedVolume||0; }
      if (rec.PE) { strikeMap[k].peOI += rec.PE.openInterest||0; strikeMap[k].peLTP = rec.PE.lastPrice||0; strikeMap[k].peIV = rec.PE.impliedVolatility||0; strikeMap[k].peVol += rec.PE.totalTradedVolume||0; }
    }
    const strikes = Object.values(strikeMap).sort((a,b) => a.strike - b.strike);

    // Max Pain — strike where total option writer loss is minimum
    let maxPainStrike = spot, minLoss = Infinity;
    for (const test of strikes) {
      const S = test.strike;
      let loss = 0;
      for (const s of strikes) {
        if (S > s.strike) loss += (S - s.strike) * s.ceOI;
        if (S < s.strike) loss += (s.strike - S) * s.peOI;
      }
      if (loss < minLoss) { minLoss = loss; maxPainStrike = S; }
    }

    // PCR
    const totalCeOI  = strikes.reduce((s,r) => s + r.ceOI,  0);
    const totalPeOI  = strikes.reduce((s,r) => s + r.peOI,  0);
    const totalCeVol = strikes.reduce((s,r) => s + r.ceVol, 0);
    const totalPeVol = strikes.reduce((s,r) => s + r.peVol, 0);
    const pcrOI  = totalCeOI  ? +(totalPeOI  / totalCeOI).toFixed(2)  : 0;
    const pcrVol = totalCeVol ? +(totalPeVol / totalCeVol).toFixed(2) : 0;
    const pcrBias = pcrOI > 1.2 ? 'Bullish' : pcrOI < 0.8 ? 'Bearish' : 'Neutral';

    // ATM strike and straddle
    const atmStrike = strikes.reduce((prev, s) => Math.abs(s.strike - spot) < Math.abs(prev.strike - spot) ? s : prev, strikes[0] || {strike:0});
    const straddlePremium = (atmStrike.ceLTP || 0) + (atmStrike.peLTP || 0);
    const atmIV = ((atmStrike.ceIV || 0) + (atmStrike.peIV || 0)) / 2;
    const expectedMove = +(spot * atmIV / 100 / Math.sqrt(365)).toFixed(0);

    // OI chart — ±5% from spot
    const oiChart = strikes.filter(s => Math.abs(s.strike - spot) / spot <= 0.05);

    // Key resistance (top CE OI) and support (top PE OI)
    const resistance = [...strikes].sort((a,b) => b.ceOI - a.ceOI).slice(0,3);
    const support    = [...strikes].sort((a,b) => b.peOI - a.peOI).slice(0,3);

    res.json({ symbol, expiry, spot, maxPain: maxPainStrike, pcrOI, pcrVol, pcrBias, straddlePremium, atmIV: +atmIV.toFixed(1), expectedMove, resistance, support, oiChart });
  } catch(e) {
    res.status(502).json({ error: e.message, symbol });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DeltaBuddy Backend on port ${PORT}`);
  console.log(`💼 Dhan Status:    http://localhost:${PORT}/api/dhan/status`);
  console.log(`💰 Dhan Portfolio: http://localhost:${PORT}/api/dhan/portfolio`);
  console.log(`❤️  Health:         http://localhost:${PORT}/api/health\n`);
  console.log(`[Dhan] Configured: ${!!(DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN)}`);
  getNSECookies();
  startAlertEngine();

  // ── Keep-alive ping so Render free tier never sleeps ──────────────────
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${SELF_URL}/api/health`)
      .then(() => console.log('[Keep-alive] ping ok'))
      .catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
});
