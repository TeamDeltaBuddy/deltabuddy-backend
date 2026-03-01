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
// ANGEL ONE WEBSOCKET MANAGER
// ══════════════════════════════════════════════════════════════════════════════

const ANGEL_API_KEY   = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const ANGEL_MPIN      = process.env.ANGEL_MPIN;
const ANGEL_TOTP_KEY  = process.env.ANGEL_TOTP_KEY; // TOTP secret

// In-memory tick store — keyed by token
const tickStore = {};          // { "26000": { ltp, open, high, low, close, volume, bidQty, askQty, bidPrice, askPrice, depth } }
let angelToken    = null;      // JWT auth token
let angelFeedToken = null;     // WebSocket feed token
let angelWs       = null;      // Active WebSocket connection
let angelConnected = false;
let angelLoginTime = 0;
let subscribedTokens = new Set();

// Token → symbol name mapping (expandable)
const TOKEN_SYMBOL_MAP = {
  '26000': 'NIFTY 50',
  '26009': 'BANK NIFTY',
  '26037': 'NIFTY IT',
  '26003': 'NIFTY NEXT 50',
  '26013': 'NIFTY MIDCAP 50',
};

// Exchange type constants
const EXCHANGE_NSE = 1;  // NSE CM
const EXCHANGE_NFO = 2;  // NSE F&O (options/futures)

// Mode constants
const MODE_LTP       = 1;  // LTP only
const MODE_QUOTE     = 2;  // LTP + bid/ask + volume
const MODE_SNAPQUOTE = 3;  // Full market depth (5 levels)

// ── Angel One Login ───────────────────────────────────────────────────────────
let angelLoginError = '';

async function angelLogin() {
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_MPIN || !ANGEL_TOTP_KEY) {
    angelLoginError = 'Missing env vars';
    console.log('[Angel] Missing credentials — need ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_MPIN, ANGEL_TOTP_KEY');
    return false;
  }

  try {
    // Add base32 padding if missing (Angel One secret may not have = padding)
    let totpSecret = ANGEL_TOTP_KEY.replace(/\s/g, '').toUpperCase();
    while (totpSecret.length % 8 !== 0) totpSecret += '=';
    
    // Allow ±1 window (30s tolerance for server clock drift)
    totp.options = { digits: 6, step: 30, window: 1, algorithm: 'sha1' };
    const totpCode = totp.generate(totpSecret);
    console.log(`[Angel] Logging in as ${ANGEL_CLIENT_ID}, TOTP=${totpCode}, secret_len=${totpSecret.length}...`);

    const res = await fetch('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', {
      method : 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'Accept'          : 'application/json',
        'X-UserType'      : 'USER',
        'X-SourceID'      : 'WEB',
        'X-ClientLocalIP' : '127.0.0.1',
        'X-ClientPublicIP': '106.51.0.1',
        'X-MACAddress'    : 'AA:BB:CC:DD:EE:FF',
        'X-PrivateKey'    : ANGEL_API_KEY,
      },
      body: JSON.stringify({
        clientcode: ANGEL_CLIENT_ID,
        password  : ANGEL_MPIN,
        totp      : totpCode,
      }), // totp is 6-digit code
      timeout: 15000,
    });

    const raw = await res.text();
    console.log(`[Angel] Login response (${res.status}):`, raw.substring(0, 300));

    const data = JSON.parse(raw);
    if (data.status && data.data?.jwtToken) {
      angelToken      = data.data.jwtToken;
      angelFeedToken  = data.data.feedToken;
      angelLoginTime  = Date.now();
      angelLoginError = '';
      console.log('[Angel] ✅ Login successful! feedToken:', angelFeedToken?.substring(0,20) + '...');
      return true;
    } else {
      angelLoginError = data.message || data.errorcode || JSON.stringify(data);
      console.error('[Angel] ❌ Login failed:', angelLoginError);
      return false;
    }
  } catch(e) {
    angelLoginError = e.message;
    console.error('[Angel] ❌ Login exception:', e.message);
    return false;
  }
}

// ── Angel One WebSocket Connect ───────────────────────────────────────────────
function connectAngelWS() {
  if (!angelToken || !angelFeedToken) {
    console.log('[Angel WS] No token — cannot connect');
    return;
  }
  if (angelWs && angelWs.readyState === WebSocket.OPEN) {
    console.log('[Angel WS] Already connected');
    return;
  }

  console.log('[Angel WS] Connecting...');
  angelWs = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', {
    headers: {
      'Authorization': `Bearer ${angelToken}`,
      'x-api-key'    : ANGEL_API_KEY,
      'x-client-code': ANGEL_CLIENT_ID,
      'x-feed-token' : angelFeedToken,
    }
  });

  angelWs.on('open', () => {
    angelConnected = true;
    console.log('[Angel WS] Connected ✅');
    // Re-subscribe all tokens
    if (subscribedTokens.size > 0) {
      subscribeTokens([...subscribedTokens], MODE_SNAPQUOTE);
    } else {
      // Default: subscribe NIFTY + BANKNIFTY in SnapQuote mode
      subscribeTokens(['26000','26009','26037'], MODE_SNAPQUOTE, EXCHANGE_NSE);
    }
  });

  angelWs.on('message', (rawData) => {
    try {
      // Angel One sends binary data
      if (Buffer.isBuffer(rawData)) {
        parseBinaryTick(rawData);
      } else {
        const msg = JSON.parse(rawData.toString());
        console.log('[Angel WS] Message:', msg);
      }
    } catch(e) {
      // ignore parse errors
    }
  });

  angelWs.on('close', (code, reason) => {
    angelConnected = false;
    console.log(`[Angel WS] Disconnected (${code}) — reconnecting in 5s...`);
    setTimeout(() => reconnectAngel(), 5000);
  });

  angelWs.on('error', (err) => {
    angelConnected = false;
    console.error('[Angel WS] Error:', err.message);
  });
}

// ── Parse Binary Tick Data ────────────────────────────────────────────────────
function parseBinaryTick(buf) {
  try {
    // Angel One binary packet format:
    // Byte 0: subscription type (1=LTP, 2=Quote, 3=SnapQuote)
    // Byte 1: exchange type
    // Bytes 2-27: token (padded string)
    // Bytes 28-35: sequence number
    // Bytes 36-43: exchange timestamp
    // Bytes 44-51: last traded price (divide by 100)
    // Bytes 52-59: last traded quantity
    // Bytes 60-67: average traded price
    // Bytes 68-75: volume traded today
    // Bytes 76-83: total buy qty
    // Bytes 84-91: total sell qty
    // Bytes 92-99: open
    // Bytes 100-107: high
    // Bytes 108-115: low
    // Bytes 116-123: close
    // (SnapQuote has additional depth data)

    const mode = buf.readUInt8(0);
    const exchangeType = buf.readUInt8(1);
    const token = buf.slice(2, 27).toString('ascii').replace(/\0/g, '').trim();

    if (!token) return;

    const ltp   = buf.readBigInt64BE(44) ? Number(buf.readBigInt64BE(44)) / 100 : 0;
    const open  = buf.length > 92  ? Number(buf.readBigInt64BE(92))  / 100 : 0;
    const high  = buf.length > 100 ? Number(buf.readBigInt64BE(100)) / 100 : 0;
    const low   = buf.length > 108 ? Number(buf.readBigInt64BE(108)) / 100 : 0;
    const close = buf.length > 116 ? Number(buf.readBigInt64BE(116)) / 100 : 0;
    const vol   = buf.length > 68  ? Number(buf.readBigInt64BE(68))  : 0;

    const tick = {
      token,
      symbol  : TOKEN_SYMBOL_MAP[token] || token,
      exchange: exchangeType,
      ltp     : ltp > 0 ? ltp : (tickStore[token]?.ltp || 0),
      open, high, low, close,
      volume  : vol,
      change  : close > 0 ? ((ltp - close) / close * 100).toFixed(2) : 0,
      timestamp: Date.now(),
    };

    // Parse SnapQuote depth (bytes 124+)
    if (mode === 3 && buf.length > 124) {
      tick.depth = parseDepth(buf, 124);
      tick.bidPrice = tick.depth?.buy?.[0]?.price || 0;
      tick.askPrice = tick.depth?.sell?.[0]?.price || 0;
      tick.bidQty   = tick.depth?.buy?.[0]?.qty   || 0;
      tick.askQty   = tick.depth?.sell?.[0]?.qty   || 0;
    }

    // Parse Quote mode bid/ask (bytes 76-91)
    if (mode >= 2 && buf.length > 91) {
      tick.totalBuyQty  = Number(buf.readBigInt64BE(76));
      tick.totalSellQty = Number(buf.readBigInt64BE(84));
    }

    tickStore[token] = tick;
  } catch(e) {
    // Silently ignore parse errors for malformed packets
  }
}

function parseDepth(buf, offset) {
  const depth = { buy: [], sell: [] };
  try {
    // 5 levels × (qty 8 bytes + price 8 bytes + orders 2 bytes) = 18 bytes each
    // Buy first, then sell
    for (let i = 0; i < 5; i++) {
      const base = offset + i * 18;
      if (base + 18 > buf.length) break;
      depth.buy.push({
        qty   : Number(buf.readBigInt64BE(base)),
        price : Number(buf.readBigInt64BE(base + 8)) / 100,
        orders: buf.readUInt16BE(base + 16),
      });
    }
    const sellOffset = offset + 5 * 18;
    for (let i = 0; i < 5; i++) {
      const base = sellOffset + i * 18;
      if (base + 18 > buf.length) break;
      depth.sell.push({
        qty   : Number(buf.readBigInt64BE(base)),
        price : Number(buf.readBigInt64BE(base + 8)) / 100,
        orders: buf.readUInt16BE(base + 16),
      });
    }
  } catch(e) {}
  return depth;
}

// ── Subscribe to Tokens ───────────────────────────────────────────────────────
function subscribeTokens(tokens, mode = MODE_SNAPQUOTE, exchange = EXCHANGE_NSE) {
  if (!angelWs || angelWs.readyState !== WebSocket.OPEN) return;

  tokens.forEach(t => subscribedTokens.add(t));

  const payload = {
    correlationID: 'db_' + Date.now(),
    action: 1, // 1=subscribe, 0=unsubscribe
    params: {
      mode,
      tokenList: [{
        exchangeType: exchange,
        tokens: tokens.map(String),
      }]
    }
  };

  angelWs.send(JSON.stringify(payload));
  console.log(`[Angel WS] Subscribed mode=${mode} tokens=${tokens.join(',')} exchange=${exchange}`);
}

function unsubscribeTokens(tokens, exchange = EXCHANGE_NSE) {
  if (!angelWs || angelWs.readyState !== WebSocket.OPEN) return;
  tokens.forEach(t => subscribedTokens.delete(t));
  const payload = {
    correlationID: 'db_unsub_' + Date.now(),
    action: 0,
    params: { mode: MODE_SNAPQUOTE, tokenList: [{ exchangeType: exchange, tokens: tokens.map(String) }] }
  };
  angelWs.send(JSON.stringify(payload));
}

// ── Reconnect Logic ───────────────────────────────────────────────────────────
async function reconnectAngel() {
  // Re-login every 8 hours (token expires)
  const tokenAge = Date.now() - angelLoginTime;
  if (tokenAge > 8 * 60 * 60 * 1000) {
    console.log('[Angel] Token expired — re-logging in...');
    await angelLogin();
  }
  connectAngelWS();
}

// ── Initial Connection on Startup ─────────────────────────────────────────────
(async () => {
  if (ANGEL_API_KEY) {
    const ok = await angelLogin();
    if (ok) connectAngelWS();
  }
})();

// Re-login every 8 hours to keep token fresh
setInterval(async () => {
  if (ANGEL_API_KEY) {
    console.log('[Angel] Scheduled re-login...');
    await angelLogin();
    if (angelWs) angelWs.close(); // triggers reconnect
  }
}, 8 * 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
// ANGEL ONE REST ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/angel/status — connection status
app.get('/api/angel/status', (req, res) => {
  res.json({
    connected       : angelConnected,
    tokenCount      : Object.keys(tickStore).length,
    subscribedTokens: [...subscribedTokens],
    loginTime       : angelLoginTime,
    loginError      : angelLoginError || null,
    hasCredentials  : !!ANGEL_API_KEY,
    apiKey          : ANGEL_API_KEY ? ANGEL_API_KEY.substring(0,4)+'...' : null,
    clientId        : ANGEL_CLIENT_ID || null,
  });
});

// GET /api/angel/relogin — force re-login for debugging
app.get('/api/angel/relogin', async (req, res) => {
  const ok = await angelLogin();
  if (ok) connectAngelWS();
  res.json({ ok, error: angelLoginError || null, connected: angelConnected });
});

// GET /api/angel/ticks — all latest ticks
app.get('/api/angel/ticks', (req, res) => {
  res.json(tickStore);
});

// GET /api/angel/tick/:token — single token tick
app.get('/api/angel/tick/:token', (req, res) => {
  const tick = tickStore[req.params.token];
  if (!tick) return res.status(404).json({ error: 'Token not found or not subscribed' });
  res.json(tick);
});

// POST /api/angel/subscribe — subscribe new tokens
// Body: { tokens: ["35001","35002"], mode: 3, exchange: 2 }
app.post('/api/angel/subscribe', (req, res) => {
  const { tokens = [], mode = MODE_SNAPQUOTE, exchange = EXCHANGE_NFO } = req.body;
  if (!tokens.length) return res.status(400).json({ error: 'tokens array required' });

  if (!angelConnected) {
    return res.status(503).json({ error: 'Angel One WebSocket not connected', connected: false });
  }

  subscribeTokens(tokens, mode, exchange);
  res.json({ ok: true, subscribed: tokens, mode, exchange });
});

// POST /api/angel/unsubscribe
app.post('/api/angel/unsubscribe', (req, res) => {
  const { tokens = [], exchange = EXCHANGE_NFO } = req.body;
  unsubscribeTokens(tokens, exchange);
  res.json({ ok: true, unsubscribed: tokens });
});

// GET /api/angel/option-ltp — get LTP for a list of option tokens
// Query: tokens=35001,35002,35003
app.get('/api/angel/option-ltp', (req, res) => {
  const tokens = (req.query.tokens || '').split(',').filter(Boolean);
  const result = {};
  tokens.forEach(t => { result[t] = tickStore[t] || null; });
  res.json(result);
});

// POST /api/angel/search-token — find token for a symbol/strike/expiry
// Uses Angel One searchScrip REST API
app.post('/api/angel/search-token', async (req, res) => {
  if (!angelToken) return res.status(503).json({ error: 'Not logged in to Angel One' });
  const { exchange = 'NFO', searchscrip } = req.body;

  try {
    const r = await fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/searchScrip', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${angelToken}`,
        'Accept'       : 'application/json',
        'X-UserType'   : 'USER',
        'X-SourceID'   : 'WEB',
        'X-PrivateKey' : ANGEL_API_KEY,
      },
      body: JSON.stringify({ exchange, searchscrip }),
      timeout: 10000,
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(502).json({ error: 'Search scrip failed', detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

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
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
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

async function askAI(prompt, groqModel = 'llama3-8b-8192') {
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
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
  'https://feeds.feedburner.com/ndtvnews-top-stories',
  'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.moneycontrol.com/rss/MCtopnews.xml',
  'https://feeds.reuters.com/reuters/INtopNews',
  'https://feeds.reuters.com/reuters/businessNews',
];

// First-pass filter — broad net to catch anything potentially relevant
// This is NOT the final gate, just cuts obviously irrelevant noise before hitting AI
const BROAD_RELEVANCE_KEYWORDS = [
  // Indian market names
  'nifty','sensex','nse','bse','rbi','sebi','india','indian',
  // Heavy weights & sectors
  'reliance','adani','tata','hdfc','infosys','wipro','ongc','sbi','icici','kotak',
  'oil','crude','gas','bank','pharma','it sector','auto','fmcg','metal','infra',
  // Macro
  'rate','inflation','gdp','rupee','dollar','fed','powell','imf','world bank',
  // Geopolitical
  'war','attack','sanction','iran','russia','china','pakistan','opec','nato',
  'oil supply','pipeline','export ban','import ban','trade',
  // Market events
  'crash','circuit','halt','fraud','scam','default','bankruptcy','shutdown',
  'earnings','result','profit','loss','revenue','guidance','outlook',
];

// Hard skip — truly zero market relevance
const DEFINITE_NOISE = [
  'cricket','ipl','football','sports','film','bollywood','celebrity','wedding',
  'recipe','travel','fashion','lifestyle','horoscope','weather forecast',
  'covid vaccine','health tips','fitness','diet',
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
  const prompt = `You are an Indian stock market alert filter for NSE/BSE traders.

Rate this news for immediate market impact (1-10):
HEADLINE: ${title}
DETAILS: ${description.substring(0, 200)}

Scoring guide:
9-10: War/attack, central bank emergency, market circuit breaker, major fraud
7-8: Rate decision surprise, oil shock >5%, heavy-weight stock major news (Reliance Russian oil ban = 9), sanctions
5-6: Routine earnings beats/misses, regular economic data, political statements  
1-4: Sports, lifestyle, minor corporate news

Reply ONLY in JSON (no other text):
{"score":8,"impact":"bearish","reason":"one sentence","sectors":"Oil,Aviation","action":"Sell Nifty futures"}

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

  // Test Groq directly
  if (GROQ_KEY) {
    try {
      const r = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body   : JSON.stringify({ model: 'llama3-8b-8192', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 }),
        },
        10000
      );
      const body = await r.text();
      results.groq = { status: r.status, ok: r.ok, body: body.substring(0, 300) };
    } catch(e) {
      results.groq = { error: e.message };
    }
  } else {
    results.groq = { error: 'GROQ_API_KEY not set' };
  }

  // Test Gemini directly
  if (GEMINI_KEY) {
    try {
      const r = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body   : JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] }),
        },
        12000
      );
      const body = await r.text();
      results.gemini = { status: r.status, ok: r.ok, body: body.substring(0, 300) };
    } catch(e) {
      results.gemini = { error: e.message };
    }
  } else {
    results.gemini = { error: 'GEMINI_API_KEY not set' };
  }

  res.json(results);
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

    if (ai.score < 6) continue; // below threshold — skip silently

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
        source     : new URL(item.link || 'https://example.com').hostname.replace('www.',''),
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

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status        : 'ok',
    service       : 'DeltaBuddy Backend',
    angelConnected: angelConnected,
    tickCount     : Object.keys(tickStore).length,
    uptime        : Math.floor(process.uptime()) + 's',
    timestamp     : new Date().toISOString(),
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DeltaBuddy Backend on port ${PORT}`);
  console.log(`📊 Angel WS Status: http://localhost:${PORT}/api/angel/status`);
  console.log(`📈 Live Ticks:      http://localhost:${PORT}/api/angel/ticks`);
  console.log(`❤️  Health:         http://localhost:${PORT}/api/health\n`);
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
