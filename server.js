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

// ── NSE LIVE QUOTES ───────────────────────────────────────────────────────────
// Returns real-time prices, change, % change, prevClose for all NSE indices + stocks
// Source: NSE allIndices + equity stock indices — same data as NSE website & brokers

// Cache: 10 seconds (NSE updates every ~15s)
let nseQuoteCache = null;
let nseQuoteCacheTime = 0;
const NSE_QUOTE_TTL = 5000;

async function fetchNSEAllIndices() {
  const cookies = await getNSECookies();
  const r = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 12000
  });
  if (!r.ok) throw new Error(`allIndices ${r.status}`);
  const d = await r.json();
  return d.data || [];
}

async function fetchNSENifty50Stocks() {
  const cookies = await getNSECookies();
  const r = await fetch('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', {
    headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 12000
  });
  if (!r.ok) throw new Error(`equity-stockIndices ${r.status}`);
  const d = await r.json();
  return d.data || [];
}

app.get('/api/nse-quotes', async (req, res) => {
  try {
    // Serve cache if fresh
    if (nseQuoteCache && (Date.now() - nseQuoteCacheTime) < NSE_QUOTE_TTL) {
      return res.json(nseQuoteCache);
    }

    // Fetch indices and Nifty50 stocks in parallel
    const [indices, stocks] = await Promise.allSettled([
      fetchNSEAllIndices(),
      fetchNSENifty50Stocks(),
    ]);

    const result = {};

    // Process indices
    if (indices.status === 'fulfilled') {
      indices.value.forEach(idx => {
        const name = idx.index || idx.indexSymbol;
        if (!name) return;
        result[name] = {
          price     : idx.last || idx.lastPrice || 0,
          change    : idx.percentChange || idx.pChange || 0,
          prevClose : idx.previousClose || idx.previousDay || 0,
          netChange : idx.variation || idx.change || 0,
          open      : idx.open || 0,
          high      : idx.high || 0,
          low       : idx.low || 0,
          type      : 'index',
        };
      });
    }

    // Process Nifty50 stocks (skip META row which has index summary)
    if (stocks.status === 'fulfilled') {
      stocks.value.forEach(s => {
        const sym = s.symbol;
        if (!sym || sym === 'NIFTY 50') return;
        result[sym] = {
          price     : s.lastPrice || s.ltp || 0,
          change    : s.pChange || s.percentChange || 0,
          prevClose : s.previousClose || s.previousDay || 0,
          netChange : s.change || 0,
          open      : s.open || 0,
          high      : s.dayHigh || s.high || 0,
          low       : s.dayLow  || s.low  || 0,
          type      : 'stock',
        };
      });
    }

    if (Object.keys(result).length === 0) throw new Error('No data from NSE');

    nseQuoteCache     = result;
    nseQuoteCacheTime = Date.now();
    res.json(result);

  } catch(e) {
    // If cache exists (even stale), return it with warning
    if (nseQuoteCache) {
      return res.json({ ...nseQuoteCache, _stale: true, _error: e.message });
    }
    res.status(502).json({ error: 'NSE quotes failed', detail: e.message });
  }
});

// ── GEX / GREEKS ANALYSIS ENDPOINT ────────────────────────────────────────────
// Calculates Gamma Exposure (GEX), Delta Walls, Vanna, Charm from NSE OC data
app.get('/api/gex', async (req, res) => {
  const symbol  = (req.query.symbol || 'NIFTY').toUpperCase();
  const isIndex = INDEX_SYMBOLS.includes(symbol);
  const apiUrl  = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;

  try {
    // Reuse the same robust fetch logic as /api/option-chain (with retry)
    let raw;
    const cookies = await getNSECookies();
    const r = await fetch(apiUrl, { headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 15000 });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        nseLastFetch = 0;
        const fresh = await getNSECookies();
        const retry = await fetch(apiUrl, { headers: { ...NSE_BASE_HEADERS, Cookie: fresh }, timeout: 15000 });
        if (!retry.ok) throw new Error(`NSE ${retry.status} after retry`);
        raw = await retry.json();
      } else {
        throw new Error(`NSE ${r.status}`);
      }
    } else {
      raw = await r.json();
    }

    if (!raw?.records?.underlyingValue) {
      throw new Error('NSE returned empty data — market may be closed');
    }

    const spot      = raw.records?.underlyingValue || 0;

    // Extract lot size directly from NSE data — first row that has it
    const allRows    = raw.records?.data || [];
    const expiryDates = raw.records?.expiryDates || [];
    const nearExpiry  = expiryDates[0] || '';
    const rows        = nearExpiry
      ? allRows.filter(r => r.expiryDate === nearExpiry)
      : allRows.slice(0, 100);

    // NSE provides marketLotSize on each option row — use it directly
    let lotSize = 0;
    for (const row of rows) {
      const opt = row.CE || row.PE;
      if (opt && opt.marketLot) { lotSize = opt.marketLot; break; }
      if (opt && opt.totalTradedVolume && row.CE?.openInterest) {
        // fallback — some NSE responses use different field names
      }
    }
    // Last resort fallback with correct values as of Mar 2025
    if (!lotSize) {
      const fallback = { NIFTY:75, BANKNIFTY:30, FINNIFTY:60, MIDCPNIFTY:120 };
      lotSize = fallback[symbol] || 75;
    }

    // Black-Scholes helpers
    function erf(x) {
      const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
      const sign = x < 0 ? -1 : 1; x = Math.abs(x);
      const t = 1/(1+p*x);
      const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
      return sign*y;
    }
    function normCDF(x) { return 0.5*(1+erf(x/Math.sqrt(2))); }
    function normPDF(x) { return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

    function bsGreeks(S, K, T, r, sigma, type) {
      if (T <= 0 || sigma <= 0) return { delta:0, gamma:0, vanna:0, charm:0, theta:0 };
      const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
      const d2 = d1 - sigma*Math.sqrt(T);
      const nd1 = normPDF(d1);
      const gamma  = nd1 / (S * sigma * Math.sqrt(T));
      const delta  = type === 'CE' ? normCDF(d1) : normCDF(d1) - 1;
      const vanna  = -nd1 * d2 / sigma;                                // dDelta/dVol
      const charm  = type === 'CE'
        ? -nd1 * (2*r*T - d2*sigma*Math.sqrt(T)) / (2*T*sigma*Math.sqrt(T))
        : -nd1 * (2*r*T - d2*sigma*Math.sqrt(T)) / (2*T*sigma*Math.sqrt(T));
      const theta  = type === 'CE'
        ? (-S*nd1*sigma/(2*Math.sqrt(T)) - r*K*Math.exp(-r*T)*normCDF(d2)) / 365
        : (-S*nd1*sigma/(2*Math.sqrt(T)) + r*K*Math.exp(-r*T)*normCDF(-d2)) / 365;
      return { delta, gamma, vanna, charm, theta };
    }

    const now = new Date();

    // NSE returns dates like "28-Nov-2024" — parse manually
    const monthMap = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    function parseNSEDate(str) {
      if (!str) return null;
      const parts = str.split('-');
      if (parts.length === 3) {
        const d = parseInt(parts[0]);
        const m = monthMap[parts[1]];
        const y = parseInt(parts[2]);
        if (!isNaN(d) && m !== undefined && !isNaN(y)) return new Date(y, m, d, 15, 30, 0);
      }
      const fallback = new Date(str);
      return isNaN(fallback) ? null : fallback;
    }
    const strikes = {};

    rows.forEach(row => {
      const K = row.strikePrice;
      if (!K) return;

      ['CE','PE'].forEach(type => {
        const opt = row[type];
        if (!opt) return;
        const expiryRaw  = opt.expiryDate || row.expiryDate;
        const expiry     = parseNSEDate(expiryRaw);
        if (!expiry) return;
        const T          = Math.max((expiry - now) / (1000*60*60*24*365), 0.001);
        const iv        = (opt.impliedVolatility || opt.IV || 20) / 100;
        const oi        = opt.openInterest || 0;
        const oiChg     = opt.changeinOpenInterest || 0;
        const g         = bsGreeks(spot, K, T, 0.065, iv, type);

        if (!strikes[K]) strikes[K] = { strike:K, ceGEX:0, peGEX:0, ceDelta:0, peDelta:0, ceVanna:0, peVanna:0, ceCharm:0, peCharm:0, ceOI:0, peOI:0, ceOIChg:0, peOIChg:0, ceLTP:0, peLTP:0, ceIV:0, peIV:0 };

        const contracts = oi * lotSize;
        if (type === 'CE') {
          strikes[K].ceGEX   = g.gamma * contracts * spot * spot * 0.01;
          strikes[K].ceDelta = g.delta * contracts;
          strikes[K].ceVanna = g.vanna * contracts;
          strikes[K].ceCharm = g.charm * contracts;
          strikes[K].ceOI    = oi;
          strikes[K].ceOIChg = oiChg;
          strikes[K].ceLTP   = opt.lastPrice || 0;
          strikes[K].ceIV    = opt.impliedVolatility || 0;
        } else {
          strikes[K].peGEX   = g.gamma * contracts * spot * spot * 0.01;
          strikes[K].peDelta = g.delta * contracts;
          strikes[K].peVanna = g.vanna * contracts;
          strikes[K].peCharm = g.charm * contracts;
          strikes[K].peOI    = oi;
          strikes[K].peOIChg = oiChg;
          strikes[K].peLTP   = opt.lastPrice || 0;
          strikes[K].peIV    = opt.impliedVolatility || 0;
        }
      });
    });

    const strikesArr = Object.values(strikes).sort((a,b) => a.strike - b.strike);

    // Net GEX per strike (dealers are short calls, long puts => flip signs)
    // Positive GEX = dealers buy on dips (stabilising), Negative = dealers sell (accelerating)
    strikesArr.forEach(s => {
      s.netGEX     = s.ceGEX - s.peGEX;
      s.netDelta   = s.ceDelta + s.peDelta;
      s.netVanna   = s.ceVanna + s.peVanna;
      s.netCharm   = s.ceCharm + s.peCharm;
    });

    const totalGEX   = strikesArr.reduce((sum,s) => sum + s.netGEX, 0);

    // Gamma flip - strike where net GEX crosses zero
    let gammaFlip = null;
    for (let i = 1; i < strikesArr.length; i++) {
      if (strikesArr[i-1].netGEX * strikesArr[i].netGEX < 0) {
        gammaFlip = strikesArr[i].strike;
        break;
      }
    }

    // Gamma walls (top 3 positive and negative GEX strikes)
    const sorted = [...strikesArr].sort((a,b) => Math.abs(b.netGEX) - Math.abs(a.netGEX));
    const posWalls = sorted.filter(s => s.netGEX > 0).slice(0,3).map(s => s.strike);
    const negWalls = sorted.filter(s => s.netGEX < 0).slice(0,3).map(s => s.strike);

    // Delta walls - top call OI and put OI (classic support/resistance)
    const topCallOI = [...strikesArr].sort((a,b) => b.ceOI - a.ceOI).slice(0,3).map(s => s.strike);
    const topPutOI  = [...strikesArr].sort((a,b) => b.peOI - a.peOI).slice(0,3).map(s => s.strike);

    // Vanna flip - where vanna changes sign (vol-driven directional risk)
    let vannaFlip = null;
    for (let i = 1; i < strikesArr.length; i++) {
      if (strikesArr[i-1].netVanna * strikesArr[i].netVanna < 0) {
        vannaFlip = strikesArr[i].strike;
        break;
      }
    }

    // Charm weighted centre (time-decay pressure level)
    const totalCharmAbs = strikesArr.reduce((sum,s) => sum + Math.abs(s.netCharm), 0);
    const charmCentre = totalCharmAbs > 0
      ? strikesArr.reduce((sum,s) => sum + s.strike * Math.abs(s.netCharm), 0) / totalCharmAbs
      : spot;

    // Zone classification
    const aboveFlip = gammaFlip && spot > gammaFlip;
    const zoneLabel = totalGEX > 0
      ? (aboveFlip ? 'Positive Gamma - Pinning likely' : 'Positive Gamma - Range bound')
      : 'Negative Gamma - Trend amplification';

    res.json({
      symbol, spot, lotSize, totalGEX: Math.round(totalGEX),
      gammaFlip, vannaFlip, charmCentre: Math.round(charmCentre),
      posWalls, negWalls, topCallOI, topPutOI,
      zoneLabel,
      regime: totalGEX > 0 ? 'positive' : 'negative',
      nearExpiry,
      rowCount: rows.length,
      lotSizeSource: lotSize ? 'nse' : 'fallback',
      strikes: strikesArr.slice(
        Math.max(0, strikesArr.findIndex(s => s.strike >= spot * 0.97)),
        strikesArr.findIndex(s => s.strike >= spot * 1.03) + 1
      ),
    });
  } catch(e) {
    res.status(502).json({ error: 'GEX calculation failed', detail: e.message });
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

// ── India VIX ─────────────────────────────────────────────────────────────────
// India VIX Yahoo Finance ticker: ^INDIAVIX
app.get('/api/vix', async (req, res) => {
  try {
    const data = await fetchYahooQuote('^INDIAVIX');
    if (!data) throw new Error('No data');
    const vix = data.price;
    const change = data.change;
    // Classify
    const level = vix > 24 ? 'HIGH' : vix > 20 ? 'ELEVATED' : vix > 14 ? 'MODERATE' : 'LOW';
    const color = vix > 24 ? 'red' : vix > 20 ? 'orange' : vix > 14 ? 'yellow' : 'green';
    res.json({ vix, change, level, color });
  } catch(e) {
    res.status(502).json({ error: 'VIX fetch failed', detail: e.message });
  }
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

// ── FIREBASE ADMIN — read all user Chat IDs from Firestore ───────────────────
let db_admin = null;
try {
  const admin = require('firebase-admin');
  const svcAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcAccount && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(svcAccount)),
    });
    db_admin = admin.firestore();
    console.log('[Firebase] Admin SDK initialized');
  }
} catch(e) {
  console.warn('[Firebase] Admin SDK not available:', e.message);
}

// Load all tgChatIds from Firestore users collection
async function loadSubscribersFromFirestore() {
  if (!db_admin) return;
  try {
    const snap = await db_admin.collection('users').get();
    let added = 0;
    snap.forEach(doc => {
      const { tgChatId } = doc.data();
      if (tgChatId && String(tgChatId).trim()) {
        alertSubscribers.add(String(tgChatId).trim());
        added++;
      }
    });
    console.log(`[Firebase] Loaded ${added} subscriber(s) from Firestore. Total: ${alertSubscribers.size}`);
  } catch(e) {
    console.warn('[Firebase] Could not load subscribers:', e.message);
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
app.post('/api/alert-subscribe', async (req, res) => {
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

// ── FII / DII DATA — NSE EOD ──────────────────────────────────────────────────
// Cache: 30 minutes (NSE updates once per day after market close)
let fiiDiiCache = null;
let fiiDiiLastFetch = 0;
const FII_DII_TTL = 30 * 60 * 1000;

app.get('/api/nse/fii-dii', async (req, res) => {
  try {
    if (fiiDiiCache && (Date.now() - fiiDiiLastFetch) < FII_DII_TTL) {
      return res.json(fiiDiiCache);
    }
    const cookies = await getNSECookies();

    // NSE FII/DII cash market data — last 10 trading days
    const url = 'https://www.nseindia.com/api/fiidiiTradeReact';
    const r = await fetch(url, {
      headers: { ...NSE_BASE_HEADERS, Cookie: cookies },
      timeout: 12000,
    });
    if (!r.ok) throw new Error(`NSE FII/DII ${r.status}`);
    const raw = await r.json();

    // NSE returns array of daily records
    // Each record: { date, fii_buy_value, fii_sell_value, fii_net_value, dii_buy_value, dii_sell_value, dii_net_value }
    const data = (Array.isArray(raw) ? raw : raw.data || [])
      .slice(0, 10)
      .map(d => ({
        date    : d.date || d.trading_date || d.Date || '',
        fiiBuy  : parseFloat(d.fii_buy_value  || d.FII_BUY_VALUE  || d.fiiBuy  || 0),
        fiiSell : parseFloat(d.fii_sell_value || d.FII_SELL_VALUE || d.fiiSell || 0),
        fiiNet  : parseFloat(d.fii_net_value  || d.FII_NET_VALUE  || d.fiiNet  || 0),
        diiBuy  : parseFloat(d.dii_buy_value  || d.DII_BUY_VALUE  || d.diiBuy  || 0),
        diiSell : parseFloat(d.dii_sell_value || d.DII_SELL_VALUE || d.diiSell || 0),
        diiNet  : parseFloat(d.dii_net_value  || d.DII_NET_VALUE  || d.diiNet  || 0),
      }))
      .filter(d => d.date);

    // Latest day summary
    const latest = data[0] || {};
    const result = {
      data,
      latest: {
        fii: { buy: latest.fiiBuy, sell: latest.fiiSell, net: latest.fiiNet },
        dii: { buy: latest.diiBuy, sell: latest.diiSell, net: latest.diiNet },
        date: latest.date,
      },
      source: 'NSE',
      fetchedAt: new Date().toISOString(),
    };

    fiiDiiCache = result;
    fiiDiiLastFetch = Date.now();
    res.json(result);
  } catch(e) {
    // Return stale cache if available
    if (fiiDiiCache) return res.json({ ...fiiDiiCache, stale: true });
    res.status(502).json({ error: 'FII/DII fetch failed', detail: e.message });
  }
});

// ── EVENTS / ECONOMIC CALENDAR — NSE ─────────────────────────────────────────
let eventsCache = null;
let eventsLastFetch = 0;
const EVENTS_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/nse/events', async (req, res) => {
  try {
    if (eventsCache && (Date.now() - eventsLastFetch) < EVENTS_TTL) {
      return res.json(eventsCache);
    }
    const cookies = await getNSECookies();

    // Fetch corporate events (results, dividends, AGM, bonus)
    const eventsUrl = 'https://www.nseindia.com/api/event-calendar';
    const r = await fetch(eventsUrl, {
      headers: { ...NSE_BASE_HEADERS, Cookie: cookies },
      timeout: 12000,
    });
    if (!r.ok) throw new Error(`NSE events ${r.status}`);
    const raw = await r.json();

    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);

    const events = (Array.isArray(raw) ? raw : raw.data || [])
      .map(e => ({
        date    : e.date || e.Date || '',
        company : e.symbol || e.companyName || e.company || '',
        type    : (e.purpose || e.type || '').toLowerCase(),
        title   : e.purpose || e.description || e.type || '',
        impact  : ['results','dividend','board meeting','agm'].some(k =>
                    (e.purpose||'').toLowerCase().includes(k)) ? 'high' : 'medium',
      }))
      .filter(e => {
        if (!e.date) return false;
        const d = new Date(e.date);
        return d >= today && d <= nextMonth;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 30);

    eventsCache = { events, fetchedAt: new Date().toISOString(), source: 'NSE' };
    eventsLastFetch = Date.now();
    res.json(eventsCache);
  } catch(e) {
    if (eventsCache) return res.json({ ...eventsCache, stale: true });
    res.status(502).json({ error: 'Events fetch failed', detail: e.message });
  }
});

// ── BULK & BLOCK DEALS — NSE ──────────────────────────────────────────────────
let bulkDealsCache = null;
let bulkDealsLastFetch = 0;
const BULK_DEALS_TTL = 30 * 60 * 1000; // 30 min

app.get('/api/nse/bulk-deals', async (req, res) => {
  try {
    if (bulkDealsCache && (Date.now() - bulkDealsLastFetch) < BULK_DEALS_TTL) {
      return res.json(bulkDealsCache);
    }
    const cookies = await getNSECookies();

    const [bulkR, blockR] = await Promise.allSettled([
      fetch('https://www.nseindia.com/api/bulkdeals', { headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 12000 }),
      fetch('https://www.nseindia.com/api/blockdeals', { headers: { ...NSE_BASE_HEADERS, Cookie: cookies }, timeout: 12000 }),
    ]);

    const parseDeal = (raw, type) => (Array.isArray(raw) ? raw : raw?.data || [])
      .slice(0, 20)
      .map(d => ({
        date    : d.BD_DT_DATE || d.BD_DATE || d.date || '',
        stock   : d.BD_SYMBOL || d.symbol || '',
        client  : d.BD_CLIENT_NAME || d.clientName || '',
        type    : (d.BD_BUY_SELL || d.buyOrSell || '').toUpperCase(),
        quantity: parseInt(d.BD_QTY_TRD || d.quantity || 0),
        price   : parseFloat(d.BD_TP_WATP || d.price || 0),
        value   : parseFloat(d.BD_TP_WATP || 0) * parseInt(d.BD_QTY_TRD || 0) / 1e7, // ₹ Cr
        dealType: type,
      }));

    const bulkDeals  = bulkR.status === 'fulfilled' && bulkR.value.ok  ? parseDeal(await bulkR.value.json(),  'Bulk')  : [];
    const blockDeals = blockR.status === 'fulfilled' && blockR.value.ok ? parseDeal(await blockR.value.json(), 'Block') : [];

    bulkDealsCache = { bulkDeals, blockDeals, fetchedAt: new Date().toISOString(), source: 'NSE' };
    bulkDealsLastFetch = Date.now();
    res.json(bulkDealsCache);
  } catch(e) {
    if (bulkDealsCache) return res.json({ ...bulkDealsCache, stale: true });
    res.status(502).json({ error: 'Bulk/Block deals fetch failed', detail: e.message });
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

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-BROKER SUPPORT — Zerodha Kite + Angel One
// ══════════════════════════════════════════════════════════════════════════════

// ── ZERODHA KITE ─────────────────────────────────────────────────────────────
// User must provide their own Kite API key + access token
// Access token is generated daily via Kite login flow

async function zerodhaAPI(path, accessToken, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'X-Kite-Version': '3',
      'Authorization' : `token ${process.env.ZERODHA_API_KEY}:${accessToken}`,
      'Content-Type'  : 'application/x-www-form-urlencoded',
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const r = await fetch(`https://api.kite.trade${path}`, opts);
  const data = await r.json();
  if (data.status === 'error') throw new Error(data.message || 'Zerodha API error');
  return data.data || data;
}

// GET /api/zerodha/portfolio?access_token=xxx
app.get('/api/zerodha/portfolio', async (req, res) => {
  const token = req.query.access_token || req.headers['x-zerodha-token'];
  if (!token) return res.status(400).json({ error: 'access_token required' });
  try {
    const [positions, holdings, margins] = await Promise.all([
      zerodhaAPI('/portfolio/positions', token).catch(e => ({ error: e.message })),
      zerodhaAPI('/portfolio/holdings',  token).catch(e => ({ error: e.message })),
      zerodhaAPI('/user/margins',        token).catch(e => ({ error: e.message })),
    ]);
    res.json({ broker: 'zerodha', positions, holdings, margins });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/zerodha/orders?access_token=xxx
app.get('/api/zerodha/orders', async (req, res) => {
  const token = req.query.access_token || req.headers['x-zerodha-token'];
  if (!token) return res.status(400).json({ error: 'access_token required' });
  try {
    const data = await zerodhaAPI('/orders', token);
    res.json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// GET /api/zerodha/login-url — generate Kite login URL for user
app.get('/api/zerodha/login-url', (req, res) => {
  const apiKey = process.env.ZERODHA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ZERODHA_API_KEY not configured' });
  res.json({ url: `https://kite.trade/connect/login?api_key=${apiKey}&v=3` });
});

// POST /api/zerodha/session — exchange request_token for access_token
app.post('/api/zerodha/session', async (req, res) => {
  const { request_token } = req.body;
  const apiKey    = process.env.ZERODHA_API_KEY;
  const apiSecret = process.env.ZERODHA_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(503).json({ error: 'Zerodha keys not configured' });
  if (!request_token) return res.status(400).json({ error: 'request_token required' });
  try {
    const crypto = require('crypto');
    const checksum = crypto.createHash('sha256')
      .update(apiKey + request_token + apiSecret).digest('hex');
    const r = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: apiKey, request_token, checksum }).toString(),
    });
    const data = await r.json();
    if (data.status === 'error') throw new Error(data.message);
    res.json({ access_token: data.data.access_token, user: data.data.user_name });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── ANGEL ONE ────────────────────────────────────────────────────────────────
// User provides their own Angel API key + JWT token
// JWT token obtained by user logging in separately

async function angelOneAPI(path, jwtToken, method = 'GET', body = null) {
  const apiKey = process.env.ANGEL_API_KEY_SHARED || req?.headers?.['x-angel-apikey'];
  const opts = {
    method,
    headers: {
      'Content-Type'   : 'application/json',
      'Accept'         : 'application/json',
      'X-UserType'     : 'USER',
      'X-SourceID'     : 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress'   : '00:00:00:00:00:00',
      'X-PrivateKey'   : apiKey || '',
      'Authorization'  : `Bearer ${jwtToken}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://apiconnect.angelone.in${path}`, opts);
  const data = await r.json();
  if (data.status === false) throw new Error(data.message || 'Angel One API error');
  return data.data || data;
}

// GET /api/angel/portfolio?jwt=xxx&apikey=xxx
app.get('/api/angel/portfolio', async (req, res) => {
  const jwt    = req.query.jwt || req.headers['x-angel-jwt'];
  const apiKey = req.query.apikey || req.headers['x-angel-apikey'];
  if (!jwt) return res.status(400).json({ error: 'jwt token required' });
  try {
    const headers = {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': apiKey || '', 'Authorization': `Bearer ${jwt}`,
    };
    const [positions, holdings, rms] = await Promise.all([
      fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition', { headers })
        .then(r=>r.json()).catch(e=>({ error: e.message })),
      fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getAllHolding', { headers })
        .then(r=>r.json()).catch(e=>({ error: e.message })),
      fetch('https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS', { headers })
        .then(r=>r.json()).catch(e=>({ error: e.message })),
    ]);
    res.json({ broker: 'angelone', positions: positions.data, holdings: holdings.data, funds: rms.data });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── SCREENSHOT ANALYSIS — Claude Vision ───────────────────────────────────────
// POST /api/analyze-screenshot
// Body: { image: base64string, mediaType: 'image/jpeg' }
app.post('/api/analyze-screenshot', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  const { image, mediaType = 'image/jpeg' } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) required' });

  // Validate base64 size — reject if > 5MB decoded
  const approxBytes = image.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large. Please screenshot a smaller area or reduce image quality.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: image }
            },
            {
              type: 'text',
              text: `This is a screenshot from an Indian stock broker app (Zerodha, Angel One, ICICI Direct, HDFC Securities, Upstox, 5paisa, Groww, or similar) showing trading positions or holdings.

Extract ALL positions/holdings visible and return ONLY a valid JSON array. No explanation, no markdown, no backticks. Just the raw JSON array.

Each position object must have exactly these fields:
- symbol: stock or option symbol as shown (string)
- qty: quantity as number (positive for BUY/long, negative for SELL/short)
- avgPrice: average buy/cost price as number
- ltp: last traded price if visible, else 0
- pnl: profit and loss value if visible, else 0
- type: "BUY" or "SELL"
- product: "INTRADAY", "DELIVERY", "FUTURES", or "OPTIONS"

If no positions are visible, return: []`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: 'Claude API error', detail: err.slice(0, 200) });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    // Clean and parse
    const clean = text.replace(/```json|```/g, '').trim();
    let positions;
    try {
      positions = JSON.parse(clean);
      if (!Array.isArray(positions)) throw new Error('Not an array');
    } catch(e) {
      // Try to extract JSON array from response
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        positions = JSON.parse(match[0]);
      } else {
        positions = [];
      }
    }

    res.json({ positions, raw: text });
  } catch(e) {
    res.status(502).json({ error: 'Analysis failed: ' + e.message });
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

  // Load subscribers from Firestore then refresh every 5 minutes
  loadSubscribersFromFirestore();
  setInterval(loadSubscribersFromFirestore, 5 * 60 * 1000);

  // ── Keep-alive ping so Render free tier never sleeps ──────────────────
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${SELF_URL}/api/health`)
      .then(() => console.log('[Keep-alive] ping ok'))
      .catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
});
