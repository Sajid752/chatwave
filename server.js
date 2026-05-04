// ==================== server.js ====================
// First page: gender buttons (reliable click)
// Second page: full chat + Tic‑Tac‑Toe + payment modal (transaction ID)
// Admin dashboard with modern design

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';

app.use(cors());
app.use(express.json());

// ---------- Persistent storage ----------
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
let payments = [];
if (fs.existsSync(PAYMENTS_FILE)) {
  try {
    payments = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
  } catch(e) { console.error('Error reading payments.json', e); }
}
function savePayment(payment) {
  payments.push(payment);
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
}

const TXN_FILE = path.join(__dirname, 'transactions.json');
let usedTransactions = new Set();
if (fs.existsSync(TXN_FILE)) {
  try {
    const arr = JSON.parse(fs.readFileSync(TXN_FILE, 'utf8'));
    usedTransactions = new Set(arr);
  } catch(e) {}
}
function saveTransaction(txnId) {
  usedTransactions.add(txnId);
  fs.writeFileSync(TXN_FILE, JSON.stringify([...usedTransactions], null, 2));
}

// ---------- In‑memory stores (real‑time chat & game) ----------
const activeSessions = new Map();
const userPremiums = new Map();        // sessionId -> expiry timestamp
const userGender = new Map();
const waitingQueue = [];
const activeChats = new Map();         // sessionId -> { partnerSessionId, roomId }
const chatMessages = new Map();        // roomId -> array of messages
const chatEnded = new Map();
const userPreferredGender = new Map();
const typingStatus = new Map();
const lastPartner = new Map();
let totalMatches = 0;
const gameRooms = new Map();

function isPremiumActive(sessionId) {
  const expiry = userPremiums.get(sessionId);
  return expiry && expiry > Date.now();
}

function createRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function removeFromQueue(sessionId) {
  const idx = waitingQueue.indexOf(sessionId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function getActiveUserCount() {
  const now = Date.now();
  let count = 0;
  for (let [id, time] of activeSessions.entries()) {
    if (now - time < 60000) count++;
  }
  return count;
}

function getRematchCooldown() {
  const active = getActiveUserCount();
  if (active > 20) return 120000;
  if (active >= 10) return 60000;
  return 30000;
}

function tryMatchRealUsers() {
  if (waitingQueue.length < 2) return false;
  const userA = waitingQueue.shift();
  const userB = waitingQueue.shift();
  if (!userA || !userB) return false;

  const cooldown = getRematchCooldown();
  const lastA = lastPartner.get(userA);
  const lastB = lastPartner.get(userB);
  if (lastA && lastA.partnerId === userB && (Date.now() - lastA.timestamp) < cooldown) {
    waitingQueue.push(userA);
    waitingQueue.push(userB);
    return false;
  }
  if (lastB && lastB.partnerId === userA && (Date.now() - lastB.timestamp) < cooldown) {
    waitingQueue.push(userA);
    waitingQueue.push(userB);
    return false;
  }

  const roomId = createRoomId();
  activeChats.set(userA, { partnerSessionId: userB, roomId });
  activeChats.set(userB, { partnerSessionId: userA, roomId });
  chatMessages.set(roomId, []);
  chatEnded.set(roomId, false);
  totalMatches++;
  return true;
}

// ---------- Game helpers ----------
function checkWinner(board) {
  const winPatterns = [
    [0,1,2], [3,4,5], [6,7,8],
    [0,3,6], [1,4,7], [2,5,8],
    [0,4,8], [2,4,6]
  ];
  for (let pattern of winPatterns) {
    const [a,b,c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}
function isDraw(board) { return board.every(cell => cell !== ''); }

function broadcastGameState(roomId) {
  const game = gameRooms.get(roomId);
  if (!game) return;
  const stateMessage = JSON.stringify({
    type: 'game_state',
    board: game.board,
    currentPlayer: game.currentPlayer,
    gameActive: game.gameActive,
    winner: game.winner || null,
    playerX: game.playerX,
    playerO: game.playerO
  });
  const messages = chatMessages.get(roomId) || [];
  messages.push({ from: 'game', text: stateMessage, timestamp: Date.now() });
  chatMessages.set(roomId, messages);
}

function resetGame(roomId) {
  const game = gameRooms.get(roomId);
  if (!game) return;
  game.board = Array(9).fill('');
  game.currentPlayer = 'X';
  game.gameActive = true;
  game.winner = null;
  game.requestPending = false;
  game.requestFrom = null;
  broadcastGameState(roomId);
}

function handleGameMove(roomId, sessionId, cellIndex) {
  const game = gameRooms.get(roomId);
  if (!game || !game.gameActive) return false;
  const isPlayerX = (game.playerX === sessionId);
  const isPlayerO = (game.playerO === sessionId);
  if (isPlayerX && game.currentPlayer !== 'X') return false;
  if (isPlayerO && game.currentPlayer !== 'O') return false;
  if (game.board[cellIndex] !== '') return false;

  game.board[cellIndex] = game.currentPlayer;
  const winner = checkWinner(game.board);
  if (winner) {
    game.gameActive = false;
    game.winner = winner;
    const winnerSession = (winner === 'X') ? game.playerX : game.playerO;
    const loserSession = (winner === 'X') ? game.playerO : game.playerX;
    const messages = chatMessages.get(roomId) || [];
    messages.push({ from: 'system', text: '🏆 You won! 🏆', timestamp: Date.now(), target: winnerSession });
    messages.push({ from: 'system', text: '😔 You lost.', timestamp: Date.now(), target: loserSession });
    messages.push({ from: 'system', text: '🔄 Click "Play Again" to request a rematch.', timestamp: Date.now(), actions: ['play_again'] });
    chatMessages.set(roomId, messages);
  } else if (isDraw(game.board)) {
    game.gameActive = false;
    const messages = chatMessages.get(roomId) || [];
    messages.push({ from: 'system', text: '🤝 Draw!', timestamp: Date.now() });
    messages.push({ from: 'system', text: '🔄 Click "Play Again" to request a rematch.', timestamp: Date.now(), actions: ['play_again'] });
    chatMessages.set(roomId, messages);
  } else {
    game.currentPlayer = (game.currentPlayer === 'X') ? 'O' : 'X';
  }
  broadcastGameState(roomId);
  return true;
}

// ---------- API routes (transaction‑ID payment) ----------
app.post('/api/verify-payment', (req, res) => {
  const { sessionId, transactionId } = req.body;
  if (!transactionId || transactionId.trim().length < 5) {
    return res.json({ success: false, message: 'Enter valid transaction ID (min 5 characters).' });
  }
  if (usedTransactions.has(transactionId)) {
    return res.json({ success: false, message: 'This transaction ID has already been used.' });
  }
  saveTransaction(transactionId);
  const currentExpiry = userPremiums.get(sessionId) || 0;
  const newExpiry = Math.max(currentExpiry, Date.now()) + 10 * 60 * 1000;
  userPremiums.set(sessionId, newExpiry);
  savePayment({
    id: 'txn_' + Date.now(),
    transactionId,
    amount: 2,
    sessionId,
    timestamp: Date.now(),
    date: new Date().toISOString()
  });
  res.json({ success: true, message: '✅ Premium activated for 10 minutes.' });
});

app.post('/api/check-premium', (req, res) => {
  const { sessionId } = req.body;
  const expiry = userPremiums.get(sessionId);
  const hasPremium = expiry && expiry > Date.now();
  res.json({ success: true, hasPremium, expiry });
});

app.get('/api/active-users', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) activeSessions.set(sessionId, Date.now());
  const realCount = getActiveUserCount();
  res.json({ success: true, count: realCount });
});

app.post('/api/find-match', (req, res) => {
  const { prefer, sessionId, userGender: gender } = req.body;
  userPreferredGender.set(sessionId, prefer);
  if (gender) userGender.set(sessionId, gender);
  const myGender = userGender.get(sessionId);
  const hasPrem = isPremiumActive(sessionId);
  if (myGender === 'male' && prefer === 'female' && !hasPrem) {
    return res.json({ success: false, message: "You need to pay ₹2 to chat with females." });
  }

  const existingChat = activeChats.get(sessionId);
  if (existingChat && existingChat.partnerSessionId) {
    const roomEnded = chatEnded.get(existingChat.roomId);
    if (roomEnded) {
      activeChats.delete(sessionId);
      gameRooms.delete(existingChat.roomId);
    } else {
      const partnerId = existingChat.partnerSessionId;
      const partnerPref = userPreferredGender.get(partnerId) || 'any';
      const partnerActualGender = userGender.get(partnerId) || 'unknown';
      return res.json({
        success: true,
        partner: { name: 'Stranger', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }

  removeFromQueue(sessionId);
  waitingQueue.push(sessionId);
  const matched = tryMatchRealUsers();
  if (matched) {
    const chat = activeChats.get(sessionId);
    if (chat && chat.partnerSessionId) {
      const partnerId = chat.partnerSessionId;
      const partnerPref = userPreferredGender.get(partnerId) || 'any';
      const partnerActualGender = userGender.get(partnerId) || 'unknown';
      const roomId = chat.roomId;
      gameRooms.set(roomId, {
        board: Array(9).fill(''),
        currentPlayer: 'X',
        playerX: sessionId,
        playerO: partnerId,
        gameActive: false,
        winner: null,
        requestPending: false,
        requestFrom: null
      });
      return res.json({
        success: true,
        partner: { name: 'Stranger', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }
  return res.json({ success: false, message: "No strangers online. Try again." });
});

app.post('/api/send-message', (req, res) => {
  const { sessionId, text } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.status(400).json({ success: false, message: 'No active chat' });
  const roomId = chat.roomId;
  if (chatEnded.get(roomId)) return res.status(400).json({ success: false, message: 'Chat ended' });

  if (text.startsWith('{') && text.includes('game_')) {
    try {
      const data = JSON.parse(text);
      if (data.type === 'game_request') {
        const game = gameRooms.get(roomId);
        if (game && !game.gameActive && !game.requestPending) {
          game.requestPending = true;
          game.requestFrom = sessionId;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 Stranger wants to play Tic‑Tac‑Toe. Accept?', timestamp: Date.now(), target: chat.partnerSessionId, actions: ['accept_game', 'decline_game'] });
          chatMessages.set(roomId, messages);
        }
      } else if (data.type === 'game_accept') {
        const game = gameRooms.get(roomId);
        if (game && game.requestPending && game.requestFrom === chat.partnerSessionId) {
          resetGame(roomId);
          game.requestPending = false;
          game.requestFrom = null;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 Game accepted! X starts.', timestamp: Date.now() });
          chatMessages.set(roomId, messages);
          broadcastGameState(roomId);
        }
      } else if (data.type === 'game_decline') {
        const game = gameRooms.get(roomId);
        if (game && game.requestPending && game.requestFrom === chat.partnerSessionId) {
          game.requestPending = false;
          game.requestFrom = null;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '❌ Stranger declined to play.', timestamp: Date.now(), target: game.requestFrom });
          chatMessages.set(roomId, messages);
        }
      } else if (data.type === 'game_move') {
        handleGameMove(roomId, sessionId, data.index);
      } else if (data.type === 'play_again') {
        const game = gameRooms.get(roomId);
        if (game && !game.gameActive && !game.requestPending) {
          game.requestPending = true;
          game.requestFrom = sessionId;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 Stranger wants a rematch. Accept?', timestamp: Date.now(), target: chat.partnerSessionId, actions: ['accept_game', 'decline_game'] });
          chatMessages.set(roomId, messages);
          messages.push({ from: 'system', text: '✅ Rematch request sent.', timestamp: Date.now(), target: sessionId });
          chatMessages.set(roomId, messages);
        }
      }
    } catch(e) {}
  } else {
    const messages = chatMessages.get(roomId) || [];
    messages.push({ from: sessionId, text, timestamp: Date.now() });
    chatMessages.set(roomId, messages);
  }
  res.json({ success: true });
});

// Typing and message polling (unchanged)
app.post('/api/typing', (req, res) => {
  const { sessionId, isTyping } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ success: false });
  const roomId = chat.roomId;
  if (isTyping) typingStatus.set(roomId, { userId: sessionId, timestamp: Date.now() });
  else {
    const current = typingStatus.get(roomId);
    if (current && current.userId === sessionId) typingStatus.delete(roomId);
  }
  res.json({ success: true });
});

app.post('/api/get-typing', (req, res) => {
  const { sessionId } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ isTyping: false });
  const roomId = chat.roomId;
  const typing = typingStatus.get(roomId);
  if (typing && typing.userId !== sessionId && (Date.now() - typing.timestamp) < 2500) return res.json({ isTyping: true });
  res.json({ isTyping: false });
});

app.post('/api/get-messages', (req, res) => {
  const { sessionId, lastTimestamp } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ success: true, messages: [], chatEnded: true });
  const roomId = chat.roomId;
  const ended = chatEnded.get(roomId) || false;
  if (ended) {
    activeChats.delete(sessionId);
    gameRooms.delete(roomId);
    return res.json({ success: true, messages: [], chatEnded: true });
  }
  const messages = chatMessages.get(roomId) || [];
  const newMessages = messages.filter(m => m.timestamp > (lastTimestamp || 0));
  const filtered = newMessages.filter(m => {
    if (m.target && m.target !== sessionId) return false;
    if (m.from !== sessionId) return true;
    return false;
  });
  res.json({ success: true, messages: filtered, chatEnded: false });
});

app.post('/api/skip-chat', async (req, res) => {
  const { sessionId } = req.body;
  const chat = activeChats.get(sessionId);
  if (chat) {
    const roomId = chat.roomId;
    chatEnded.set(roomId, true);
    if (chat.partnerSessionId) {
      const partnerChat = activeChats.get(chat.partnerSessionId);
      if (partnerChat) activeChats.delete(chat.partnerSessionId);
    }
    activeChats.delete(sessionId);
    gameRooms.delete(roomId);
    setTimeout(() => {
      chatMessages.delete(roomId);
      chatEnded.delete(roomId);
      typingStatus.delete(roomId);
    }, 60000);
  }
  removeFromQueue(sessionId);
  waitingQueue.push(sessionId);
  const matched = tryMatchRealUsers();
  if (matched) {
    const newChat = activeChats.get(sessionId);
    if (newChat && newChat.partnerSessionId) {
      const partnerId = newChat.partnerSessionId;
      const partnerPref = userPreferredGender.get(partnerId) || 'any';
      const partnerActualGender = userGender.get(partnerId) || 'unknown';
      const roomId = newChat.roomId;
      gameRooms.set(roomId, {
        board: Array(9).fill(''),
        currentPlayer: 'X',
        playerX: sessionId,
        playerO: partnerId,
        gameActive: false,
        winner: null,
        requestPending: false,
        requestFrom: null
      });
      return res.json({
        success: true,
        partner: { name: 'Stranger', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }
  res.json({ success: false, message: "No new stranger right now." });
});

app.post('/api/end-chat', (req, res) => {
  const { sessionId } = req.body;
  const chat = activeChats.get(sessionId);
  if (chat) {
    const roomId = chat.roomId;
    chatEnded.set(roomId, true);
    if (chat.partnerSessionId) {
      const partnerId = chat.partnerSessionId;
      const partnerChat = activeChats.get(partnerId);
      if (partnerChat) activeChats.delete(partnerId);
      lastPartner.set(sessionId, { partnerId, timestamp: Date.now() });
      lastPartner.set(partnerId, { partnerId: sessionId, timestamp: Date.now() });
    }
    activeChats.delete(sessionId);
    gameRooms.delete(roomId);
    setTimeout(() => {
      chatMessages.delete(roomId);
      chatEnded.delete(roomId);
      typingStatus.delete(roomId);
    }, 60000);
  }
  removeFromQueue(sessionId);
  res.json({ success: true });
});

// ---------- Admin API (modern dashboard) ----------
function adminAuth(req, res, next) {
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const activeUsers = getActiveUserCount();
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalPayments = payments.length;
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(); date.setDate(date.getDate() - i);
    const dayStr = date.toISOString().split('T')[0];
    const dayPayments = payments.filter(p => p.date.split('T')[0] === dayStr);
    last7Days.push({ date: dayStr, count: dayPayments.length, amount: dayPayments.reduce((s, p) => s + p.amount, 0) });
  }
  res.json({ success: true, activeUsers, totalMatches, totalRevenue, totalPayments, last7Days, recentPayments: payments.slice(-10).reverse() });
});
app.get('/admin', (req, res) => {
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) return res.status(401).send('Unauthorized');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatWave Admin</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background: #0a0c10; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; color: #e2e8f0; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { font-size: 2rem; font-weight: 600; margin-bottom: 8px; background: linear-gradient(135deg, #c084fc, #60a5fa); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .subtitle { color: #94a3b8; margin-bottom: 32px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 32px; }
        .stat-card { background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(8px); border-radius: 24px; padding: 24px; border: 1px solid #334155; }
        .stat-title { font-size: 0.875rem; font-weight: 500; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .stat-value { font-size: 2.5rem; font-weight: 700; color: #f1f5f9; }
        .chart-card { background: rgba(15, 23, 42, 0.8); border-radius: 24px; padding: 24px; margin-bottom: 32px; border: 1px solid #334155; }
        .chart-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 20px; color: #cbd5e1; }
        canvas { max-height: 300px; width: 100%; }
        .table-container { background: rgba(15, 23, 42, 0.8); border-radius: 24px; overflow: auto; border: 1px solid #334155; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 16px 20px; background: #1e293b; color: #cbd5e1; font-weight: 600; border-bottom: 1px solid #334155; }
        td { padding: 12px 20px; color: #e2e8f0; border-bottom: 1px solid #1e293b; }
        tr:hover { background: #1e293b; }
        .badge { background: #3b82f6; border-radius: 40px; padding: 4px 12px; font-size: 0.75rem; font-weight: 500; }
        .refresh-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 40px; font-weight: 500; cursor: pointer; margin-bottom: 24px; transition: 0.2s; }
        .refresh-btn:hover { background: #2563eb; }
        footer { text-align: center; margin-top: 32px; color: #64748b; font-size: 0.75rem; }
    </style>
</head>
<body>
<div class="container">
    <h1>ChatWave • Admin</h1>
    <div class="subtitle">Real‑time analytics & payment logs</div>
    <button class="refresh-btn" onclick="loadData()">⟳ Refresh</button>
    <div class="stats-grid" id="statsGrid"></div>
    <div class="chart-card">
        <div class="chart-title">📊 Daily Revenue (last 7 days)</div>
        <canvas id="dailyChart"></canvas>
    </div>
    <div class="chart-card">
        <div class="chart-title">💳 Recent Payments</div>
        <div class="table-container">
            <table id="paymentsTable">
                <thead><tr><th>Transaction ID</th><th>Amount</th><th>Date & Time</th><th>Session</th><th>Status</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    </div>
    <footer>© ChatWave — anonymous chat platform</footer>
</div>
<script>
    const base = '/api/admin/stats?key=${key}';
    async function loadData() {
        const res = await fetch(base);
        const data = await res.json();
        if (!data.success) return;
        document.getElementById('statsGrid').innerHTML = \`
            <div class="stat-card"><div class="stat-title">👥 Active Users</div><div class="stat-value">\${data.activeUsers}</div></div>
            <div class="stat-card"><div class="stat-title">💬 Total Matches</div><div class="stat-value">\${data.totalMatches}</div></div>
            <div class="stat-card"><div class="stat-title">💰 Revenue (₹)</div><div class="stat-value">₹\${data.totalRevenue}</div></div>
            <div class="stat-card"><div class="stat-title">💳 Payments</div><div class="stat-value">\${data.totalPayments}</div></div>
        \`;
        const tbody = document.querySelector('#paymentsTable tbody');
        tbody.innerHTML = data.recentPayments.map(p => \`
            <tr>
                <td><span class="badge">\${p.transactionId || p.id}</span></td>
                <td>₹\${p.amount}</td>
                <td>\${new Date(p.timestamp).toLocaleString()}</td>
                <td>\${p.sessionId.substring(0,12)}...</td>
                <td><span style="color:#10b981;">✓ Completed</span></td>
            </tr>
        \`).join('');
        const ctx = document.getElementById('dailyChart').getContext('2d');
        if (window.dailyChart) window.dailyChart.destroy();
        window.dailyChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.last7Days.map(d => d.date),
                datasets: [{ label: 'Revenue (₹)', data: data.last7Days.map(d => d.amount), backgroundColor: '#3b82f6', borderRadius: 8 }]
            },
            options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'top' } } }
        });
    }
    loadData();
    setInterval(loadData, 30000);
</script>
</body>
</html>`);
});

// ------------------- FRONTEND (first page with gender buttons, second page with full chat + transaction ID) -------------------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>ChatWave · Anonymous Chat</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Inter', sans-serif; background: #0a0c10; color: #e2e8f0; }
        .loading-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; z-index:10000; visibility:hidden; opacity:0; transition:0.2s; }
        .loading-overlay.active { visibility:visible; opacity:1; }
        .spinner { width:50px; height:50px; border:4px solid #334155; border-top-color:#3b82f6; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); backdrop-filter:blur(12px); display:flex; align-items:center; justify-content:center; z-index:20000; visibility:hidden; opacity:0; transition:0.2s; }
        .modal-overlay.active { visibility:visible; opacity:1; }
        .payment-modal { background: #1e293b; border-radius:32px; max-width:400px; width:90%; padding:28px 24px; text-align:center; border:1px solid #334155; box-shadow:0 25px 50px -12px rgba(0,0,0,0.5); }
        .payment-modal h3 { font-size:1.6rem; margin-bottom:8px; color:white; }
        .qr-placeholder { background:white; padding:12px; border-radius:24px; display:inline-block; margin:16px 0; }
        .upi-id { background:#0f172a; padding:10px; border-radius:40px; font-family:monospace; font-size:1rem; margin:12px 0; border:1px solid #3b82f6; }
        .txn-input { width:100%; padding:12px; border-radius:40px; background:#0f172a; border:1px solid #475569; color:white; margin:12px 0; text-align:center; }
        .modal-buttons { display:flex; gap:12px; margin-top:16px; }
        .modal-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; border:none; cursor:pointer; }
        .pay-now { background:#10b981; color:white; }
        .exit-modal { background:#334155; color:white; }
        .page { min-height:100vh; width:100%; background: radial-gradient(circle at 30% 10%, #0f172a, #020617); display:flex; align-items:center; justify-content:center; position:fixed; top:0; left:0; padding:20px; }
        .glass-card { max-width:560px; width:100%; background: rgba(30,41,59,0.6); backdrop-filter:blur(12px); border-radius:32px; padding:32px 28px; border:1px solid #334155; box-shadow:0 20px 35px -10px rgba(0,0,0,0.3); }
        h1 { font-size:2rem; text-align:center; background:linear-gradient(135deg, #c084fc, #60a5fa); -webkit-background-clip:text; background-clip:text; color:transparent; margin-bottom:8px; }
        .rules { margin:24px 0; }
        .rule-item { display:flex; gap:12px; margin-bottom:16px; align-items:center; }
        .rule-icon { color:#3b82f6; font-size:1.2rem; }
        .gender-options { display:flex; gap:16px; justify-content:center; margin:20px 0; }
        .gender-btn { background:#0f172a; border:1px solid #334155; padding:10px 20px; border-radius:40px; cursor:pointer; transition:0.2s; }
        .gender-btn.selected { background:#3b82f6; border-color:#3b82f6; color:white; }
        .terms-check { margin:20px 0; display:flex; align-items:center; gap:12px; justify-content:center; }
        .enter-btn { width:100%; background:linear-gradient(95deg, #3b82f6, #2563eb); border:none; padding:14px; border-radius:48px; font-size:1rem; font-weight:600; color:white; cursor:pointer; transition:0.2s; }
        .enter-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .chat-page { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#0f172a; flex-direction:column; }
        .chat-page.active { display:flex; }
        .chat-header { background:#1e293b; border-bottom:1px solid #334155; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; }
        .logo { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #c084fc, #60a5fa); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .badge { background:#0f172a; padding:6px 12px; border-radius:40px; font-size:0.75rem; display:inline-flex; align-items:center; gap:6px; border:1px solid #334155; }
        .pref-bar { background:#1e293b; padding:12px 20px; display:flex; gap:12px; flex-wrap:wrap; border-bottom:1px solid #334155; }
        .pref-bar select, .pref-bar button { background:#0f172a; border:1px solid #334155; padding:6px 14px; border-radius:40px; color:white; cursor:pointer; }
        .game-btn { background:#10b981; border:none; }
        .chat-messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; background:#0f172a; }
        .msg { max-width:80%; padding:10px 16px; border-radius:20px; font-size:0.9rem; word-break:break-word; }
        .msg-in { background:#334155; align-self:flex-start; border-bottom-left-radius:4px; }
        .msg-out { background:#3b82f6; align-self:flex-end; border-bottom-right-radius:4px; }
        .sys-msg { text-align:center; font-size:0.7rem; color:#94a3b8; margin:8px 0; background:#1e293b; padding:6px 12px; border-radius:20px; width:fit-content; align-self:center; }
        .game-board { display:grid; grid-template-columns:repeat(3, 80px); gap:8px; justify-content:center; margin:15px 0; background:#1e293b; padding:15px; border-radius:24px; align-self:center; }
        .game-cell { width:80px; height:80px; background:#0f172a; border:2px solid #475569; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:2rem; font-weight:bold; cursor:pointer; transition:0.2s; }
        .game-cell.active { border-color:#3b82f6; background:#1e293b; }
        .game-cell.disabled { cursor:not-allowed; opacity:0.5; }
        .typing { font-size:0.75rem; padding:4px 20px; color:#94a3b8; font-style:italic; min-height:28px; }
        .input-area { display:flex; gap:10px; padding:16px; background:#1e293b; border-top:1px solid #334155; }
        .input-area input { flex:1; padding:12px 16px; border-radius:40px; background:#0f172a; border:1px solid #334155; color:white; }
        .send-btn { background:#3b82f6; border:none; padding:0 20px; border-radius:40px; color:white; font-weight:600; cursor:pointer; }
        .action-buttons { display:flex; gap:10px; padding:0 16px 16px 16px; }
        .action-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; cursor:pointer; }
        .main-action { background:#3b82f6; color:white; border:none; }
        .skip-btn { background:#ef4444; color:white; border:none; }
        .main-action.end { background:#ef4444; }
        @media (max-width:700px) {
            .game-board { grid-template-columns:repeat(3, 60px); gap:6px; }
            .game-cell { width:60px; height:60px; font-size:1.5rem; }
            .msg { max-width:90%; }
            .action-buttons { flex-direction:column; }
        }
    </style>
</head>
<body>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<!-- Payment Modal -->
<div id="paymentModal" class="modal-overlay">
    <div class="payment-modal">
        <i class="fas fa-qrcode" style="font-size:2.2rem; color:#10b981;"></i>
        <h3>Pay ₹2 via UPI</h3>
        <div id="qrCodeContainer" class="qr-placeholder"></div>
        <div class="upi-id">UPI: <strong>chatwave@okhdfcbank</strong></div>
        <input type="text" id="transactionIdInput" class="txn-input" placeholder="Enter UPI transaction ID" autocomplete="off">
        <div class="modal-buttons">
            <button id="modalPayNow" class="pay-now">✅ Verify Payment</button>
            <button id="modalExit" class="exit-modal">Cancel</button>
        </div>
    </div>
</div>

<!-- First Page (gender buttons) -->
<div id="page1" class="page">
    <div class="glass-card">
        <h1><i class="fas fa-user-secret"></i> ChatWave</h1>
        <p style="text-align:center; margin-bottom:20px;">Talk to strangers · Anonymous · Play games</p>
        <div class="rules">
            <div class="rule-item"><div class="rule-icon"><i class="fas fa-check-circle"></i></div> You must be 18+</div>
            <div class="rule-item"><div class="rule-icon"><i class="fas fa-ban"></i></div> No nudity / hate speech</div>
            <div class="rule-item"><div class="rule-icon"><i class="fas fa-question-circle"></i></div> Do not ask for gender / personal info</div>
            <div class="rule-item"><div class="rule-icon"><i class="fas fa-smile"></i></div> Be kind & respectful</div>
        </div>
        <div class="gender-selector" style="text-align:center;">
            <div style="margin-bottom:8px;">I am a:</div>
            <div class="gender-options">
                <div data-gender="male" class="gender-btn">Male</div>
                <div data-gender="female" class="gender-btn">Female</div>
                <div data-gender="other" class="gender-btn">Other</div>
            </div>
            <div id="genderError" style="color:#ef4444; font-size:0.7rem; margin-top:8px;"></div>
        </div>
        <div class="terms-check">
            <input type="checkbox" id="acceptTerms"> <label for="acceptTerms">I agree to the rules and am 18+</label>
        </div>
        <button id="goToChatBtn" class="enter-btn" disabled>Enter Anonymous Chat →</button>
    </div>
</div>

<!-- Chat Page (full functionality) -->
<div id="page2" class="chat-page">
    <div class="chat-header">
        <div class="logo"><i class="fas fa-user-secret"></i> ChatWave</div>
        <div class="badge"><i class="fas fa-users"></i> <span id="activeUserCount">--</span> online</div>
    </div>
    <div class="pref-bar">
        <select id="preferSelect">
            <option value="any">Anyone</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
        </select>
        <button id="payNowBtn" class="game-btn" style="background:#f59e0b;"><i class="fas fa-rupee-sign"></i> Pay ₹2 (Female access)</button>
        <button id="gameRequestBtn" class="game-btn"><i class="fas fa-gamepad"></i> Play Tic-Tac-Toe</button>
    </div>
    <div class="chat-messages" id="chatMessages"></div>
    <div class="typing" id="typingIndicator"></div>
    <div class="input-area">
        <input type="text" id="msgInput" placeholder="Type a message..." autocomplete="off" disabled>
        <button id="sendBtn" class="send-btn" disabled><i class="fas fa-paper-plane"></i> Send</button>
    </div>
    <div class="action-buttons">
        <button id="mainActionBtn" class="main-action"><i class="fas fa-random"></i> Find Stranger</button>
        <button id="skipBtn" class="skip-btn"><i class="fas fa-forward"></i> Skip</button>
    </div>
</div>

<script>
    const API_BASE = '';
    let sessionId = localStorage.getItem('sessionId') || 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2);
    localStorage.setItem('sessionId', sessionId);
    let activePartner = null, chatActive = false, hasPremium = false, premiumExpiry = null;
    let activePolling = null, lastMsgTimestamp = 0, msgInterval = null, typingInterval = null;
    let isTyping = false, typingTimeout = null, userGender = null, gameBoard = null, myTurn = false, gameActive = false, gameBoardVisible = false, mySymbol = null, pendingFindMatch = false;

    function showLoading(show) { document.getElementById('loadingOverlay').classList.toggle('active',show); }
    function scrollToBottom() { let area = document.getElementById('chatMessages'); area.scrollTop = area.scrollHeight; }

    async function apiCall(endpoint, method, data) {
        let opts = { method, headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId } };
        if(data) opts.body = JSON.stringify(data);
        let res = await fetch(API_BASE+endpoint, opts);
        return res.json();
    }

    async function checkPremium() { let res = await apiCall('/api/check-premium', 'POST', { sessionId }); hasPremium = res.hasPremium; premiumExpiry = res.expiry; }
    async function getActiveUsers() { let res = await apiCall('/api/active-users', 'GET'); document.getElementById('activeUserCount').innerText = res.count; }

    async function sendGameRequest() {
        if(!chatActive) { addSystemMsg("Connect to a stranger first."); return; }
        if(gameActive) { addSystemMsg("Game already active."); return; }
        await apiCall('/api/send-message', 'POST', { sessionId, text: JSON.stringify({ type: 'game_request' }) });
        addSystemMsg("🎮 Game request sent. Waiting...");
    }
    async function acceptGame() { await apiCall('/api/send-message', 'POST', { sessionId, text: JSON.stringify({ type: 'game_accept' }) }); }
    async function declineGame() { await apiCall('/api/send-message', 'POST', { sessionId, text: JSON.stringify({ type: 'game_decline' }) }); }
    async function playAgain() {
        if(!chatActive) return;
        await apiCall('/api/send-message', 'POST', { sessionId, text: JSON.stringify({ type: 'play_again' }) });
        addSystemMsg("🔄 Sending rematch request...");
    }
    async function makeMove(idx) {
        if(!chatActive || !gameActive || !myTurn) return;
        if(!gameBoard || gameBoard[idx] !== '') return;
        await apiCall('/api/send-message', 'POST', { sessionId, text: JSON.stringify({ type: 'game_move', index: idx }) });
    }
    function renderGameBoard() {
        let old = document.getElementById('gameBoard');
        if(old) old.remove();
        if(!gameBoardVisible) return;
        let container = document.getElementById('chatMessages');
        let boardDiv = document.createElement('div'); boardDiv.id = 'gameBoard'; boardDiv.className = 'game-board';
        for(let i=0;i<9;i++) {
            let cell = document.createElement('div'); cell.className = 'game-cell';
            if(gameActive && myTurn && gameBoard && gameBoard[i] === '') cell.classList.add('active');
            else cell.classList.add('disabled');
            cell.innerText = gameBoard ? gameBoard[i] : '';
            cell.onclick = (function(idx){ return function(){ makeMove(idx); }; })(i);
            boardDiv.appendChild(cell);
        }
        container.appendChild(boardDiv);
        boardDiv.scrollIntoView({behavior:'smooth'});
        scrollToBottom();
    }
    function handleGameState(state) {
        gameBoard = state.board; myTurn = (state.currentPlayer === 'X' && mySymbol === 'X') || (state.currentPlayer === 'O' && mySymbol === 'O');
        gameActive = state.gameActive;
        if(!gameActive) gameBoardVisible = false;
        if(gameBoardVisible) renderGameBoard();
    }

    async function findMatch() {
        if(chatActive) { endChat(); return; }
        let prefer = document.getElementById('preferSelect').value;
        if(userGender === 'male' && prefer === 'female' && !hasPremium) {
            pendingFindMatch = true;
            let qrDiv = document.getElementById('qrCodeContainer'); qrDiv.innerHTML = "";
            new QRCode(qrDiv, { text: "upi://pay?pa=chatwave@okhdfcbank&pn=ChatWave&am=2&cu=INR", width: 180, height: 180 });
            document.getElementById('paymentModal').classList.add('active');
            return;
        }
        if(chatActive) endChat();
        showLoading(true);
        let res = await apiCall('/api/find-match', 'POST', { prefer, sessionId, userGender });
        showLoading(false);
        if(res.success && res.partner) startChat(res.partner);
        else addSystemMsg(res.message || "No stranger found.");
    }
    async function skipChat() {
        if(!chatActive) { addSystemMsg("No active chat."); return; }
        showLoading(true);
        let res = await apiCall('/api/skip-chat', 'POST', { sessionId });
        if(msgInterval) clearInterval(msgInterval); if(typingInterval) clearInterval(typingInterval);
        msgInterval = null; typingInterval = null;
        chatActive = false; activePartner = null; gameActive = false; gameBoardVisible = false;
        clearChatMsgs(true);
        updateUI();
        if(res.success && res.partner) startChat(res.partner);
        else if(res.message) addSystemMsg(res.message);
        showLoading(false);
    }
    async function endChat() {
        if(chatActive) {
            await apiCall('/api/end-chat', 'POST', { sessionId });
            if(msgInterval) clearInterval(msgInterval); if(typingInterval) clearInterval(typingInterval);
            msgInterval = null; typingInterval = null;
            chatActive = false; activePartner = null; gameActive = false; gameBoardVisible = false;
            clearChatMsgs(true);
            updateUI();
        } else addSystemMsg("No active chat.");
    }
    function startChat(partner) {
        if(chatActive) endChat();
        activePartner = partner; chatActive = true; gameActive = false; gameBoardVisible = false; mySymbol = null;
        clearChatMsgs();
        let genderDisplay = partner.actualGender === 'male' ? 'Male' : (partner.actualGender === 'female' ? 'Female' : 'Other');
        addSystemMsg('✨ Connected with ' + genderDisplay + ' stranger! Be anonymous, be kind.');
        updateUI();
        lastMsgTimestamp = Date.now();
        if(msgInterval) clearInterval(msgInterval); msgInterval = setInterval(pollMessages, 1500);
        if(typingInterval) clearInterval(typingInterval); typingInterval = setInterval(pollTyping, 2000);
        document.getElementById('msgInput').disabled = false; document.getElementById('sendBtn').disabled = false;
        let mainBtn = document.getElementById('mainActionBtn'); mainBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat'; mainBtn.classList.add('end');
    }
    async function pollMessages() {
        if(!chatActive) return;
        let res = await apiCall('/api/get-messages', 'POST', { sessionId, lastTimestamp: lastMsgTimestamp });
        if(res.chatEnded) { addSystemMsg("Stranger left."); endChat(); return; }
        if(res.success && res.messages && res.messages.length) {
            for(let msg of res.messages) {
                if(msg.from === 'system') {
                    if(msg.actions && msg.actions.includes('accept_game')) {
                        let wrapper = document.createElement('div'); wrapper.className = 'sys-msg';
                        wrapper.innerHTML = '<i class="fas fa-info-circle"></i> ' + msg.text;
                        let btnDiv = document.createElement('div'); btnDiv.className = 'action-buttons'; btnDiv.style.marginTop='8px';
                        let accept = document.createElement('button'); accept.innerText='Accept'; accept.className='action-btn'; accept.onclick=acceptGame;
                        let decline = document.createElement('button'); decline.innerText='Decline'; decline.className='action-btn decline'; decline.onclick=declineGame;
                        btnDiv.appendChild(accept); btnDiv.appendChild(decline); wrapper.appendChild(btnDiv);
                        document.getElementById('chatMessages').appendChild(wrapper); scrollToBottom();
                    } else if(msg.actions && msg.actions.includes('play_again')) {
                        let wrapper = document.createElement('div'); wrapper.className = 'sys-msg';
                        wrapper.innerHTML = '<i class="fas fa-info-circle"></i> ' + msg.text;
                        let btnDiv = document.createElement('div'); btnDiv.className = 'action-buttons';
                        let again = document.createElement('button'); again.innerText='Play Again'; again.className='action-btn'; again.onclick=playAgain;
                        btnDiv.appendChild(again); wrapper.appendChild(btnDiv);
                        document.getElementById('chatMessages').appendChild(wrapper); scrollToBottom();
                    } else addSystemMsg(msg.text);
                } else if(msg.from === 'game') {
                    try { let data = JSON.parse(msg.text);
                        if(data.type === 'game_state') {
                            if(mySymbol === null && data.playerX === sessionId) mySymbol = 'X';
                            else if(mySymbol === null && data.playerO === sessionId) mySymbol = 'O';
                            else if(mySymbol === null) mySymbol = 'X';
                            handleGameState(data);
                            if(!gameBoardVisible && data.gameActive) { gameBoardVisible = true; renderGameBoard(); addSystemMsg("🎮 Game started! " + (myTurn ? "Your turn (X)." : "Opponent's turn (O).")); }
                        }
                    } catch(e) {}
                } else addBubble(msg.text, 'in');
                if(msg.timestamp > lastMsgTimestamp) lastMsgTimestamp = msg.timestamp;
            }
        }
    }
    async function pollTyping() { if(!chatActive) return; let res = await apiCall('/api/get-typing', 'POST', { sessionId }); document.getElementById('typingIndicator').innerHTML = res.isTyping ? '<i class="fas fa-pencil-alt"></i> Stranger is typing...' : ''; }
    async function sendTyping(typing) { if(!chatActive) return; await apiCall('/api/typing', 'POST', { sessionId, isTyping: typing }); }
    async function sendMessage() {
        if(!chatActive) return;
        let input = document.getElementById('msgInput'); let text = input.value.trim(); if(!text) return;
        addBubble(text, 'out'); input.value = '';
        if(typingTimeout) clearTimeout(typingTimeout); await sendTyping(false);
        await apiCall('/api/send-message', 'POST', { sessionId, text });
    }
    function addSystemMsg(t) { let area = document.getElementById('chatMessages'); let div = document.createElement('div'); div.className = 'sys-msg'; div.innerHTML = '<i class="fas fa-info-circle"></i> ' + t; area.appendChild(div); scrollToBottom(); }
    function addBubble(t, type) { let area = document.getElementById('chatMessages'); let div = document.createElement('div'); div.className = 'msg ' + (type==='out'?'msg-out':'msg-in'); div.innerText = t; area.appendChild(div); scrollToBottom(); }
    function clearChatMsgs(keepSys) { document.getElementById('chatMessages').innerHTML = ''; if(keepSys) addSystemMsg("Chat ended. Click 'Find Stranger' to start fresh."); }
    function updateUI() {
        let mainBtn = document.getElementById('mainActionBtn');
        if(chatActive && activePartner) { mainBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat'; mainBtn.classList.add('end'); }
        else { mainBtn.innerHTML = '<i class="fas fa-random"></i> Find Stranger'; mainBtn.classList.remove('end'); }
    }

    // Payment flow (transaction ID)
    async function verifyPayment() {
        let txnId = document.getElementById('transactionIdInput').value.trim();
        if(!txnId || txnId.length < 5) { addSystemMsg("Enter a valid transaction ID (min 5 characters)."); return; }
        showLoading(true);
        let res = await apiCall('/api/verify-payment', 'POST', { sessionId, transactionId: txnId });
        showLoading(false);
        if(res.success) {
            addSystemMsg(res.message);
            await checkPremium();
            document.getElementById('paymentModal').classList.remove('active');
            document.getElementById('transactionIdInput').value = '';
            if(pendingFindMatch) { pendingFindMatch = false; findMatch(); }
        } else addSystemMsg(res.message);
    }
    function exitPaymentModal() {
        document.getElementById('paymentModal').classList.remove('active');
        pendingFindMatch = false;
        document.getElementById('preferSelect').value = 'any';
        addSystemMsg("Payment canceled. Preference set to 'Anyone'.");
    }

    // First page logic (gender buttons)
    let page1 = document.getElementById('page1'), page2 = document.getElementById('page2');
    let acceptCheck = document.getElementById('acceptTerms'), goBtn = document.getElementById('goToChatBtn');
    let genderBtns = document.querySelectorAll('.gender-btn'), genderError = document.getElementById('genderError');
    let selectedGender = null;
    genderBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            genderBtns.forEach(b => b.classList.remove('selected'));
            this.classList.add('selected');
            selectedGender = this.getAttribute('data-gender');
            genderError.innerText = '';
            validateForm();
        });
    });
    function validateForm() { goBtn.disabled = !(selectedGender && acceptCheck.checked); }
    acceptCheck.addEventListener('change', validateForm);
    goBtn.addEventListener('click', async () => {
        if(!selectedGender) { genderError.innerText = 'Select your gender'; return; }
        userGender = selectedGender;
        localStorage.setItem('userGender', userGender);
        page1.style.display = 'none';
        page2.classList.add('active');
        await checkPremium();
        getActiveUsers();
        if(activePolling) clearInterval(activePolling);
        activePolling = setInterval(getActiveUsers, 10000);
        addSystemMsg("👋 Welcome, anonymous. Select preference and click 'Find Stranger'.\nMale users need ₹2 to chat with females.");
    });

    document.getElementById('mainActionBtn').onclick = findMatch;
    document.getElementById('skipBtn').onclick = skipChat;
    document.getElementById('sendBtn').onclick = sendMessage;
    document.getElementById('msgInput').onkeypress = e => { if(e.key === 'Enter') sendMessage(); };
    document.getElementById('gameRequestBtn').onclick = sendGameRequest;
    document.getElementById('payNowBtn').onclick = () => {
        if(userGender !== 'male') { addSystemMsg("Only male users need payment."); return; }
        if(hasPremium) { addSystemMsg("Premium already active."); return; }
        let qrDiv = document.getElementById('qrCodeContainer'); qrDiv.innerHTML = "";
        new QRCode(qrDiv, { text: "upi://pay?pa=chatwave@okhdfcbank&pn=ChatWave&am=2&cu=INR", width: 180, height: 180 });
        document.getElementById('paymentModal').classList.add('active');
    };
    document.getElementById('modalPayNow').onclick = verifyPayment;
    document.getElementById('modalExit').onclick = exitPaymentModal;
    let msgInput = document.getElementById('msgInput');
    msgInput.addEventListener('input', () => {
        if(!chatActive) return;
        let currently = msgInput.value.length > 0;
        if(currently !== isTyping) { isTyping = currently; sendTyping(isTyping); }
        if(typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => { if(isTyping && chatActive) { isTyping = false; sendTyping(false); } }, 2000);
    });
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(htmlTemplate));
app.get('/*splat', (req, res) => res.send(htmlTemplate));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ChatWave server running on http://localhost:${PORT}`);
  console.log(`🎮 Play again fully fixed – rematch request/accept works.`);
  console.log(`💰 Manual UPI payment with transaction ID tracking.`);
});
