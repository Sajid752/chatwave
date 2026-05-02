// ==================== server.js ====================
// Real users only. ₹2 boost for male→female (10 min premium).
// Tic‑Tac‑Toe: request/accept flow + "Play Again" with partner confirmation.
// Mobile layout: buttons side‑by‑side.

const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_SjkRHBxR35ls58';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'nVBr3LEjVAtLM3MfdJrKx3KY';
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

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

// ---------- In‑memory stores ----------
const activeSessions = new Map();
const userPremiums = new Map();
const userGender = new Map();
const waitingQueue = [];
const activeChats = new Map();
const chatMessages = new Map();
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
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

function isDraw(board) {
  return board.every(cell => cell !== '');
}

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
  game.gameActive = true;   // will be set to true only after acceptance
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
    messages.push({ from: 'system', text: '🏆 You won the game! 🏆', timestamp: Date.now(), target: winnerSession });
    messages.push({ from: 'system', text: '😔 You lost. Better luck next time!', timestamp: Date.now(), target: loserSession });
    // Add "Play Again" button for both users
    messages.push({ from: 'system', text: '🔄 Click "Play Again" below to ask for a rematch.', timestamp: Date.now(), actions: ['play_again'] });
    chatMessages.set(roomId, messages);
  } else if (isDraw(game.board)) {
    game.gameActive = false;
    const messages = chatMessages.get(roomId) || [];
    messages.push({ from: 'system', text: '🤝 Game ended in a draw!', timestamp: Date.now() });
    messages.push({ from: 'system', text: '🔄 Click "Play Again" below to ask for a rematch.', timestamp: Date.now(), actions: ['play_again'] });
    chatMessages.set(roomId, messages);
  } else {
    game.currentPlayer = (game.currentPlayer === 'X') ? 'O' : 'X';
  }
  broadcastGameState(roomId);
  return true;
}

// ---------- API routes ----------
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const options = { amount: amount * 100, currency: 'INR', receipt: `receipt_${Date.now()}`, payment_capture: 1 };
    const order = await razorpay.orders.create(options);
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, key: RAZORPAY_KEY_ID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Order creation failed' });
  }
});

app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, sessionId } = req.body;
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSignature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
  if (expectedSignature === razorpay_signature) {
    const currentExpiry = userPremiums.get(sessionId) || 0;
    const newExpiry = Math.max(currentExpiry, Date.now()) + 10 * 60 * 1000;
    userPremiums.set(sessionId, newExpiry);
    const paymentRecord = {
      id: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: 2,
      currency: 'INR',
      sessionId,
      timestamp: Date.now(),
      date: new Date().toISOString()
    };
    savePayment(paymentRecord);
    res.json({ success: true, message: 'Premium activated (10 min)', newExpiry });
  } else {
    res.status(400).json({ success: false, message: 'Invalid signature' });
  }
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
    return res.json({ success: false, message: "You need to pay ₹2 to chat with females. Click the Boost button." });
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
        partner: { name: 'Real user', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
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
        partner: { name: 'Real user', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }

  return res.json({ success: false, message: "No real users online. Please try again later." });
});

app.post('/api/send-message', (req, res) => {
  const { sessionId, text } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.status(400).json({ success: false, message: 'No active chat' });
  const roomId = chat.roomId;
  if (chatEnded.get(roomId)) return res.status(400).json({ success: false, message: 'Chat already ended' });

  // Handle game messages
  if (text.startsWith('{') && text.includes('game_')) {
    try {
      const data = JSON.parse(text);
      if (data.type === 'game_request') {
        const game = gameRooms.get(roomId);
        if (game && !game.gameActive && !game.requestPending) {
          game.requestPending = true;
          game.requestFrom = sessionId;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 The other user wants to play Tic‑Tac‑Toe. Accept? (Click Accept/Decline below)', timestamp: Date.now(), target: chat.partnerSessionId, actions: ['accept_game', 'decline_game'] });
          chatMessages.set(roomId, messages);
        }
      } else if (data.type === 'game_accept') {
        const game = gameRooms.get(roomId);
        if (game && game.requestPending && game.requestFrom === chat.partnerSessionId) {
          game.gameActive = true;
          game.requestPending = false;
          game.requestFrom = null;
          game.board = Array(9).fill('');
          game.currentPlayer = 'X';
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 Game accepted! The board will appear. X starts.', timestamp: Date.now() });
          chatMessages.set(roomId, messages);
          broadcastGameState(roomId);
        }
      } else if (data.type === 'game_decline') {
        const game = gameRooms.get(roomId);
        if (game && game.requestPending && game.requestFrom === chat.partnerSessionId) {
          game.requestPending = false;
          game.requestFrom = null;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '❌ The other user declined to play.', timestamp: Date.now(), target: game.requestFrom });
          chatMessages.set(roomId, messages);
        }
      } else if (data.type === 'game_move') {
        handleGameMove(roomId, sessionId, data.index);
      } else if (data.type === 'play_again') {
        // User clicked "Play Again" – send a new game request to the partner
        const game = gameRooms.get(roomId);
        if (game && !game.gameActive && !game.requestPending) {
          game.requestPending = true;
          game.requestFrom = sessionId;
          const messages = chatMessages.get(roomId) || [];
          messages.push({ from: 'system', text: '🎮 The other user wants to play again. Accept? (Click Accept/Decline below)', timestamp: Date.now(), target: chat.partnerSessionId, actions: ['accept_game', 'decline_game'] });
          chatMessages.set(roomId, messages);
          // Also inform the requester that the request was sent
          messages.push({ from: 'system', text: '✅ Rematch request sent. Waiting for partner...', timestamp: Date.now(), target: sessionId });
          chatMessages.set(roomId, messages);
        }
      }
    } catch(e) {}
  } else {
    // Normal chat message
    const messages = chatMessages.get(roomId) || [];
    messages.push({ from: sessionId, text, timestamp: Date.now() });
    chatMessages.set(roomId, messages);
  }
  res.json({ success: true });
});

// Remaining API routes (typing, get-messages, skip-chat, end-chat) unchanged
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
        partner: { name: 'Real user', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }
  res.json({ success: false, message: "No new partner right now. Try again." });
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

// ---------- Admin API (unchanged) ----------
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
  res.send(`<!DOCTYPE html><html><head><title>ChatWave Admin</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>body{font-family:monospace;background:#f1f5f9;padding:20px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}.card{background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}.card .value{font-size:2rem;font-weight:bold}table{width:100%;border-collapse:collapse;background:white}th,td{padding:12px;text-align:left;border-bottom:1px solid #e2e8f0}</style></head><body><div class="container"><h1>📊 ChatWave Admin</h1><button onclick="loadData()">Refresh</button><div id="stats"></div><canvas id="dailyChart" style="max-height:300px"></canvas><h3>Recent Payments</h3><table id="paymentsTable"><thead><tr><th>Payment ID</th><th>Amount</th><th>Date</th><th>Session</th></tr></thead><tbody></tbody></table></div><script>const base='/api/admin/stats?key=${key}';async function loadData(){const r=await fetch(base);const d=await r.json();if(!d.success)return;document.getElementById('stats').innerHTML=\`<div class="card"><h3>Active Users</h3><div class="value">\${d.activeUsers}</div></div><div class="card"><h3>Total Matches</h3><div class="value">\${d.totalMatches}</div></div><div class="card"><h3>Total Revenue (₹)</h3><div class="value">\${d.totalRevenue}</div></div><div class="card"><h3>Payments</h3><div class="value">\${d.totalPayments}</div></div>\`;document.querySelector('#paymentsTable tbody').innerHTML=d.recentPayments.map(p=>\`<tr><td>\${p.id}</td><td>₹\${p.amount}</td><td>\${new Date(p.timestamp).toLocaleString()}</td><td>\${p.sessionId.substring(0,12)}...</td></tr>\`).join('');new Chart(document.getElementById('dailyChart'),{type:'bar',data:{labels:d.last7Days.map(x=>x.date),datasets:[{label:'Payments (₹)',data:d.last7Days.map(x=>x.amount),backgroundColor:'#3b82f6'}]}})}loadData();setInterval(loadData,30000);</script></body></html>`);
});

// ------------------- FRONTEND (with proper "Play Again" request/accept) -------------------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>ChatWave · Real Chat + Games</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>
        /* styles same as before – unchanged */
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); min-height: 100vh; }
        .loading-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:10000; visibility:hidden; opacity:0; transition:0.2s; }
        .loading-overlay.active { visibility:visible; opacity:1; }
        .spinner { width:50px; height:50px; border:4px solid white; border-top-color:#2563eb; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:20000; visibility:hidden; opacity:0; transition:0.2s; }
        .modal-overlay.active { visibility:visible; opacity:1; }
        .payment-modal { background:white; border-radius:28px; max-width:340px; width:90%; padding:28px 24px; text-align:center; box-shadow:0 40px 60px rgba(0,0,0,0.3); }
        .payment-modal h3 { font-size:1.5rem; margin-bottom:12px; color:#1e293b; }
        .payment-modal p { color:#475569; margin-bottom:20px; }
        .modal-buttons { display:flex; gap:12px; margin-top:8px; }
        .modal-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; border:none; cursor:pointer; }
        .pay-now { background:#f59e0b; color:white; }
        .exit-modal { background:#e2e8f0; color:#1e293b; }
        .page { min-height:100vh; width:100%; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); display:flex; align-items:center; justify-content:center; position:fixed; top:0; left:0; }
        .terms-container { max-width:500px; width:90%; background:white; padding:32px 28px; border-radius:24px; box-shadow:0 20px 40px rgba(0,0,0,0.1); animation:fadeIn 0.4s ease; text-align:center; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        .terms-header { margin-bottom:24px; }
        .terms-header h1 { font-size:2rem; display:flex; align-items:center; justify-content:center; gap:12px; color:#1e293b; }
        .terms-content { text-align:left; }
        .rule-block { margin-bottom:24px; border-bottom:1px solid #eef2ff; padding-bottom:18px; }
        .rule-title { font-weight:700; font-size:1.1rem; color:#0f172a; margin-bottom:8px; display:flex; align-items:center; gap:8px; }
        .rule-title i { color:#2563eb; width:24px; }
        .rule-text { color:#334155; font-size:0.85rem; line-height:1.5; padding-left:32px; }
        .checkbox-row { display:flex; align-items:flex-start; gap:14px; background:#f8fafc; padding:18px 20px; border-radius:16px; margin:20px 0; border:1px solid #e2e8f0; }
        .checkbox-row input { width:22px; height:22px; cursor:pointer; accent-color:#2563eb; margin-top:2px; }
        .gender-selector { margin: 20px 0; text-align:left; }
        .gender-selector label { font-weight:600; margin-right:16px; display:block; margin-bottom:8px; }
        .gender-options { display:flex; gap:16px; margin-top:8px; flex-wrap:wrap; justify-content:center; }
        .gender-option { display:flex; align-items:center; gap:8px; cursor:pointer; padding:8px 16px; background:#f1f5f9; border-radius:40px; border:1px solid #e2e8f0; }
        .gender-option.selected { background:#2563eb; color:white; border-color:#2563eb; }
        .gender-option input { display:none; }
        .go-chat-btn { width:100%; background:linear-gradient(95deg, #2563eb, #1d4ed8); border:none; padding:16px; border-radius:40px; font-size:1.1rem; font-weight:700; color:white; cursor:pointer; margin-top:20px; }
        .go-chat-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .chat-page { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#ffffff; flex-direction:column; }
        .chat-page.active { display:flex; }
        .chat-header { background:white; border-bottom:1px solid #e2e8f0; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
        .logo-area { display:flex; align-items:center; gap:12px; }
        .logo { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #1e293b, #2563eb); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .active-badge { background:#f1f5f9; padding:6px 12px; border-radius:40px; font-size:0.75rem; display:flex; align-items:center; gap:6px; }
        .pref-selector { background:#f1f5f9; padding:6px 16px; border-radius:40px; display:flex; align-items:center; gap:12px; }
        .pref-selector label { font-weight:500; font-size:0.75rem; }
        .pref-selector select { background:white; border:1px solid #cbd5e1; border-radius:30px; padding:4px 10px; font-size:0.75rem; }
        .game-btn { background:#10b981; border:none; padding:6px 14px; border-radius:40px; color:white; font-weight:600; font-size:0.75rem; cursor:pointer; margin-left:8px; }
        .chat-messages { flex:1; overflow-y:auto; padding:16px 12px; display:flex; flex-direction:column; gap:8px; background:#ffffff; scroll-behavior:smooth; }
        .msg { max-width:85%; padding:10px 14px; border-radius:18px; font-size:0.9rem; margin:4px 0; word-break:break-word; }
        .msg-in { background:#f1f5f9; align-self:flex-start; border-bottom-left-radius:4px; }
        .msg-out { background:#2563eb; color:white; align-self:flex-end; border-bottom-right-radius:4px; }
        .sys-msg { text-align:center; font-size:0.75rem; color:#64748b; margin:8px 0; padding:0 12px; background:#f8fafc; border-radius:20px; width:fit-content; align-self:center; max-width:80%; display:flex; flex-direction:column; gap:8px; }
        .action-buttons { display:flex; gap:6px; justify-content:center; margin-top:4px; }
        .action-btn { background:#2563eb; color:white; border:none; padding:4px 12px; border-radius:40px; cursor:pointer; font-size:0.7rem; }
        .action-btn.decline { background:#ef4444; }
        .action-btn.play-again { background:#10b981; }
        .game-board { display:grid; grid-template-columns:repeat(3, 80px); gap:8px; justify-content:center; margin:10px 0; background:#f8fafc; padding:15px; border-radius:16px; align-self:center; }
        .game-cell { width:80px; height:80px; background:white; border:2px solid #cbd5e1; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:2rem; font-weight:bold; cursor:pointer; transition:0.2s; }
        .game-cell.active { cursor:pointer; background:#eef2ff; }
        .game-cell.disabled { cursor:not-allowed; opacity:0.6; }
        .typing { text-align:left; font-size:1rem; font-weight:500; font-style:italic; padding:6px 20px; color:#3b82f6; min-height:36px; animation:pulse 1.5s infinite; }
        @keyframes pulse { 0% { opacity:0.6; } 50% { opacity:1; } 100% { opacity:0.6; } }
        .input-area { display:flex; gap:10px; padding:12px 16px; background:white; border-top:1px solid #e2e8f0; }
        .input-area input { flex:1; padding:12px 16px; border-radius:40px; border:1px solid #e2e8f0; font-family:inherit; font-size:0.9rem; }
        .send-btn { background:#2563eb; border:none; width:auto; padding:0 20px; border-radius:40px; color:white; font-weight:600; cursor:pointer; }
        .action-buttons-chat { display:flex; gap:10px; padding:0 16px 16px 16px; }
        .action-buttons-chat button { flex:1; padding:12px; border-radius:40px; font-weight:600; cursor:pointer; }
        .main-action-btn { background:#2563eb; color:white; border:none; }
        .skip-btn { background:#f59e0b; color:white; border:none; }
        .main-action-btn.end { background:#ef4444; }
        @media (max-width:700px) {
            .msg { max-width:90%; }
            .action-buttons-chat { flex-direction:row; }
            .action-buttons-chat button { width:100%; }
            .game-board { grid-template-columns:repeat(3, 60px); gap:6px; }
            .game-cell { width:60px; height:60px; font-size:1.5rem; }
            .chat-header { flex-direction:column; align-items:stretch; gap:12px; }
            .logo-area { justify-content:space-between; }
            .pref-selector { justify-content:space-between; width:100%; }
        }
    </style>
</head>
<body>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<div id="paymentModal" class="modal-overlay">
    <div class="payment-modal">
        <i class="fas fa-rupee-sign" style="font-size:2rem; color:#f59e0b;"></i>
        <h3>₹2 Payment Required</h3>
        <p>To chat with females, you need to pay ₹2 (10 minutes premium).</p>
        <div class="modal-buttons">
            <button id="modalPayNow" class="pay-now">Pay Now</button>
            <button id="modalExit" class="exit-modal">Exit</button>
        </div>
    </div>
</div>

<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Real people · ₹2 for male→female (10 min) · Play games</p></div>
        <div class="terms-content">
            <div class="rule-block"><div class="rule-title"><i class="fas fa-gavel"></i> 1. Guidelines</div><div class="rule-text">Be respectful. No harassment.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-venus-mars"></i> 2. Payment Policy</div><div class="rule-text">Male → Female: ₹2 unlocks 10min of real female matches. Female/Other: always free.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-shield-alt"></i> 3. Privacy</div><div class="rule-text">No chat logs stored. Anonymous only.</div></div>
            <div class="gender-selector">
                <label><i class="fas fa-user"></i> I am a:</label>
                <div class="gender-options">
                    <label class="gender-option" data-gender="male"><input type="radio" name="userGender" value="male"> 👨 Male</label>
                    <label class="gender-option" data-gender="female"><input type="radio" name="userGender" value="female"> 👩 Female</label>
                    <label class="gender-option" data-gender="other"><input type="radio" name="userGender" value="other"> 🌈 Other</label>
                </div>
                <div id="genderError" style="color:#ef4444; font-size:0.7rem; margin-top:4px;"></div>
            </div>
            <div class="checkbox-row"><input type="checkbox" id="acceptTerms"><label>I agree to Terms & Conditions and confirm I am 18+ years old.</label></div>
            <button id="goToChatBtn" class="go-chat-btn" disabled><i class="fas fa-arrow-right"></i> Enter ChatWave</button>
        </div>
    </div>
</div>

<div id="page2" class="chat-page">
    <div class="chat-header">
        <div class="logo-area">
            <div class="logo"><i class="fas fa-waveform"></i> ChatWave</div>
            <div class="active-badge"><i class="fas fa-users"></i> <span id="activeUserCount">--</span> online</div>
        </div>
        <div class="pref-selector">
            <label><i class="fas fa-heart"></i> I want:</label>
            <select id="chatPreferSelect">
                <option value="any">Anyone</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
            </select>
            <button id="gameRequestBtn" class="game-btn"><i class="fas fa-gamepad"></i> Play Tic-Tac-Toe</button>
        </div>
    </div>
    <div class="chat-messages" id="chatMsgsArea">
        <div class="sys-msg">✨ Select your preference and click "Find Partner". Male users will be asked to pay ₹2 to chat with females.</div>
    </div>
    <div class="typing" id="typingIndicator"></div>
    <div class="input-area">
        <input type="text" id="chatMsgInput" placeholder="Type a message..." autocomplete="off" disabled>
        <button id="sendChatMsgBtn" class="send-btn" disabled><i class="fas fa-paper-plane"></i> Send</button>
    </div>
    <div class="action-buttons-chat">
        <button id="mainActionBtn" class="main-action-btn"><i class="fas fa-random"></i> Find Partner</button>
        <button id="skipChatBtn" class="skip-btn"><i class="fas fa-forward"></i> Skip</button>
    </div>
</div>

<script>
    const API_BASE = '';
    let sessionId = localStorage.getItem('sessionId') || 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2);
    localStorage.setItem('sessionId', sessionId);
    let activePartner = null, chatActive = false, hasPremium = false, premiumExpiry = null;
    let activePolling = null;
    let lastMsgTimestamp = 0;
    let msgInterval = null;
    let typingInterval = null;
    let isTyping = false;
    let typingTimeout = null;
    let userGender = null;
    let gameBoard = null;
    let myTurn = false;
    let gameActive = false;
    let gameBoardVisible = false;
    let mySymbol = null;
    let pendingFindMatch = false;

    function showLoading(show){ document.getElementById('loadingOverlay').classList.toggle('active',show); }
    function scrollToBottom() { var area = document.getElementById('chatMsgsArea'); area.scrollTop = area.scrollHeight; }

    async function apiCall(endpoint, method, data) {
        var opts = { method, headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId } };
        if(data) opts.body = JSON.stringify(data);
        var res = await fetch(API_BASE+endpoint, opts);
        return res.json();
    }

    async function checkPremium() { 
        var res = await apiCall('/api/check-premium', 'POST', { sessionId }); 
        hasPremium = res.hasPremium; 
        premiumExpiry = res.expiry; 
    }
    async function getActiveUsers() { var res = await apiCall('/api/active-users', 'GET'); document.getElementById('activeUserCount').innerText = res.count; }

    async function sendGameRequest() {
        if(!chatActive) { addSystemMsg("You need to be connected to someone first."); return; }
        if(gameActive) { addSystemMsg("A game is already active."); return; }
        var msg = JSON.stringify({ type: 'game_request' });
        await apiCall('/api/send-message', 'POST', { sessionId, text: msg });
        addSystemMsg("🎮 Game request sent. Waiting for partner to accept...");
    }

    async function acceptGame() {
        var msg = JSON.stringify({ type: 'game_accept' });
        await apiCall('/api/send-message', 'POST', { sessionId, text: msg });
    }
    async function declineGame() {
        var msg = JSON.stringify({ type: 'game_decline' });
        await apiCall('/api/send-message', 'POST', { sessionId, text: msg });
    }

    async function playAgain() {
        if(!chatActive) return;
        var msg = JSON.stringify({ type: 'play_again' });
        await apiCall('/api/send-message', 'POST', { sessionId, text: msg });
        addSystemMsg("🔄 Sending rematch request...");
    }

    async function makeMove(index) {
        if(!chatActive || !gameActive || !myTurn) return;
        if(!gameBoard || gameBoard[index] !== '') return;
        var moveMsg = JSON.stringify({ type: 'game_move', index: index });
        await apiCall('/api/send-message', 'POST', { sessionId, text: moveMsg });
    }

    function renderGameBoard() {
        var oldBoard = document.getElementById('gameBoard');
        if(oldBoard) oldBoard.remove();
        if(!gameBoardVisible) return;
        var container = document.getElementById('chatMsgsArea');
        var boardDiv = document.createElement('div');
        boardDiv.id = 'gameBoard';
        boardDiv.className = 'game-board';
        for(var i=0;i<9;i++) {
            var cell = document.createElement('div');
            cell.className = 'game-cell';
            if(gameActive && myTurn && gameBoard && gameBoard[i] === '') cell.classList.add('active');
            else cell.classList.add('disabled');
            cell.innerText = gameBoard ? gameBoard[i] : '';
            cell.onclick = (function(idx) { return function() { makeMove(idx); }; })(i);
            boardDiv.appendChild(cell);
        }
        container.appendChild(boardDiv);
        boardDiv.scrollIntoView({behavior:'smooth'});
        scrollToBottom();
    }

    function handleGameState(state) {
        gameBoard = state.board;
        myTurn = (state.currentPlayer === 'X' && mySymbol === 'X') || (state.currentPlayer === 'O' && mySymbol === 'O');
        gameActive = state.gameActive;
        if(state.winner) {
            if((state.winner === 'X' && mySymbol === 'X') || (state.winner === 'O' && mySymbol === 'O')) {
                addSystemMsg("🏆 You won the game! 🏆");
            } else if(state.winner) {
                addSystemMsg("😔 You lost. Better luck next time!");
            }
            gameBoardVisible = false;
        }
        if(gameBoardVisible) renderGameBoard();
    }

    async function performFindMatch() {
        var prefer = document.getElementById('chatPreferSelect').value;
        if(userGender === 'male' && prefer === 'female' && !hasPremium) {
            pendingFindMatch = true;
            document.getElementById('paymentModal').classList.add('active');
            return;
        }
        if(chatActive) { endChat(); }
        showLoading(true);
        var res = await apiCall('/api/find-match', 'POST', {
            prefer: prefer,
            sessionId,
            userGender
        });
        showLoading(false);
        if(res.success && res.partner) startChat(res.partner);
        else if(res.message) addSystemMsg(res.message);
        else addSystemMsg("Could not find a partner. Try again.");
    }

    async function openRazorpay() {
        showLoading(true);
        var res = await apiCall('/api/create-order', 'POST', { amount: 2 });
        showLoading(false);
        if(!res.success){ addSystemMsg("Failed to create order."); return; }
        var options = { key: res.key, amount: res.amount, currency: res.currency, name: "ChatWave", description: "Premium Boost (10 min)", order_id: res.orderId, handler: async function(response){
            showLoading(true);
            var verifyRes = await apiCall('/api/verify-payment', 'POST', { razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature, sessionId });
            showLoading(false);
            if(verifyRes.success){ 
                addSystemMsg("✅ Payment successful! Premium activated for 10 minutes.");
                await checkPremium(); 
                document.getElementById('paymentModal').classList.remove('active');
                if(pendingFindMatch) {
                    pendingFindMatch = false;
                    performFindMatch();
                }
            } else {
                addSystemMsg("Payment verification failed.");
            }
        }, prefill: { name: "ChatWave User", email: "user@chatwave.com" }, theme: { color: "#2563eb" } };
        var rzp = new Razorpay(options);
        rzp.open();
    }

    function exitPaymentModal() {
        document.getElementById('paymentModal').classList.remove('active');
        document.getElementById('chatPreferSelect').value = 'any';
        addSystemMsg("Preference changed to 'Anyone' because you declined payment.");
        pendingFindMatch = false;
    }

    async function findMatch() { performFindMatch(); }

    async function skipChat() {
        if(!chatActive) { addSystemMsg("No active chat to skip."); return; }
        showLoading(true);
        var res = await apiCall('/api/skip-chat', 'POST', { sessionId });
        if(msgInterval) clearInterval(msgInterval);
        if(typingInterval) clearInterval(typingInterval);
        msgInterval = null;
        typingInterval = null;
        chatActive = false;
        activePartner = null;
        gameActive = false;
        gameBoardVisible = false;
        clearChatMsgs(true);
        updateChatUI();
        if(res.success && res.partner) {
            startChat(res.partner);
        } else if(res.message) {
            addSystemMsg(res.message);
        }
        showLoading(false);
    }

    async function endChat() {
        if(chatActive) {
            await apiCall('/api/end-chat', 'POST', { sessionId });
            if(msgInterval) clearInterval(msgInterval);
            if(typingInterval) clearInterval(typingInterval);
            msgInterval = null;
            typingInterval = null;
            chatActive = false;
            activePartner = null;
            gameActive = false;
            gameBoardVisible = false;
            clearChatMsgs(true);
            updateChatUI();
        } else {
            addSystemMsg("No active chat.");
        }
    }

    function startChat(partner) {
        if(chatActive) endChat();
        activePartner = partner;
        chatActive = true;
        gameActive = false;
        gameBoardVisible = false;
        mySymbol = null;
        clearChatMsgs();
        var genderDisplay = partner.actualGender === 'male' ? 'Male' : (partner.actualGender === 'female' ? 'Female' : 'Other');
        addSystemMsg('✨ Connected with a real person (' + genderDisplay + ')! Say hello or invite them to play Tic‑Tac‑Toe!');
        updateChatUI();
        lastMsgTimestamp = Date.now();
        if(msgInterval) clearInterval(msgInterval);
        msgInterval = setInterval(pollMessages, 1500);
        if(typingInterval) clearInterval(typingInterval);
        typingInterval = setInterval(pollTyping, 2000);
        var input = document.getElementById('chatMsgInput');
        input.value = '';
        input.disabled = false;
        document.getElementById('sendChatMsgBtn').disabled = false;
        input.focus();
        var mainBtn = document.getElementById('mainActionBtn');
        mainBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat';
        mainBtn.classList.add('end');
    }

    async function pollMessages() {
        if(!chatActive) return;
        var res = await apiCall('/api/get-messages', 'POST', { sessionId, lastTimestamp: lastMsgTimestamp });
        if(res.chatEnded) {
            addSystemMsg("⚠️ Your partner has left the chat.");
            endChat();
            return;
        }
        if(res.success && res.messages && res.messages.length) {
            for(var i=0;i<res.messages.length;i++) {
                var msg = res.messages[i];
                if(msg.from === 'system') {
                    if(msg.actions && msg.actions.includes('accept_game')) {
                        var wrapper = document.createElement('div');
                        wrapper.className = 'sys-msg';
                        wrapper.innerHTML = '<i class="fas fa-info-circle"></i> ' + msg.text;
                        var btnDiv = document.createElement('div');
                        btnDiv.className = 'action-buttons';
                        var acceptBtn = document.createElement('button');
                        acceptBtn.innerText = 'Accept';
                        acceptBtn.className = 'action-btn';
                        acceptBtn.onclick = () => acceptGame();
                        var declineBtn = document.createElement('button');
                        declineBtn.innerText = 'Decline';
                        declineBtn.className = 'action-btn decline';
                        declineBtn.onclick = () => declineGame();
                        btnDiv.appendChild(acceptBtn);
                        btnDiv.appendChild(declineBtn);
                        wrapper.appendChild(btnDiv);
                        document.getElementById('chatMsgsArea').appendChild(wrapper);
                        scrollToBottom();
                    } else if(msg.actions && msg.actions.includes('play_again')) {
                        var wrapper = document.createElement('div');
                        wrapper.className = 'sys-msg';
                        wrapper.innerHTML = '<i class="fas fa-info-circle"></i> ' + msg.text;
                        var btnDiv = document.createElement('div');
                        btnDiv.className = 'action-buttons';
                        var playAgainBtn = document.createElement('button');
                        playAgainBtn.innerText = 'Play Again';
                        playAgainBtn.className = 'action-btn play-again';
                        playAgainBtn.onclick = () => playAgain();
                        btnDiv.appendChild(playAgainBtn);
                        wrapper.appendChild(btnDiv);
                        document.getElementById('chatMsgsArea').appendChild(wrapper);
                        scrollToBottom();
                    } else {
                        addSystemMsg(msg.text);
                    }
                } else if(msg.from === 'game') {
                    try {
                        var data = JSON.parse(msg.text);
                        if(data.type === 'game_state') {
                            if(mySymbol === null && data.playerX === sessionId) mySymbol = 'X';
                            else if(mySymbol === null && data.playerO === sessionId) mySymbol = 'O';
                            else if(mySymbol === null) mySymbol = 'X';
                            handleGameState(data);
                            if(!gameBoardVisible && data.gameActive) {
                                gameBoardVisible = true;
                                renderGameBoard();
                                addSystemMsg("🎮 Game started! " + (myTurn ? "Your turn (X)." : "Opponent's turn (O)."));
                            }
                        }
                    } catch(e) {}
                } else {
                    addBubble(msg.text, 'in');
                }
                if(msg.timestamp > lastMsgTimestamp) lastMsgTimestamp = msg.timestamp;
            }
        }
    }

    async function pollTyping() {
        if(!chatActive) return;
        var res = await apiCall('/api/get-typing', 'POST', { sessionId });
        if(res.isTyping) {
            document.getElementById('typingIndicator').innerHTML = '<i class="fas fa-pencil-alt"></i> Stranger is typing...';
        } else {
            document.getElementById('typingIndicator').innerHTML = '';
        }
    }

    async function sendTyping(typing) {
        if(!chatActive) return;
        await apiCall('/api/typing', 'POST', { sessionId, isTyping: typing });
    }

    async function sendMessage() {
        if(!chatActive || !activePartner) return;
        var input = document.getElementById('chatMsgInput');
        var text = input.value.trim();
        if(!text) return;
        addBubble(text, 'out');
        input.value = '';
        if(typingTimeout) clearTimeout(typingTimeout);
        await sendTyping(false);
        var res = await apiCall('/api/send-message', 'POST', { sessionId, text });
        if(!res.success && res.message === 'Chat already ended') {
            addSystemMsg("⚠️ Chat already ended.");
            endChat();
        }
    }

    function addSystemMsg(t) { 
        var area = document.getElementById('chatMsgsArea'); 
        var div = document.createElement('div'); 
        div.className = 'sys-msg'; 
        div.innerHTML = '<i class="fas fa-info-circle"></i> ' + t; 
        area.appendChild(div); 
        scrollToBottom(); 
    }
    function addBubble(t, type) { 
        var area = document.getElementById('chatMsgsArea'); 
        var div = document.createElement('div'); 
        div.className = 'msg ' + (type === 'out' ? 'msg-out' : 'msg-in'); 
        div.innerText = t; 
        area.appendChild(div); 
        scrollToBottom(); 
    }
    function clearChatMsgs(keepSys){ 
        var area = document.getElementById('chatMsgsArea'); 
        area.innerHTML = ''; 
        if(keepSys) addSystemMsg("Chat ended. Click 'Find Partner' to start a new conversation."); 
    }

    function updateChatUI() {
        var mainBtn = document.getElementById('mainActionBtn');
        var sendBtn = document.getElementById('sendChatMsgBtn');
        var input = document.getElementById('chatMsgInput');
        if(chatActive && activePartner){
            mainBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat';
            mainBtn.classList.add('end');
            sendBtn.disabled = false;
            input.disabled = false;
        } else {
            mainBtn.innerHTML = '<i class="fas fa-random"></i> Find Partner';
            mainBtn.classList.remove('end');
            sendBtn.disabled = true;
            input.disabled = true;
        }
    }

    // Page transitions and gender selection
    var page1 = document.getElementById('page1');
    var page2 = document.getElementById('page2');
    var acceptCheck = document.getElementById('acceptTerms');
    var goBtn = document.getElementById('goToChatBtn');
    var genderOptions = document.querySelectorAll('.gender-option');
    var genderError = document.getElementById('genderError');
    var selectedGender = null;

    for(var i=0;i<genderOptions.length;i++) {
        genderOptions[i].addEventListener('click', function() {
            for(var j=0;j<genderOptions.length;j++) genderOptions[j].classList.remove('selected');
            this.classList.add('selected');
            var radio = this.querySelector('input');
            radio.checked = true;
            selectedGender = radio.value;
            genderError.innerText = '';
            validateForm();
        });
    }

    function validateForm() {
        var termsChecked = acceptCheck.checked;
        if(selectedGender && termsChecked) { goBtn.disabled = false; } else { goBtn.disabled = true; }
    }

    acceptCheck.addEventListener('change', validateForm);

    goBtn.addEventListener('click', function() {
        if(!selectedGender) { genderError.innerText = 'Please select your gender'; return; }
        if(!acceptCheck.checked) return;
        userGender = selectedGender;
        localStorage.setItem('userGender', userGender);
        page1.style.display = 'none';
        page2.classList.add('active');
        checkPremium();
        getActiveUsers();
        if(activePolling) clearInterval(activePolling);
        activePolling = setInterval(getActiveUsers, 10000);
        addSystemMsg("👋 Only real users! Male users selecting 'Female' will be asked to pay ₹2 for 10 minutes premium.");
    });

    document.getElementById('mainActionBtn').onclick = findMatch;
    document.getElementById('skipChatBtn').onclick = skipChat;
    document.getElementById('sendChatMsgBtn').onclick = sendMessage;
    document.getElementById('chatMsgInput').onkeypress = function(e) { if(e.key === 'Enter') sendMessage(); };
    document.getElementById('gameRequestBtn').onclick = sendGameRequest;
    document.getElementById('modalPayNow').onclick = openRazorpay;
    document.getElementById('modalExit').onclick = exitPaymentModal;
    
    var msgInputChat = document.getElementById('chatMsgInput');
    msgInputChat.addEventListener('input', function() {
        if(!chatActive) return;
        var currentlyTyping = msgInputChat.value.length > 0;
        if(currentlyTyping && !isTyping) { isTyping = true; sendTyping(true); }
        else if(!currentlyTyping && isTyping) { isTyping = false; sendTyping(false); }
        if(typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(function() {
            if(isTyping && chatActive) { isTyping = false; sendTyping(false); }
        }, 2000);
    });
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(htmlTemplate));
app.get('/*splat', (req, res) => res.send(htmlTemplate));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ChatWave server running on http://localhost:${PORT}`);
  if (ADMIN_SECRET) {
    console.log(`📊 Admin dashboard enabled at /admin?key=${ADMIN_SECRET}`);
  } else {
    console.log(`⚠️ Admin dashboard disabled. Set ADMIN_SECRET environment variable to enable.`);
  }
  console.log(`💰 Payment: ₹2 for 10 min female chat (modal only)`);
  console.log(`🎮 Tic-Tac-Toe: "Play Again" sends a rematch request to the partner.`);
});
