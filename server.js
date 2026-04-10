<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>TradeCoach</title>

<style>
body {
margin: 0;
background: #0B0B0F;
font-family: 'Inter', sans-serif;
color: white;
}

/* ===== HEADER ===== */
.top-bar {
display: flex;
justify-content: center;
padding: 20px;
}

/* ===== GLASS CARD ===== */
.balance-box {
display: flex;
gap: 40px;
padding: 18px 30px;
border-radius: 16px;
background: rgba(255,255,255,0.04);
backdrop-filter: blur(20px);
border: 1px solid rgba(255,255,255,0.08);
box-shadow: 0 0 30px rgba(120, 80, 255, 0.15);
animation: fadeUp 0.8s ease;
}

/* ===== ITEMS ===== */
.balance-item {
display: flex;
flex-direction: column;
}

.balance-label {
font-size: 12px;
color: #888;
}

.balance-value {
font-size: 20px;
font-weight: 600;
margin-top: 4px;
transition: 0.3s;
}

/* ===== COLORS ===== */
.positive {
color: #00ff88;
}

.negative {
color: #ff4d4d;
}

/* ===== ANIMATIONS ===== */
@keyframes fadeUp {
from {
opacity: 0;
transform: translateY(10px);
}
to {
opacity: 1;
transform: translateY(0);
}
}

.glow {
animation: glowAnim 1.5s infinite alternate;
}

@keyframes glowAnim {
from {
text-shadow: 0 0 5px rgba(120,80,255,0.2);
}
to {
text-shadow: 0 0 15px rgba(120,80,255,0.6);
}
}
</style>
</head>

<body>

<div class="top-bar">
<div class="balance-box">
<div class="balance-item">
<div class="balance-label">Capital</div>
<div id="capital" class="balance-value">--</div>
</div>

<div class="balance-item">
<div class="balance-label">PnL</div>
<div id="pnl" class="balance-value">--</div>
</div>

<div class="balance-item">
<div class="balance-label">Equity</div>
<div id="equity" class="balance-value">--</div>
</div>
</div>
</div>

<script>
// ===== CONFIG =====

// fallback si MT5 pas connecté
let startingBalance = 50000;

// ===== STATE =====
let trades = [];
let mt5Balance = null;

// ===== FETCH TRADES =====
async function loadTrades() {
try {
const res = await fetch('/trades/default');
const data = await res.json();
trades = data.trades || [];
updateUI();
} catch (e) {
console.log('Erreur trades');
}
}

// ===== FETCH MT5 BALANCE (SI CONNECTÉ) =====
async function loadMT5Balance() {
try {
const res = await fetch('/mt5/balance'); // à créer si tu veux auto réel
const data = await res.json();

if (data.balance) {
mt5Balance = data.balance;
}
} catch (e) {
console.log('MT5 non connecté');
}
}

// ===== CALCUL =====
function calculate() {
const pnl = trades.reduce((acc, t) => acc + (t.pnl || 0), 0);

const capital = mt5Balance !== null ? mt5Balance : startingBalance;

const equity = capital + pnl;

return { capital, pnl, equity };
}

// ===== UI UPDATE =====
function updateUI() {
const { capital, pnl, equity } = calculate();

const pnlEl = document.getElementById('pnl');
const equityEl = document.getElementById('equity');

document.getElementById('capital').innerText = capital.toFixed(2) + ' $';
pnlEl.innerText = pnl.toFixed(2) + ' $';
equityEl.innerText = equity.toFixed(2) + ' $';

pnlEl.className = 'balance-value ' + (pnl >= 0 ? 'positive glow' : 'negative');
equityEl.className = 'balance-value ' + (equity >= capital ? 'positive' : 'negative');
}

// ===== AUTO REFRESH =====
setInterval(() => {
loadTrades();
loadMT5Balance();
}, 2000);

// INIT
loadTrades();
loadMT5Balance();
</script>

</body>
</html>
