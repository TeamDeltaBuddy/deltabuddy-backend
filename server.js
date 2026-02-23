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
async function angelLogin() {
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_MPIN || !ANGEL_TOTP_KEY) {
    console.log('[Angel] Missing credentials — skipping login');
    return false;
  }

  try {
    totp.options = { digits: 6, step: 30 };
    const totpCode = totp.generate(ANGEL_TOTP_KEY);
    console.log(`[Angel] Logging in as ${ANGEL_CLIENT_ID}...`);

    const res = await fetch('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', {
      method : 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'Accept'          : 'application/json',
        'X-UserType'      : 'USER',
        'X-SourceID'      : 'WEB',
        'X-ClientLocalIP' : '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress'    : '00:00:00:00:00:00',
        'X-PrivateKey'    : ANGEL_API_KEY,
      },
      body: JSON.stringify({
        clientcode: ANGEL_CLIENT_ID,
        password  : ANGEL_MPIN,
        totp      : totpCode,
      }),
      timeout: 15000,
    });

    const data = await res.json();
    if (data.status && data.data?.jwtToken) {
      angelToken     = data.data.jwtToken;
      angelFeedToken = data.data.feedToken;
      angelLoginTime = Date.now();
      console.log('[Angel] Login successful ✅');
      return true;
    } else {
      console.error('[Angel] Login failed:', data.message || JSON.stringify(data));
      return false;
    }
  } catch(e) {
    console.error('[Angel] Login error:', e.message);
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
    connected    : angelConnected,
    tokenCount   : Object.keys(tickStore).length,
    subscribedTokens: [...subscribedTokens],
    loginTime    : angelLoginTime,
    hasCredentials: !!ANGEL_API_KEY,
  });
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
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  const { interval = '5m', range = '1d' } = req.query;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.params.symbol)}?interval=${interval}&range=${range}`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    res.json(await r.json());
  } catch(e) { res.status(502).json({ error: 'Yahoo failed', detail: e.message }); }
});

app.get('/api/yahoo/quote/:symbol', async (req, res) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.params.symbol)}?interval=1d&range=1d`;
  try {
    const r = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    res.json({
      price : result?.meta?.regularMarketPrice || null,
      change: result?.meta?.regularMarketChangePercent || null,
      symbol: req.params.symbol,
    });
  } catch(e) { res.status(502).json({ error: 'Yahoo quote failed', detail: e.message }); }
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

// ── NewsAPI Proxy ──────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { q, apiKey, pageSize = 10 } = req.query;
  if (!apiKey) return res.status(401).json({ error: 'NewsAPI key required' });
  try {
    const r = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${apiKey}`, { timeout: 10000 });
    res.json(await r.json());
  } catch(e) { res.status(502).json({ error: 'NewsAPI failed', detail: e.message }); }
});

// ── Telegram Proxy ─────────────────────────────────────────────────────────────
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
});
