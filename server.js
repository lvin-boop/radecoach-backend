const express = require(‘express’);
const http = require(‘http’);
const WebSocket = require(‘ws’);
const cors = require(‘cors’);
const crypto = require(‘crypto’);

const fetch = global.fetch || require(‘node-fetch’);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAX_USERS = 30;

// ===== UTILS =====
function safeNumber(val, def = 0) {
const n = parseFloat(val);
return isNaN(n) ? def : n;
}

// ===== DATABASE =====
async function db(endpoint, method, body) {
if (!SUPABASE_URL || !SUPABASE_KEY) return null;
try {
const res = await fetch(SUPABASE_URL + ‘/rest/v1/’ + endpoint, {
method: method || ‘GET’,
headers: {
‘Content-Type’: ‘application/json’,
‘apikey’: SUPABASE_KEY,
‘Authorization’: ’Bearer ’ + SUPABASE_KEY,
‘Prefer’: method === ‘POST’ ? ‘return=representation’ : ‘’
},
body: body ? JSON.stringify(body) : undefined
});

```
if (!res.ok) {
console.log('DB error:', res.status, await res.text());
return null;
}

const text = await res.text();
return text ? JSON.parse(text) : null;
```

} catch (e) {
console.log(‘DB error:’, e.message);
return null;
}
}

// ===== DATA FUNCTIONS =====
async function saveTrade(sessionId, trade) {
return await db(‘trades’, ‘POST’, {
session_id: sessionId,
ticket: trade.ticket,
symbol: trade.symbol,
direction: trade.direction,
price: trade.price,
quantity: trade.quantity,
sl: trade.sl,
tp: trade.tp,
pnl: trade.pnl || 0,
status: trade.status || ‘open’,
plan: trade.plan || ‘yes’,
behaviour: trade.behaviour || ‘’,
note: trade.note || ‘’,
source: trade.source || ‘manual’,
trade_date: new Date().toISOString().split(‘T’)[0]
});
}

async function closeTrade(sessionId, ticketOrId, pnl) {
await db(
`trades?or=(ticket.eq.${ticketOrId},id.eq.${ticketOrId})&session_id=eq.${sessionId}`,
‘PATCH’,
{ pnl, status: ‘closed’ }
);
}

async function getTodayTrades(sessionId) {
const today = new Date().toISOString().split(‘T’)[0];
return await db(
`trades?session_id=eq.${sessionId}&trade_date=eq.${today}&order=created_at.asc`
);
}

// ===== SESSIONS =====
const sessions = {};
const clients = {};

function getSession(sessionId) {
if (!sessions[sessionId]) {
sessions[sessionId] = {
trades: [],
locked: false,
paused: false,
lockedReason: ‘’,
losses: 0,
date: new Date().toDateString()
};
}

const s = sessions[sessionId];

if (s.date !== new Date().toDateString()) {
s.trades = [];
s.locked = false;
s.paused = false;
s.lockedReason = ‘’;
s.losses = 0;
s.date = new Date().toDateString();
console.log(’[RESET]’, sessionId);
}

return s;
}

function broadcast(sessionId, payload) {
const room = clients[sessionId];
if (!room) return;

const msg = JSON.stringify(payload);
room.forEach(ws => {
if (ws.readyState === WebSocket.OPEN) ws.send(msg);
});
}

// ===== WEBSOCKET =====
wss.on(‘connection’, (ws, req) => {
const url = new URL(req.url, ‘http://localhost’);
const sessionId = url.searchParams.get(‘session’) || ‘default’;

if (!clients[sessionId]) clients[sessionId] = new Set();
clients[sessionId].add(ws);

const session = getSession(sessionId);

ws.send(JSON.stringify({
type: ‘INIT’,
trades: session.trades,
locked: session.locked
}));

ws.on(‘close’, () => clients[sessionId].delete(ws));
});

// ===== API =====

app.post(’/webhook/:sessionId’, (req, res) => {
const { sessionId } = req.params;

if (!req.body || typeof req.body !== ‘object’) {
return res.status(400).json({ error: ‘Invalid payload’ });
}

// LIMIT BETA USERS
if (!sessions[sessionId] && Object.keys(sessions).length >= MAX_USERS) {
return res.status(403).json({ error: ‘Beta full’ });
}

const session = getSession(sessionId);

if (session.locked) {
return res.status(403).json({
blocked: true,
reason: session.lockedReason
});
}

const { symbol, action, price, quantity, sl, tp } = req.body;

if (!symbol || !action) {
return res.status(400).json({ error: ‘symbol et action requis’ });
}

const direction =
action.toLowerCase().includes(‘buy’) ? ‘long’ : ‘short’;

const trade = {
id: crypto.randomUUID(),
symbol: symbol.toUpperCase(),
direction,
price: safeNumber(price),
quantity: safeNumber(quantity, 1),
sl: safeNumber(sl),
tp: safeNumber(tp),
pnl: 0,
status: ‘open’,
timestamp: new Date().toISOString()
};

session.trades.push(trade);

// ===== COACH DISCIPLINE =====

if (trade.pnl < 0) session.losses++;
else session.losses = 0;

if (session.losses >= 3) {
session.locked = true;
session.lockedReason = “3 pertes consécutives — Stop trading”;

```
broadcast(sessionId, {
type: 'STATUS',
locked: true,
reason: session.lockedReason
});

console.log('[COACH LOCK]', sessionId);
```

}

broadcast(sessionId, { type: ‘NEW_TRADE’, trade });

res.json({ success: true, trade });
});

// ===== HEALTH =====
app.get(’/health’, (req, res) => {
res.json({
status: ‘ok’,
sessions: Object.keys(sessions).length,
uptime: Math.floor(process.uptime()),
timestamp: new Date().toISOString()
});
});

// ===== START =====
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
console.log(‘🚀 TradeCoach Backend running on port’, PORT);
});
