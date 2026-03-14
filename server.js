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

// ─── Simple in-memory storage (remplace par une DB en prod) ───────────────────
const sessions = {};     // sessionId -> { trades, rules, startTime }
const clients = {};      // sessionId -> Set<WebSocket>

// ─── Utilitaires ──────────────────────────────────────────────────────────────
function broadcast(sessionId, payload) {
  const room = clients[sessionId];
  if (!room) return;
  const msg = JSON.stringify(payload);
  room.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { trades: [], startTime: Date.now(), active: true };
  }
  return sessions[sessionId];
}

// ─── WebSocket : gestion des clients TradeCoach ───────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || 'default';

  if (!clients[sessionId]) clients[sessionId] = new Set();
  clients[sessionId].add(ws);

  console.log(`[WS] Client connecté — session: ${sessionId}`);

  // Envoie l'historique des trades dès la connexion
  const session = getSession(sessionId);
  ws.send(JSON.stringify({ type: 'INIT', trades: session.trades }));

  ws.on('close', () => {
    clients[sessionId]?.delete(ws);
    console.log(`[WS] Client déconnecté — session: ${sessionId}`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
    } catch (e) {}
  });
});

// ─── ENDPOINT WEBHOOK TradingView ─────────────────────────────────────────────
// Configure dans TradingView :
//   URL : https://TON-BACKEND.railway.app/webhook/VOTRE_SESSION_ID
//   Méthode : POST
//   Corps (JSON) :
//   {
//     "symbol": "{{ticker}}",
//     "action": "{{strategy.order.action}}",
//     "price": {{close}},
//     "quantity": {{strategy.order.contracts}},
//     "comment": "{{strategy.order.comment}}"
//   }

app.post('/webhook/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const secret = process.env.WEBHOOK_SECRET;

  // Vérification optionnelle d'un secret partagé
  if (secret) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { symbol, action, price, quantity, comment, strategy } = req.body;

  if (!symbol || !action) {
    return res.status(400).json({ error: 'symbol et action sont requis' });
  }

  // Normalise la direction
  const dir = action.toLowerCase().includes('buy') ||
              action.toLowerCase().includes('long') ? 'long' : 'short';

  const trade = {
    id: crypto.randomUUID(),
    symbol: symbol.toUpperCase(),
    direction: dir,
    price: parseFloat(price) || 0,
    quantity: parseFloat(quantity) || 1,
    pnl: 0,            // sera mis à jour à la clôture
    status: 'open',    // open | closed
    plan: 'yes',       // TradingView = trade planifié par défaut
    note: comment || strategy || '',
    source: 'tradingview',
    timestamp: new Date().toISOString(),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  };

  const session = getSession(sessionId);
  session.trades.push(trade);

  // Pousse le trade en temps réel à tous les clients connectés
  broadcast(sessionId, { type: 'NEW_TRADE', trade });

  console.log(`[TV] Trade reçu — ${sessionId}: ${trade.symbol} ${trade.direction} @ ${trade.price}`);
  res.json({ success: true, tradeId: trade.id });
});

// ─── ENDPOINT : Clôture d'un trade (P&L) ─────────────────────────────────────
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

// ─── ENDPOINT : Historique des trades ────────────────────────────────────────
app.get('/trades/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  res.json({ trades: session.trades });
});

// ─── ENDPOINT : Santé du serveur ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: Object.keys(sessions).length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   TradeCoach Backend — v1.0              ║
║   Écoute sur le port ${PORT}               ║
║                                          ║
║   Webhook TV : POST /webhook/:sessionId  ║
║   WebSocket  : ws://...?session=ID       ║
║   Health     : GET /health               ║
╚══════════════════════════════════════════╝
  `);
});
