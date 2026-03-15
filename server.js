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
  room.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
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
  ws.on('close', () => clients[sessionId]?.delete(ws));
  ws.on('message', (data) => {
    try { const m = JSON.parse(data); if (m.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' })); } catch(e) {}
  });
});

app.post('/webhook/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) retur
