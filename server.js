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

// ── STORAGE ────────────────────────────────────────────────────────────────
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
    sessions[sessionId] = { trades: [], startTime: Date.now(), active: true };
  }
  return sessions[sessionId];
}

// ── WEBSOCKET ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || 'default';
  if (!clients[sessionId]) clients[sessionId] = new Set();
  clients[sessionId].add(ws);
  console.log(`[WS] Connecté — session: ${sessionId}`);
  const session = getSession(sessionId);
  ws.send(JSON.stringify({ type: 'INIT', trades: session.trades }));
  ws.on('close', () => { clients[sessionId]?.delete(ws); });
  ws.on('message', (data) => {
    try { const msg = JSON.parse(data); if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' })); } catch (e) {}
  });
});

// ── WEBHOOK MT5 / TRADINGVIEW ──────────────────────────────────────────────
app.post('/webhook/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }
  const { symbol, action, price, quantity, comment, ticket } = req.body;
  if (!symbol || !action) return res.status(400).json({ error: 'symbol et action requis' });
  const dir = action.toLowerCase().includes('buy') || action.toLowerCase().includes('long') ? 'long' : 'short';
  const trade = {
    id: ticket ? String(ticket) : crypto.randomUUID(),
    symbol: symbol.toUpperCase(),
    direction: dir,
    price: parseFloat(price) || 0,
    quantity: parseFloat(quantity) || 1,
    pnl: 0,
    status: 'open',
    plan: 'yes',
    note: comment || '',
    source: 'mt5',
    timestamp: new Date().toISOString(),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  };
  const session = getSession(sessionId);
  // Évite les doublons
  if (!session.trades.find(t => t.id === trade.id)) {
    session.trades.push(trade);
    broadcast(sessionId, { type: 'NEW_TRADE', trade });
    console.log(`[MT5] Trade reçu — ${sessionId}: ${trade.symbol} ${trade.direction} @ ${trade.price}`);
  }
  res.json({ success: true, tradeId: trade.id });
});

// ── CLOSE TRADE ────────────────────────────────────────────────────────────
app.post('/trade/:sessionId/:tradeId/close', (req, res) => {
  const { sessionId, tradeId } = req.params;
  const { pnl, exitPrice } = req.body;
  const session = getSession(sessionId);
  const trade = session.trades.find(t => t.id === tradeId);
  if (!trade) return res.status(404).json({ error: 'Trade non trouvé' });
  trade.pnl = parseFloat(pnl) || 0;
  trade.exitPrice = parseFloat(exitPrice) || 0;
  trade.status = 'closed';
  trade.closedAt = new Date().toISOString();
  broadcast(sessionId, { type: 'TRADE_CLOSED', trade });
  res.json({ success: true, trade });
});

// ── COACH IA — ENDPOINT SÉCURISÉ ──────────────────────────────────────────
// La clé Anthropic reste côté serveur, jamais exposée au frontend
app.post('/coach', async (req, res) => {
  const { messages, system, max_tokens = 300, sessionId } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Clé API Anthropic non configurée' });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages requis' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens,
        system: system || 'Tu es un coach de trading psychologique. Réponds en 1-2 phrases max.',
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('[Coach] Erreur Anthropic:', err);
      return res.status(response.status).json({ error: err.error?.message || 'Erreur API' });
    }

    const data = await response.json();
    res.json({ content: data.content, usage: data.usage });

  } catch (err) {
    console.error('[Coach] Erreur:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── TRADES HISTORY ─────────────────────────────────────────────────────────
app.get('/trades/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  res.json({ trades: session.trades });
});

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: Object.keys(sessions).length,
    uptime: Math.floor(process.uptime()) + 's',
    coach: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing key'
  });
});

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   DisciplineAI Backend v2.0              ║
║   Port: ${PORT}                            ║
║   Coach IA: ${process.env.ANTHROPIC_API_KEY ? '✅ Configuré' : '❌ Clé manquante'}          ║
║   Webhook: POST /webhook/:sessionId      ║
║   Coach:   POST /coach                   ║
║   WS:      ws://...?session=ID           ║
╚══════════════════════════════════════════╝
  `);
});
