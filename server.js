const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function db(endpoint, method, body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + endpoint, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': method === 'POST' ? 'return=representation' : ''
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) { console.log('DB error:', res.status, await res.text()); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch(e) { console.log('DB error:', e.message); return null; }
}

async function saveTrade(sessionId, trade) {
  return await db('trades', 'POST', {
    session_id: sessionId,
    ticket: trade.ticket,
    symbol: trade.symbol,
    direction: trade.direction,
    price: trade.price,
    quantity: trade.quantity,
    sl: trade.sl || 0,
    tp: trade.tp || 0,
    pnl: trade.pnl || 0,
    status: trade.status || 'open',
    plan: trade.plan || 'yes',
    behaviour: trade.behaviour || '',
    note: trade.note || '',
    source: trade.source || 'manual',
    trade_date: new Date().toISOString().split('T')[0]
  });
}

async function closeTrade(sessionId, ticketOrId, pnl) {
  await db('trades?or=(ticket.eq.' + ticketOrId + ',id.eq.' + ticketOrId + ')&session_id=eq.' + sessionId, 'PATCH', { pnl, status: 'closed' });
}

async function getTodayTrades(sessionId) {
  const today = new Date().toISOString().split('T')[0];
  return await db('trades?session_id=eq.' + sessionId + '&trade_date=eq.' + today + '&order=created_at.asc');
}

async function getMonthlyData(sessionId, year, month) {
  const from = year + '-' + String(month).padStart(2,'0') + '-01';
  const to = year + '-' + String(month + 1).padStart(2,'0') + '-01';
  return await db('daily_sessions?session_id=eq.' + sessionId + '&date=gte.' + from + '&date=lt.' + to + '&order=date.asc');
}

async function saveDaily(sessionId, data) {
  const today = new Date().toISOString().split('T')[0];
  return await db('daily_sessions', 'POST', {
    session_id: sessionId,
    date: today,
    trades_count: data.trades_count || 0,
    wins: data.wins || 0,
    losses: data.losses || 0,
    pnl: data.pnl || 0,
    discipline_score: data.discipline_score || 0,
    revenge_count: data.revenge_count || 0
  });
}

const sessions = {};
const clients = {};

function broadcast(sessionId, payload) {
  const room = clients[sessionId];
  if (!room) return;
  const msg = JSON.stringify(payload);
  room.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { trades: [], locked: false, paused: false, lockedReason: '', date: new Date().toDateString() };
  }
  const s = sessions[sessionId];
  if (s.date !== new Date().toDateString()) {
    s.trades = []; s.locked = false; s.paused = false; s.lockedReason = '';
    s.date = new Date().toDateString();
    console.log('[RESET] ' + sessionId + ' - nouvelle journee');
  }
  return s;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || 'default';
  if (!clients[sessionId]) clients[sessionId] = new Set();
  clients[sessionId].add(ws);
  const session = getSession(sessionId);

  getTodayTrades(sessionId).then(dbTrades => {
    if (dbTrades && dbTrades.length > 0) {
      session.trades = dbTrades.map(t => ({
        id: t.id, ticket: t.ticket, symbol: t.symbol, direction: t.direction,
        price: t.price, quantity: t.quantity, pnl: t.pnl, status: t.status,
        plan: t.plan, behaviour: t.behaviour, note: t.note, source: t.source,
        time: new Date(t.created_at).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}),
        timestamp: t.created_at
      }));
    }
    ws.send(JSON.stringify({ type: 'INIT', trades: session.trades, locked: session.locked }));
  }).catch(() => ws.send(JSON.stringify({ type: 'INIT', trades: session.trades, locked: session.locked })));

  ws.on('close', () => clients[sessionId] && clients[sessionId].delete(ws));
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      if (m.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
      if (m.type === 'LOCK') { session.locked = true; session.lockedReason = m.reason || ''; broadcast(sessionId, { type: 'STATUS', locked: true, reason: session.lockedReason }); }
      if (m.type === 'UNLOCK') { session.locked = false; session.paused = false; broadcast(sessionId, { type: 'STATUS', locked: false }); }
      if (m.type === 'SAVE_SESSION') saveDaily(sessionId, m.data);
    } catch(e) {}
  });
});

app.get('/status/:sessionId', (req, res) => {
  const s = getSession(req.params.sessionId);
  res.json({ locked: s.locked, paused: s.paused, reason: s.lockedReason || '', trades_today: s.trades.length, date: s.date });
});

app.post('/lock/:sessionId', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const s = getSession(req.params.sessionId);
  s.locked = true; s.lockedReason = req.body.reason || 'Verrouille';
  broadcast(req.params.sessionId, { type: 'STATUS', locked: true, reason: s.lockedReason });
  res.json({ success: true });
});

app.post('/unlock/:sessionId', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const s = getSession(req.params.sessionId);
  s.locked = false; s.paused = false;
  broadcast(req.params.sessionId, { type: 'STATUS', locked: false });
  res.json({ success: true });
});

app.post('/webhook/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const session = getSession(sessionId);
  if (session.locked) return res.status(403).json({ blocked: true, reason: session.lockedReason || 'Session verrouillee' });

  const { symbol, action, price, quantity, sl, tp, ticket, comment } = req.body;
  if (!symbol || !action) return res.status(400).json({ error: 'symbol et action requis' });

  const dir = (action.toLowerCase().includes('buy') || action.toLowerCase().includes('long')) ? 'long' : 'short';
  const trade = {
    id: crypto.randomUUID(),
    ticket: ticket ? String(ticket) : null,
    symbol: symbol.toUpperCase(), direction: dir,
    price: parseFloat(price) || 0, quantity: parseFloat(quantity) || 1,
    sl: parseFloat(sl) || 0, tp: parseFloat(tp) || 0,
    pnl: 0, status: 'open', plan: 'yes',
    note: comment || '', source: 'mt5',
    timestamp: new Date().toISOString(),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  };

  session.trades.push(trade);
  saveTrade(sessionId, trade);
  broadcast(sessionId, { type: 'NEW_TRADE', trade });
  console.log('[MT5] ' + sessionId + ': ' + trade.symbol + ' ' + trade.direction + ' @ ' + trade.price);
  res.json({ success: true, tradeId: trade.id, blocked: false });
});

app.post('/trade/:sessionId/:ticketOrId/close', (req, res) => {
  const { sessionId, ticketOrId } = req.params;
  const { pnl } = req.body;
  const session = getSession(sessionId);
  const trade = session.trades.find(function(t) { return t.ticket === ticketOrId || t.id === ticketOrId; });
  if (!trade) return res.status(404).json({ error: 'Trade non trouve' });
  trade.pnl = parseFloat(pnl) || 0;
  trade.status = 'closed';
  trade.closedAt = new Date().toISOString();
  closeTrade(sessionId, ticketOrId, trade.pnl);
  broadcast(sessionId, { type: 'TRADE_CLOSED', trade });
  console.log('[MT5] Cloture: ' + trade.symbol + ' PnL=' + trade.pnl);
  res.json({ success: true, trade });
});

app.get('/trades/:sessionId', (req, res) => {
  res.json({ trades: getSession(req.params.sessionId).trades });
});

app.get('/monthly/:sessionId/:year/:month', async (req, res) => {
  const { sessionId, year, month } = req.params;
  const data = await getMonthlyData(sessionId, parseInt(year), parseInt(month));
  if (!data || !data.length) return res.json({ days: [], avg_score: 0, profitable_days: 0, total_pnl: 0, best_streak: 0 });
  const profitableDays = data.filter(d => d.pnl > 0).length;
  const avgScore = Math.round(data.reduce((a, d) => a + (d.discipline_score || 0), 0) / data.length);
  const totalPnl = data.reduce((a, d) => a + (d.pnl || 0), 0);
  let streak = 0, maxStreak = 0;
  for (const d of data) { if (d.discipline_score >= 70) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  res.json({ days: data, avg_score: avgScore, profitable_days: profitableDays, total_days: data.length, total_pnl: parseFloat(totalPnl.toFixed(2)), best_streak: maxStreak });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: SUPABASE_URL ? 'connected' : 'not configured', sessions: Object.keys(sessions).length, uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log('TradeCoach Backend v3 - Supabase - port ' + PORT);
});
