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

const sessions = {};
const clients = {};

function broadcast(sessionId, payload) {
const room = clients[sessionId];
if (!room) return;
const msg = JSON.stringify(payload);
room.forEach(ws => {
if (ws.readyState === WebSocket.OPEN) ws.send(msg);
});
}

function getSession(sessionId) {
if (!sessions[sessionId]) sessions[sessionId] = { trades: [] };
return sessions[sessionId];
}

wss.on('connection', (ws, req) => {
const url = new URL(req.url, 'http://localhost');
const sessionId = url.searchParams.get('session') || 'default';
if (!clients[sessionId]) clients[sessionId] = new Set();
clients[sessionId].add(ws);
const session = getSession(sessionId);
ws.send(JSON.stringify({ type: 'INIT', trades: session.trades }));
ws.on('close', () => clients[sessionId] && clients[sessionId].delete(ws));
ws.on('message', (data) => {
try {
const m = JSON.parse(data);
if (m.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
} catch(e) {}
});
});

app.post('/webhook/:sessionId', (req, res) => {
const { sessionId } = req.params;
const secret = process.env.WEBHOOK_SECRET;
if (secret && req.headers['x-webhook-secret'] !== secret) {
return res.status(401).json({ error: 'Unauthorized' });
}
const { symbol, action, price, quantity, sl, tp, ticket, comment } = req.body;
if (!symbol || !action) return res.status(400).json({ error: 'symbol et action requis' });
const dir = (action.toLowerCase().includes('buy') || action.toLowerCase().includes('long')) ? 'long' : 'short';
const trade = {
id: crypto.randomUUID(),
ticket: ticket ? String(ticket) : null,
symbol: symbol.toUpperCase(),
direction: dir,
price: parseFloat(price) || 0,
quantity: parseFloat(quantity) || 1,
sl: parseFloat(sl) || 0,
tp: parseFloat(tp) || 0,
pnl: 0,
status: 'open',
plan: 'yes',
note: comment || '',
source: 'mt5',
timestamp: new Date().toISOString(),
time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
};
getSession(sessionId).trades.push(trade);
broadcast(sessionId, { type: 'NEW_TRADE', trade });
console.log('[MT5] ' + sessionId + ': ' + trade.symbol + ' ' + trade.direction + ' @ ' + trade.price);
res.json({ success: true, tradeId: trade.id });
});

app.post('/trade/:sessionId/:ticketOrId/close', (req, res) => {
const { sessionId, ticketOrId } = req.params;
const { pnl } = req.body;
const session = getSession(sessionId);
const trade = session.trades.find(function(t) {
return t.ticket === ticketOrId || t.id === ticketOrId;
});
if (!trade) return res.status(404).json({ error: 'Trade non trouve' });
trade.pnl = parseFloat(pnl) || 0;
trade.status = 'closed';
trade.closedAt = new Date().toISOString();
broadcast(sessionId, { type: 'TRADE_CLOSED', trade });
console.log('[MT5] Cloture: ' + trade.symbol + ' PnL=' + trade.pnl);
res.json({ success: true, trade });
});

app.get('/trades/:sessionId', (req, res) => {
res.json({ trades: getSession(req.params.sessionId).trades });
});

app.get('/health', (req, res) => {
res.json({ status: 'ok', sessions: Object.keys(sessions).length, uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
console.log('TradeCoach Backend en ligne sur le port ' + PORT);
});
