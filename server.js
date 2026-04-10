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

// ===== UTILS =====
function safeNumber(val, def = 0) {
const n = parseFloat(val);
return isNaN(n) ? def : n;
}

// ===== DATA =====
const sessions = {};
const clients = {};

// ===== BROADCAST =====
function broadcast(sessionId, payload) {
const room = clients[sessionId];
if (!room) return;

const msg = JSON.stringify(payload);
room.forEach(ws => {
if (ws.readyState === WebSocket.OPEN) {
ws.send(msg);
}
});
}

// ===== SESSION MANAGEMENT =====
function getSession(sessionId) {
if (!sessions[sessionId]) {
sessions[sessionId] = {
trades: [],
locked: false,
lockedReason: '',
date: new Date().toDateString()
};
}

const s = sessions[sessionId];

// RESET CHAQUE JOUR
if (s.date !== new Date().toDateString()) {
s.trades = [];
s.locked = false;
s.lockedReason = '';
s.date = new Date().toDateString();
console.log('[RESET]', sessionId);
}

return s;
}

// ===== WEBSOCKET =====
wss.on('connection', (ws, req) => {
const url = new URL(req.url, 'http://localhost');
const sessionId = url.searchParams.get('session') || 'default';

if (!clients[sessionId]) {
clients[sessionId] = new Set();
}

clients[sessionId].add(ws);

const session = getSession(sessionId);

ws.send(JSON.stringify({
type: 'INIT',
trades: session.trades,
locked: session.locked
}));

ws.on('close', () => {
clients[sessionId].delete(ws);
});

ws.on('message', (data) => {
try {
const m = JSON.parse(data);
if (m.type === 'PING') {
ws.send(JSON.stringify({ type: 'PONG' }));
}
} catch (e) {}
});
});

// ===== WEBHOOK (MT5 / BOT) =====
app.post('/webhook/:sessionId', (req, res) => {
const { sessionId } = req.params;

const secret = process.env.WEBHOOK_SECRET;
if (secret && req.headers['x-webhook-secret'] !== secret) {
return res.status(401).json({ error: 'Unauthorized' });
}

if (!req.body || typeof req.body !== 'object') {
return res.status(400).json({ error: 'Invalid payload' });
}

const session = getSession(sessionId);

// 🚨 BLOQUER SI LOCK
if (session.locked) {
return res.status(403).json({
blocked: true,
reason: session.lockedReason || "Session locked"
});
}

const { symbol, action, price, quantity, sl, tp, ticket, comment } = req.body;

if (!symbol || !action) {
return res.status(400).json({ error: 'symbol et action requis' });
}

const dir =
action.toLowerCase().includes('buy') ||
action.toLowerCase().includes('long')
? 'long'
: 'short';

const trade = {
id: crypto.randomUUID(),
ticket: ticket ? String(ticket) : null,
symbol: symbol.toUpperCase(),
direction: dir,
price: safeNumber(price),
quantity: safeNumber(quantity, 1),
sl: safeNumber(sl),
tp: safeNumber(tp),
pnl: 0,
status: 'open',
plan: 'yes',
note: comment || '',
source: 'mt5',
timestamp: new Date().toISOString(),
time: new Date().toLocaleTimeString('fr-FR', {
hour: '2-digit',
minute: '2-digit'
})
};

session.trades.push(trade);

// ===== COACH DISCIPLINE =====
const lastClosed = session.trades
.filter(t => t.status === 'closed')
.slice(-3);

const losses = lastClosed.filter(t => t.pnl < 0).length;

if (losses >= 3) {
session.locked = true;
session.lockedReason = "3 pertes consécutives — Stop trading";

broadcast(sessionId, {
type: 'STATUS',
locked: true,
reason: session.lockedReason
});

console.log('[COACH] LOCK ACTIVÉ', sessionId);
}

broadcast(sessionId, {
type: 'NEW_TRADE',
trade
});

console.log(
'[MT5]',
sessionId,
trade.symbol,
trade.direction,
'@',
trade.price
);

res.json({
success: true,
tradeId: trade.id
});
});

// ===== CLOSE TRADE =====
app.post('/trade/:sessionId/:ticketOrId/close', (req, res) => {
const { sessionId, ticketOrId } = req.params;
const { pnl } = req.body;

const session = getSession(sessionId);

const trade = session.trades.find(t =>
t.ticket === ticketOrId || t.id === ticketOrId
);

if (!trade) {
return res.status(404).json({ error: 'Trade non trouve' });
}

trade.pnl = safeNumber(pnl);
trade.status = 'closed';
trade.closedAt = new Date().toISOString();

broadcast(sessionId, {
type: 'TRADE_CLOSED',
trade
});

console.log('[MT5 CLOSE]', trade.symbol, 'PnL=', trade.pnl);

res.json({
success: true,
trade
});
});

// ===== GET TRADES =====
app.get('/trades/:sessionId', (req, res) => {
res.json({
trades: getSession(req.params.sessionId).trades
});
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
res.json({
status: 'ok',
sessions: Object.keys(sessions).length,
uptime: Math.floor(process.uptime()) + 's',
timestamp: new Date().toISOString()
});
});

// ===== START =====
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
console.log('🚀 TradeCoach Backend lancé sur port', PORT);
});
