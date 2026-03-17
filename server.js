const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = SUPABASE_URL + '/rest/v1/' + path;
    const urlObj = new URL(fullUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': method === 'POST' ? 'return=representation' : ''
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve([]); }
      });
    });
    req.on('error', (e) => { console.log('[DB] Error:', e.message); resolve([]); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sessions = {};
const clients = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { trades: [], locked: false, paused: false, lockedReason: '', date: new Date().toDateString() };
  }
  const s = sessions[sessionId];
  if (s.date !== new Date().toDateString()) {
    s.trades = []; s.locked = false; s.paused = false; s.lockedReason = ''; s.date = new Date().toDateString();
    console.log('[RESET] ' + sessionId + ' nouvelle journee');
  }
  return s;
}

function broadcast(sessionId, payload) {
  const room = clients[sessionId];
  if (!room) return;
  const msg = JSON.stringify(payload);
  room.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

async function saveTrade(trade, sessionId) {
  if (!SUPABASE_URL) return;
  try {
    await supabaseRequest('POST', 'trades', {
      session_id: sessionId,
      ticket: trade.ticket || null,
      symbol: trade.symbol,
      direction: trade.direction,
      price: trade.price || 0,
      quantity: trade.quantity || 1,
      sl: trade.sl || 0,
      tp: trade.tp || 0,
      pnl: trade.pnl || 0,
      status: trade.status || 'open',
      plan: trade.plan || 'yes',
      behaviour: trade.behaviour || '',
      note: trade.note || '',
      source: trade.source || 'mt5',
      trade_date: new Date().toISOString().split('T')[0]
    });
  } catch(e) { console.log('[DB] saveTrade error'); }
}

async function saveSession(sessionId) {
  if (!SUPABASE_URL) return;
  const s = getSession(sessionId);
  const closed = s.trades.filter(t => t.status === 'closed');
  const pnl = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl <= 0).length;
  const revenge = closed.filter(t => t.behaviour === 'revenge').length;
  const bad = closed.filter(t => t.plan === 'no').length;
  let score = Math.max(0, Math.min(100, 100 - (revenge * 10) - (bad * 15)));
  const today = new Date().toISOString().split('T')[0];
  try {
    await supabaseRequest('POST', 'daily_sessions?on_conflict=session_id,date', {
      session_id: sessionId, date: today, trades_count: closed.length,
      wins, losses, pnl: Math.round(pnl * 100) / 100, discipline_score: score, revenge_count: revenge
    });
  } catch(e) { console.log('[DB] saveSession error'); }
}

async function loadTodayTrades(sessionId) {
  if (!SUPABASE_URL) return [];
  const today = new Date().toISOString().split('T')[0];
  try {
    const data = await supabaseRequest('GET', 'trades?session_id=eq.' + sessionId + '&trade_date=eq.' + today + '&order=created_at.asc');
    if (!Array.isArray(data)) return [];
    return data.map(t => ({
      id: t.id, ticket: t.ticket, symbol: t.symbol, direction: t.direction,
      price: t.price, quantity: t.quantity, sl: t.sl, tp: t.tp, pnl: t.pnl,
      status: t.status, plan: t.plan, behaviour: t.behaviour, note: t.note, source: t.source,
      timestamp: t.created_at,
      time: new Date(t.created_at).toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})
    }));
  } catch(e) { return []; }
}

async function getMonthlyStats(sessionId) {
  if (!SUPABASE_URL) return [];
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  try {
    const data = await supabaseRequest('GET', 'daily_sessions?session_id=eq.' + sessionId + '&date=gte.' + firstDay + '&order=date.asc');
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || 'default';
  if (!clients[sessionId]) clients[sessionId] = new Set();
  clients[sessionId].add(ws);
  const session = getSession(sessionId);
  const dbTrades = await loadTodayTrades(sessionId);
  if (dbTrades.length > 0) session.trades = dbTrades;
  ws.send(JSON.stringify({ type: 'INIT', trades: session.trades, locked: session.locked }));
  ws.on('close', () => clients[sessionId] && clients[sessionId].delete(ws));
  ws.on('message', async (data) => {
    try {
      const m = JSON.parse(data);
      if (m.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
      if (m.type === 'LOCK') { session.locked = true; session.lockedReason = m.reason || ''; await saveSession(sessionId); broadcast(sessionId, { type: 'STATUS', locked: true }); }
      if (m.type === 'UNLOCK') { session.locked = false; broadcast(sessionId, { type: 'STATUS', locked: false }); }
      if (m.type === 'SAVE_SESSION') await saveSession(sessionId);
    } catch(e) {}
  });
});

app.post('/webhook/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(sessionId);
  if (session.locked) return res.status(403).json({ blocked: true, reason: session.lockedReason });
  const { symbol, action, price, quantity, sl, tp, ticket, comment } = req.body;
  if (!symbol || !action) return res.status(400).json({ error: 'requis: symbol, action' });
  const dir = (action.toLowerCase().includes('buy') || action.toLowerCase().includes('long')) ? 'long' : 'short';
  const trade = {
    id: crypto.randomUUID(), ticket: ticket ? String(ticket) : null,
    symbol: symbol.toUpperCase(), direction: dir,
    price: parseFloat(price) || 0, quantity: parseFloat(quantity) || 1,
    sl: parseFloat(sl) || 0, tp: parseFloat(tp) || 0,
    pnl: 0, status: 'open', plan: 'yes', note: comment || '', source: 'mt5',
    timestamp: new Date().toISOString(),
    time: new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})
  };
  session.trades.push(trade);
  await saveTrade(trade, sessionId);
  broadcast(sessionId, { type: 'NEW_TRADE', trade });
  res.json({ success: true, tradeId: trade.id });
});

app.post('/trade/:sessionId/:ticketOrId/close', async (req, res) => {
  const { sessionId, ticketOrId } = req.params;
  const session = getSession(sessionId);
  const trade = session.trades.find(t => t.ticket === ticketOrId || t.id === ticketOrId);
  if (!trade) return res.status(404).json({ error: 'Trade non trouve' });
  trade.pnl = parseFloat(req.body.pnl) || 0;
  trade.status = 'closed';
  if (SUPABASE_URL) {
    try { await supabaseRequest('PATCH', 'trades?id=eq.' + trade.id, { pnl: trade.pnl, status: 'closed' }); } catch(e) {}
  }
  broadcast(sessionId, { type: 'TRADE_CLOSED', trade });
  await saveSession(sessionId);
  res.json({ success: true, trade });
});

app.get('/stats/monthly/:sessionId', async (req, res) => {
  const stats = await getMonthlyStats(req.params.sessionId);
  res.json({ stats });
});

app.get('/status/:sessionId', (req, res) => {
  const s = getSession(req.params.sessionId);
  res.json({ locked: s.locked, paused: s.paused, reason: s.lockedReason, trades_today: s.trades.length, date: s.date });
});

app.get('/trades/:sessionId', (req, res) => {
  res.json({ trades: getSession(req.params.sessionId).trades });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!(SUPABASE_URL && SUPABASE_KEY), uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('TradeCoach v3 + Supabase port ' + PORT));
