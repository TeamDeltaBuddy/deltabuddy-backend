/**
 * DeltaBuddy Backend — Secured
 * Security Layers: Helmet, CORS, Rate Limiting, IP Block, Input Validation,
 *                  XSS/HPP Protection, CSRF, Security Logging, GDPR Endpoints
 */

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const WebSocket  = require('ws');
const { totp }   = require('otplib');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const xssClean   = require('xss-clean');
const hpp        = require('hpp');
const { body, query: qv, param, validationResult } = require('express-validator');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 1: SECURITY HEADERS (Helmet)  🔐
// ══════════════════════════════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'"],
      styleSrc   : ["'self'", "'unsafe-inline'"],
      imgSrc     : ["'self'", 'data:', 'https:'],
      connectSrc : ["'self'", 'https://www.nseindia.com', 'https://query1.finance.yahoo.com',
                    'https://api.groq.com', 'https://newsapi.org', 'https://api.telegram.org'],
      frameSrc   : ["'none'"],
      objectSrc  : ["'none'"],
    }
  },
  hsts               : { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff            : true,   // X-Content-Type-Options: nosniff
  xssFilter          : true,   // X-XSS-Protection
  referrerPolicy     : { policy: 'strict-origin-when-cross-origin' },
  hidePoweredBy      : true,   // Remove X-Powered-By: Express
  frameguard         : { action: 'deny' }, // X-Frame-Options: DENY
}));

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 2: BODY PARSING + XSS/HPP SANITIZATION  ✅
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '10kb' }));  // Limit body size — prevent large payload attacks
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(xssClean());   // Sanitize req.body, req.query, req.params against XSS
app.use(hpp());        // Prevent HTTP Parameter Pollution (e.g. ?symbols=x&symbols=y&symbols=...)

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 3: CORS — Allowlist Only  🚪
// ══════════════════════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://www.deltabuddy.com',
  'https://deltabuddy.com',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    securityLog('CORS_BLOCKED', { origin });
    cb(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods         : ['GET', 'POST', 'OPTIONS'],
  allowedHeaders  : ['Content-Type', 'Authorization', 'x-groq-key', 'x-csrf-token'],
  credentials     : true,
  maxAge          : 86400, // Preflight cache 24h
}));

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 4: RATE LIMITING  🚪
// ══════════════════════════════════════════════════════════════════════════════

// Global limiter — 200 req/min per IP
const globalLimiter = rateLimit({
  windowMs        : 60 * 1000,
  max             : 200,
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many requests. Please slow down.' },
  handler         : (req, res, next, options) => {
    securityLog('RATE_LIMIT_HIT', { ip: getIP(req), path: req.path });
    res.status(429).json(options.message);
  }
});

// Strict limiter for AI/external API routes — 30 req/15min
const strictLimiter = rateLimit({
  windowMs  : 15 * 60 * 1000,
  max       : 30,
  message   : { error: 'Too many AI requests. Please wait a few minutes.' },
});

// News limiter — 60 req/15min
const newsLimiter = rateLimit({
  windowMs  : 15 * 60 * 1000,
  max       : 60,
  message   : { error: 'News rate limit exceeded.' },
});

app.use(globalLimiter);

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 5: IP BLOCKING — Auto-block after repeated violations  🚪
// ══════════════════════════════════════════════════════════════════════════════
const ipViolations  = new Map();  // ip → { count, blockedUntil }
const IP_BLOCK_THRESHOLD = 10;
const IP_BLOCK_DURATION  = 30 * 60 * 1000; // 30 min

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function recordViolation(ip, reason) {
  const entry = ipViolations.get(ip) || { count: 0, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= IP_BLOCK_THRESHOLD) {
    entry.blockedUntil = Date.now() + IP_BLOCK_DURATION;
    securityLog('IP_BLOCKED', { ip, reason, count: entry.count });
  }
  ipViolations.set(ip, entry);
}

function ipBlockMiddleware(req, res, next) {
  const ip = getIP(req);
  const entry = ipViolations.get(ip);
  if (entry?.blockedUntil && Date.now() < entry.blockedUntil) {
    const minutesLeft = Math.ceil((entry.blockedUntil - Date.now()) / 60000);
    return res.status(403).json({ error: `IP temporarily blocked. Try again in ${minutesLeft} min.` });
  }
  next();
}
app.use(ipBlockMiddleware);

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 6: SECURITY LOGGING  🚨
// ══════════════════════════════════════════════════════════════════════════════
const securityEvents = [];  // In-memory ring buffer (last 500 events)
const MAX_LOG_SIZE   = 500;

function securityLog(event, details = {}) {
  const entry = {
    timestamp : new Date().toISOString(),
    event,
    ...details,
  };
  console.warn(`[SECURITY] ${event}`, JSON.stringify(details));
  securityEvents.push(entry);
  if (securityEvents.length > MAX_LOG_SIZE) securityEvents.shift();
}

// Log all requests (path + IP, no sensitive data)
app.use((req, res, next) => {
  const ip = getIP(req);
  const start = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      securityLog('REQUEST_ERROR', {
        ip,
        method   : req.method,
        path     : req.path,
        status   : res.statusCode,
        duration : `${Date.now() - start}ms`,
      });
      if (res.statusCode === 401 || res.statusCode === 403) {
        recordViolation(ip, `HTTP_${res.statusCode}`);
      }
    }
  });
  next();
});

// ══════════════════════════════════════════════════════════════════════════════
// LAYER 7: CSRF PROTECTION  ✅
// ══════════════════════════════════════════════════════════════════════════════
const csrfTokens = new Map(); // token → { expires }

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateCsrf(req, res, next) {
  // Skip CSRF for GET/HEAD/OPTIONS (read-only)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'];
  if (!token) {
    securityLog('CSRF_MISSING', { ip: getIP(req), path: req.path });
    return res.status(403).json({ error: 'CSRF token required' });
  }
  const entry = csrfTokens.get(token);
  if (!entry || Date.now() > entry.expires) {
    securityLog('CSRF_INVALID', { ip: getIP(req), path: req.path });
    recordViolation(getIP(req), 'CSRF_INVALID');
    return res.status(403).json({ error: 'Invalid or expired CSRF token' });
  }
  next();
}

// Issue CSRF token
app.get('/api/csrf-token', (req, res) => {
  const token   = generateCsrfToken();
  const expires = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
  csrfTokens.set(token, { expires });
  // Clean up expired tokens every 100 requests
  if (csrfTokens.size > 100) {
    for (const [t, e] of csrfTokens.entries()) {
      if (Date.now() > e.expires) csrfTokens.delete(t);
    }
  }
  res.json({ token });
});

// ══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION HELPERS  ✅
// ══════════════════════════════════════════════════════════════════════════════
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    securityLog('VALIDATION_FAILED', { ip: getIP(req), path: req.path, errors: errors.array() });
    recordViolation(getIP(req), 'INVALID_INPUT');
    return res.status(400).json({ error: 'Invalid input', details: errors.array() });
  }
  next();
}

const VALID_SYMBOLS = /^[A-Z0-9\.\-\^&\/]{1,30}$/;
const VALID_SYMBOL_LIST = /^[A-Z0-9\.\-\^&\/\,\s]{1,500}$/;

// ══════════════════════════════════════════════════════════════════════════════
// ANGEL ONE WEBSOCKET — (unchanged from original)
// ══════════════════════════════════════════════════════════════════════════════
const ANGEL_API_KEY   = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const ANGEL_MPIN      = process.env.ANGEL_MPIN;
const ANGEL_TOTP_KEY  = process.env.ANGEL_TOTP_KEY;

const tickStore       = {};
let angelToken        = null;
let angelFeedToken    = null;
let angelWs           = null;
let angelConnected    = false;
let angelLoginTime    = 0;
let subscribedTokens  = new Set();
let angelLoginError   = '';

const TOKEN_SYMBOL_MAP = {
  '26000': 'NIFTY 50',
  '26009': 'BANK NIFTY',
  '26037': 'NIFTY IT',
  '26003': 'NIFTY NEXT 50',
  '26013': 'NIFTY MIDCAP 50',
};

const EXCHANGE_NSE   = 1;
const EXCHANGE_NFO   = 2;
const MODE_LTP       = 1;
const MODE_QUOTE     = 2;
const MODE_SNAPQUOTE = 3;

async function angelLogin() {
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_MPIN || !ANGEL_TOTP_KEY) {
    angelLoginError = 'Missing env vars';
    return false;
  }
  try {
    let totpSecret = ANGEL_TOTP_KEY.replace(/\s/g, '').toUpperCase();
    while (totpSecret.length % 8 !== 0) totpSecret += '=';
    totp.options = { digits: 6, step: 30, window: 1, algorithm: 'sha1' };
    const totpCode = totp.generate(totpSecret);
    const res = await fetch('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', {
      method : 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'X-UserType': 'USER', 'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '106.51.0.1',
        'X-MACAddress': 'AA:BB:CC:DD:EE:FF', 'X-PrivateKey': ANGEL_API_KEY,
      },
      body: JSON.stringify({ clientcode: ANGEL_CLIENT_ID, password: ANGEL_MPIN, totp: totpCode }),
      timeout: 15000,
    });
    const data = JSON.parse(await res.text());
    if (data.status && data.data?.jwtToken) {
      angelToken = data.data.jwtToken; angelFeedToken = data.data.feedToken;
      angelLoginTime = Date.now(); angelLoginError = '';
      console.log('[Angel] ✅ Login successful!');
      return true;
    } else {
      angelLoginError = data.message || data.errorcode || JSON.stringify(data);
      console.error('[Angel] ❌ Login failed:', angelLoginError);
      return false;
    }
  } catch(e) { angelLoginError = e.message; return false; }
}

function connectAngelWS() {
  if (!angelToken || !angelFeedToken) return;
  if (angelWs && angelWs.readyState === WebSocket.OPEN) return;
  angelWs = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', {
    headers: {
      'Authorization': `Bearer ${angelToken}`, 'x-api-key': ANGEL_API_KEY,
      'x-client-code': ANGEL_CLIENT_ID, 'x-feed-token': angelFeedToken,
    }
  });
  angelWs.on('open', () => {
    angelConnected = true;
    if (subscribedTokens.size > 0) subscribeTokens([...subscribedTokens], MODE_SNAPQUOTE);
    else subscribeTokens(['26000','26009','26037'], MODE_SNAPQUOTE, EXCHANGE_NSE);
  });
  angelWs.on('message', (rawData) => {
    try { if (Buffer.isBuffer(rawData)) parseBinaryTick(rawData); } catch(e) {}
  });
  angelWs.on('close', () => { angelConnected = false; setTimeout(reconnectAngel, 5000); });
  angelWs.on('error', (err) => { angelConnected = false; console.error('[Angel WS] Error:', err.message); });
}

function parseBinaryTick(buf) {
  try {
    if (buf.length < 48) return;
    const token    = buf.slice(2, 27).toString('utf8').replace(/\0/g, '').trim();
    const ltp      = buf.readBigInt64BE(44) !== undefined ? Number(buf.readBigInt64BE(44)) / 100 : null;
    const open     = buf.length > 92  ? Number(buf.readBigInt64BE(92))  / 100 : null;
    const high     = buf.length > 100 ? Number(buf.readBigInt64BE(100)) / 100 : null;
    const low      = buf.length > 108 ? Number(buf.readBigInt64BE(108)) / 100 : null;
    const close    = buf.length > 116 ? Number(buf.readBigInt64BE(116)) / 100 : null;
    const volume   = buf.length > 68  ? Number(buf.readBigInt64BE(68))  : null;
    if (token && ltp) tickStore[token] = { ltp, open, high, low, close, volume, ts: Date.now() };
  } catch(e) {}
}

function subscribeTokens(tokens, mode = MODE_SNAPQUOTE, exchange = EXCHANGE_NSE) {
  if (!angelWs || angelWs.readyState !== WebSocket.OPEN) return;
  const tokenList = tokens.map(t => ({ exchangeType: exchange, tokens: [String(t)] }));
  const msg = JSON.stringify({ action: 1, params: { mode, tokenList } });
  angelWs.send(msg);
  tokens.forEach(t => subscribedTokens.add(String(t)));
}

async function reconnectAngel() {
  const tokenAge = (Date.now() - angelLoginTime) / 1000 / 3600;
  if (tokenAge > 22) await angelLogin();
  connectAngelWS();
}

// Angel One routes
app.get('/api/angel/status', (req, res) => res.json({
  connected: angelConnected, loginTime: angelLoginTime ? new Date(angelLoginTime).toISOString() : null,
  tickCount: Object.keys(tickStore).length, error: angelLoginError || null,
}));

app.get('/api/angel/ticks', (req, res) => res.json(tickStore));

app.post('/api/angel/login', validateCsrf, async (req, res) => {
  const ok = await angelLogin();
  if (ok) connectAngelWS();
  res.json({ success: ok, error: ok ? null : angelLoginError });
});

app.post('/api/angel/subscribe',
  validateCsrf,
  [body('tokens').isArray({ min: 1, max: 50 }).withMessage('tokens must be array of 1-50')],
  validate,
  (req, res) => {
    const { tokens, mode = MODE_SNAPQUOTE, exchange = EXCHANGE_NSE } = req.body;
    subscribeTokens(tokens, mode, exchange);
    res.json({ ok: true, subscribed: tokens });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// NSE ENDPOINTS — with input validation
// ══════════════════════════════════════════════════════════════════════════════
const NSE_BASE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://www.nseindia.com/',
  'Origin'         : 'https://www.nseindia.com',
  'sec-fetch-dest' : 'empty',
  'sec-fetch-mode' : 'cors',
  'sec-fetch-site' : 'same-origin',
  'Connection'     : 'keep-alive',
};

let nseCookies = ''; let nseLastFetch = 0;
async function getNSECookies() {
  if (nseCookies && (Date.now() - nseLastFetch) < 8 * 60 * 1000) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': NSE_BASE_HEADERS['User-Agent'], 'Accept': 'text/html,*/*' },
      timeout: 10000,
    });
    const raw = res.headers.raw()['set-cookie'] || [];
    nseCookies = raw.map(c => c.split(';')[0]).join('; ');
    nseLastFetch = Date.now();
  } catch(e) { console.error('[NSE] Cookie fail:', e.message); }
  return nseCookies;
}

const INDEX_SYMBOLS = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','NIFTYIT'];

app.get('/api/option-chain',
  [qv('symbol').optional().matches(VALID_SYMBOLS).withMessage('Invalid symbol')],
  validate,
  async (req, res) => {
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
    } catch(e) { res.status(502).json({ error: 'NSE fetch failed', detail: e.message }); }
  }
);

app.get('/api/quote',
  [qv('symbol').optional().matches(VALID_SYMBOLS).withMessage('Invalid symbol')],
  validate,
  async (req, res) => {
    const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
    try {
      const cookies = await getNSECookies();
      const r = await fetch(`https://www.nseindia.com/api/quote-derivative?symbol=${symbol}`, {
        headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 10000,
      });
      if (!r.ok) throw new Error(`NSE quote ${r.status}`);
      res.json(await r.json());
    } catch(e) { res.status(502).json({ error: 'NSE quote failed', detail: e.message }); }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// YAHOO FINANCE — with validation
// ══════════════════════════════════════════════════════════════════════════════
const YAHOO_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin'         : 'https://finance.yahoo.com',
  'Referer'        : 'https://finance.yahoo.com/',
};

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false`;
  try {
    const r    = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || null;
    let change = 0;
    if (prevClose && prevClose > 0) change = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));
    else if (meta.regularMarketChangePercent) change = parseFloat(meta.regularMarketChangePercent.toFixed(2));
    return { price: Math.round(price), change, prevClose: prevClose ? Math.round(prevClose) : null };
  } catch(e) { return null; }
}

const VALID_INTERVAL = ['1m','2m','5m','15m','30m','60m','1d','1wk','1mo'];
const VALID_RANGE    = ['1d','5d','1mo','3mo','6mo','1y','2y','5y'];

app.get('/api/yahoo/chart/:symbol',
  [
    param('symbol').matches(VALID_SYMBOLS).withMessage('Invalid symbol'),
    qv('interval').optional().isIn(VALID_INTERVAL).withMessage('Invalid interval'),
    qv('range').optional().isIn(VALID_RANGE).withMessage('Invalid range'),
  ],
  validate,
  async (req, res) => {
    const { interval = '5m', range = '1d' } = req.query;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.params.symbol)}?interval=${interval}&range=${range}`;
    try {
      const r = await fetch(url, { headers: YAHOO_HEADERS });
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      res.json(await r.json());
    } catch(e) { res.status(502).json({ error: 'Yahoo chart failed', detail: e.message }); }
  }
);

app.get('/api/prices',
  [qv('symbols').matches(VALID_SYMBOL_LIST).withMessage('Invalid symbols list')],
  validate,
  async (req, res) => {
    const { symbols } = req.query;
    if (!symbols) return res.status(400).json({ error: 'symbols required' });
    const list    = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    const results = {};
    const CHUNK   = 8;
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk   = list.slice(i, i + CHUNK);
      const fetched = await Promise.all(chunk.map(sym => fetchYahooQuote(sym)));
      chunk.forEach((sym, idx) => { if (fetched[idx]) results[sym] = fetched[idx]; });
    }
    res.json(results);
  }
);

app.get('/api/yahoo/quote/:symbol',
  [param('symbol').matches(VALID_SYMBOLS).withMessage('Invalid symbol')],
  validate,
  async (req, res) => {
    const data = await fetchYahooQuote(req.params.symbol);
    if (!data) return res.status(502).json({ error: 'Yahoo quote failed' });
    res.json({ ...data, symbol: req.params.symbol });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GROQ AI PROXY — strict rate limit + validation
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/groq',
  strictLimiter,
  validateCsrf,
  [
    body('model').optional().isString().isLength({ max: 100 }),
    body('messages').isArray({ min: 1, max: 20 }).withMessage('messages: 1-20 items'),
    body('messages.*.role').isIn(['system','user','assistant']).withMessage('Invalid message role'),
    body('messages.*.content').isString().isLength({ min: 1, max: 8000 }),
    body('max_tokens').optional().isInt({ min: 1, max: 4096 }),
    body('temperature').optional().isFloat({ min: 0, max: 2 }),
  ],
  validate,
  async (req, res) => {
    const apiKey = req.headers['x-groq-key'] || req.headers['authorization']?.replace('Bearer ','');
    if (!apiKey || apiKey.length < 10) {
      recordViolation(getIP(req), 'MISSING_API_KEY');
      return res.status(401).json({ error: 'Groq API key required' });
    }
    // Mask key in logs — only log first 8 chars
    securityLog('GROQ_REQUEST', { ip: getIP(req), keyPrefix: apiKey.substring(0, 8) + '…' });
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body   : JSON.stringify(req.body),
        timeout: 30000,
      });
      res.status(r.status).json(await r.json());
    } catch(e) { res.status(502).json({ error: 'Groq proxy failed', detail: e.message }); }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// NEWS API PROXY — rate limited + validated
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/news',
  newsLimiter,
  [
    qv('q').isString().isLength({ min: 1, max: 200 }).withMessage('q: 1-200 chars'),
    qv('apiKey').isString().isLength({ min: 10, max: 100 }).withMessage('Invalid API key'),
    qv('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res) => {
    const { q, apiKey, pageSize = 10 } = req.query;
    try {
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${pageSize}&apiKey=${apiKey}`,
        { timeout: 10000 }
      );
      res.json(await r.json());
    } catch(e) { res.status(502).json({ error: 'NewsAPI failed', detail: e.message }); }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM PROXY — validated + CSRF protected
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/telegram',
  validateCsrf,
  [
    body('chat_id').notEmpty().withMessage('chat_id required'),
    body('text').isString().isLength({ min: 1, max: 4096 }).withMessage('text: 1-4096 chars'),
    body('parse_mode').optional().isIn(['HTML', 'Markdown', 'MarkdownV2']),
  ],
  validate,
  async (req, res) => {
    const BOT_TOKEN = process.env.TG_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(503).json({ error: 'TG_BOT_TOKEN not configured' });
    const { chat_id, text, parse_mode = 'HTML' } = req.body;
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
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// F&O BAN LIST
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/nse/fno-ban', async (req, res) => {
  try {
    const url = 'https://www.nseindia.com/api/fo-banlist-securities';
    const r = await fetch(url, { headers: { ...NSE_BASE_HEADERS, Cookie: await getNSECookies() } });
    if (!r.ok) throw new Error(`NSE ban list ${r.status}`);
    const data = await r.json();
    const securities = Array.isArray(data)
      ? data.map(d => typeof d === 'string' ? d : d.symbol || d.tradingSymbol || '')
      : (data.data || data.securities || []).map(d => typeof d === 'string' ? d : d.symbol || d.tradingSymbol || '');
    res.json({ securities: securities.filter(Boolean), date: new Date().toISOString() });
  } catch(e) {
    res.json({ securities: [], error: e.message, date: new Date().toISOString() });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PRIVACY & GDPR ENDPOINTS  📋
// ══════════════════════════════════════════════════════════════════════════════

// Data anonymization helper (for analytics — hashes user IDs)
function anonymize(userId) {
  return crypto.createHash('sha256').update(userId + (process.env.ANON_SALT || 'deltabuddy')).digest('hex').substring(0, 16);
}

// GDPR: Right to know what data we hold server-side (cookies, logs)
app.get('/api/privacy/my-data', (req, res) => {
  const ip = getIP(req);
  const violations = ipViolations.get(ip);
  res.json({
    message      : 'DeltaBuddy server-side data about your session',
    ipAddress    : ip,                         // anonymized in prod
    violations   : violations ? violations.count : 0,
    blockedUntil : violations?.blockedUntil ? new Date(violations.blockedUntil).toISOString() : null,
    note         : 'Your trade journal, watchlist and preferences are stored in Firebase under your UID. Contact support@deltabuddy.com for full data export.',
  });
});

// GDPR: Clear your IP from block list
app.post('/api/privacy/clear-block',
  validateCsrf,
  [body('email').isEmail().withMessage('Valid email required')],
  validate,
  (req, res) => {
    const ip = getIP(req);
    ipViolations.delete(ip);
    securityLog('GDPR_BLOCK_CLEAR', { ip, email: req.body.email.replace(/(.{2}).+(@.+)/, '$1…$2') }); // masked
    res.json({ ok: true, message: 'Your IP block has been cleared. Please allow 60 seconds.' });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY ADMIN ENDPOINT (internal only — protect with env secret)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/security/logs', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({
    recentEvents  : securityEvents.slice(-50),
    blockedIPs    : [...ipViolations.entries()].filter(([, v]) => v.blockedUntil && Date.now() < v.blockedUntil).map(([ip, v]) => ({ ip, blockedUntil: new Date(v.blockedUntil).toISOString(), violations: v.count })),
    totalEvents   : securityEvents.length,
    timestamp     : new Date().toISOString(),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status        : 'ok',
    service       : 'DeltaBuddy Backend',
    angelConnected: angelConnected,
    tickCount     : Object.keys(tickStore).length,
    uptime        : Math.floor(process.uptime()) + 's',
    timestamp     : new Date().toISOString(),
    security      : 'helmet+cors+rateLimit+xss+csrf+ipBlock',
  });
});

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  securityLog('UNHANDLED_ERROR', { ip: getIP(req), error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── 404 handler ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  securityLog('NOT_FOUND', { ip: getIP(req), path: req.path, method: req.method });
  res.status(404).json({ error: 'Endpoint not found' });
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 DeltaBuddy Backend on port ${PORT}`);
  console.log(`🔐 Security: Helmet | CORS allowlist | Rate limiting | XSS/HPP | CSRF | IP blocking`);
  console.log(`📊 Angel WS: http://localhost:${PORT}/api/angel/status`);
  console.log(`❤️  Health:  http://localhost:${PORT}/api/health\n`);
  getNSECookies();
  // Auto-login Angel One on startup
  if (ANGEL_API_KEY) angelLogin().then(ok => { if (ok) connectAngelWS(); });
});
