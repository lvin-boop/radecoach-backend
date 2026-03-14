# TradeCoach Backend — Guide de déploiement

## 1. Déployer sur Railway (gratuit, 5 min)

### Étapes
1. Va sur https://railway.app et crée un compte (GitHub recommandé)
2. Clique **"New Project"** → **"Deploy from GitHub repo"**
3. Upload ou push ce dossier sur GitHub
4. Railway détecte automatiquement Node.js et déploie
5. Dans **Settings > Variables**, ajoute :
   ```
   WEBHOOK_SECRET=un_mot_de_passe_secret_ici
   PORT=3001
   ```
6. Ton URL sera : `https://tradecoach-backend-XXXXX.railway.app`

---

## 2. Configurer l'alerte dans TradingView

### Dans TradingView (version gratuite ou Pro)
1. Sur ton graphique, clique l'icône **horloge** → **"Create Alert"**
2. Configure ta condition (ex: EMA cross, RSI, prix...)
3. Dans l'onglet **"Notifications"**, active **"Webhook URL"**
4. Colle l'URL :
   ```
   https://TON-BACKEND.railway.app/webhook/MON_SESSION_ID
   ```
   > Remplace `MON_SESSION_ID` par n'importe quel identifiant (ex: `trader_alex`)

5. Dans **"Message"**, colle ce JSON :
   ```json
   {
     "symbol": "{{ticker}}",
     "action": "{{strategy.order.action}}",
     "price": {{close}},
     "quantity": 1,
     "comment": "Alerte {{interval}} - {{strategy.order.comment}}"
   }
   ```
6. Dans les **headers** de la requête, ajoute :
   ```
   x-webhook-secret: un_mot_de_passe_secret_ici
   ```

### Pour une stratégie Pine Script
```pine
//@version=5
strategy("Ma Stratégie TradeCoach", overlay=true)

// Ta logique ici...
longCondition = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))
shortCondition = ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))

if longCondition
    strategy.entry("Long", strategy.long)
    alert('{"symbol":"' + syminfo.ticker + '","action":"buy","price":' + str.tostring(close) + ',"quantity":1,"comment":"EMA Cross Long"}', alert.freq_once_per_bar)

if shortCondition
    strategy.entry("Short", strategy.short)
    alert('{"symbol":"' + syminfo.ticker + '","action":"sell","price":' + str.tostring(close) + ',"quantity":1,"comment":"EMA Cross Short"}', alert.freq_once_per_bar)
```

---

## 3. Connecter TradeCoach à ton backend

Dans l'app TradeCoach, remplace la connexion manuelle par :
```javascript
const ws = new WebSocket('wss://TON-BACKEND.railway.app?session=MON_SESSION_ID');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === 'INIT') {
    // Charge l'historique des trades
    msg.trades.forEach(trade => addTrade(trade));
  }
  
  if (msg.type === 'NEW_TRADE') {
    // Trade reçu depuis TradingView !
    addTrade(msg.trade);
    // Le coach IA réagit automatiquement
    autoCoach(msg.trade);
  }
  
  if (msg.type === 'TRADE_CLOSED') {
    updateTradePnl(msg.trade);
  }
};
```

---

## 4. Tester en local

```bash
# Installe les dépendances
npm install

# Lance le serveur
npm run dev

# Test du webhook (dans un autre terminal)
curl -X POST http://localhost:3001/webhook/test-session \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSD","action":"buy","price":67450,"quantity":0.1,"comment":"Test EMA"}'

# Vérifie la santé
curl http://localhost:3001/health
```

---

## 5. Architecture finale

```
TradingView Alert
      │
      │  POST /webhook/:sessionId
      │  (JSON + secret header)
      ▼
Railway Backend (Node.js)
      │
      ├── Valide & stocke le trade
      │
      │  WebSocket broadcast
      ▼
TradeCoach App (navigateur)
      │
      ├── Affiche le trade en temps réel
      └── Coach IA analyse & réagit
```

---

## Variables d'environnement

| Variable | Description | Exemple |
|---|---|---|
| `PORT` | Port d'écoute | `3001` |
| `WEBHOOK_SECRET` | Clé secrète partagée avec TV | `monSecretTV2024` |

---

## Endpoints disponibles

| Méthode | URL | Description |
|---|---|---|
| `POST` | `/webhook/:sessionId` | Reçoit un trade depuis TradingView |
| `POST` | `/trade/:sessionId/:tradeId/close` | Clôture un trade avec P&L |
| `GET` | `/trades/:sessionId` | Historique des trades |
| `GET` | `/health` | Santé du serveur |
| `WS` | `/?session=:sessionId` | Connexion temps réel |
