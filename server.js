// ==================== server.js ====================
// Real users only. ₹2 boost for male→female.
// Dynamic rematch cooldown based on active users.
// Tic‑Tac‑Toe game for connected users (instead of daily bonus).
// All messages appear in chatbox.

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
const activeSessions = new Map();          // sessionId -> lastSeen
const userPremiums = new Map();            // sessionId -> expiry timestamp
const userGender = new Map();              // sessionId -> 'male'|'female'|'other'
const waitingQueue = [];                   // sessionIds waiting for a partner
const activeChats = new Map();             // sessionId -> { partnerSessionId, roomId }
const chatMessages = new Map();            // roomId -> array of messages
const chatEnded = new Map();               // roomId -> boolean
const userPreferredGender = new Map();     // sessionId -> 'any'|'female'|'male'|'other'
const typingStatus = new Map();            // roomId -> { userId, timestamp }
const lastPartner = new Map();             // sessionId -> { partnerId, timestamp }
let totalMatches = 0;

// Game state per room
const gameRooms = new Map(); // roomId -> { board: Array(9), currentPlayer: 'X' or 'O', playerX: sessionId, playerO: sessionId, gameActive: bool }

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
  if (active > 20) return 120000;   // 2 minutes
  if (active >= 10) return 60000;   // 1 minute
  return 30000;                      // 30 seconds
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
    const newExpiry = Math.max(currentExpiry, Date.now()) + 30 * 60 * 1000;
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
    res.json({ success: true, message: 'Premium activated', newExpiry });
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
      return res.json({
        success: true,
        partner: { name: 'Real user', gender: partnerPref, actualGender: partnerActualGender, region: 'world', id: partnerId, isBot: false }
      });
    }
  }

  return res.json({ success: false, message: "No real users online. Please try again later." });
});

app.post('/api/typing', (req, res) => {
  const { sessionId, isTyping } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ success: false });
  const roomId = chat.roomId;
  if (isTyping) {
    typingStatus.set(roomId, { userId: sessionId, timestamp: Date.now() });
  } else {
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
  if (typing && typing.userId !== sessionId && (Date.now() - typing.timestamp) < 2500) {
    return res.json({ isTyping: true });
  }
  res.json({ isTyping: false });
});

app.post('/api/send-message', (req, res) => {
  const { sessionId, text } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.status(400).json({ success: false, message: 'No active chat' });
  const roomId = chat.roomId;
  if (chatEnded.get(roomId)) return res.status(400).json({ success: false, message: 'Chat already ended' });
  const messages = chatMessages.get(roomId) || [];
  messages.push({ from: sessionId, text, timestamp: Date.now() });
  chatMessages.set(roomId, messages);
  typingStatus.delete(roomId);

  // Handle game moves (JSON messages)
  if (text.startsWith('{') && text.includes('game_move')) {
    try {
      const data = JSON.parse(text);
      if (data.type === 'game_move') {
        const game = gameRooms.get(roomId);
        if (game && game.gameActive) {
          const isMyTurn = (game.currentPlayer === 'X' && game.playerX === sessionId) ||
                           (game.currentPlayer === 'O' && game.playerO === sessionId);
          if (isMyTurn && game.board[data.index] === '') {
            game.board[data.index] = game.currentPlayer;
            // check win/draw
            const winPatterns = [
              [0,1,2], [3,4,5], [6,7,8],
              [0,3,6], [1,4,7], [2,5,8],
              [0,4,8], [2,4,6]
            ];
            let winner = null;
            for (let pattern of winPatterns) {
              const [a,b,c] = pattern;
              if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
                winner = game.board[a];
                break;
              }
            }
            let draw = !winner && game.board.every(cell => cell !== '');
            if (winner) {
              game.gameActive = false;
              const winnerSession = winner === 'X' ? game.playerX : game.playerO;
              const loserSession = winner === 'X' ? game.playerO : game.playerX;
              messages.push({ from: 'system', text: `🎉 Game over! ${winner === 'X' ? 'You' : 'Opponent'} wins! 🎉`, timestamp: Date.now() });
              chatMessages.set(roomId, messages);
            } else if (draw) {
              game.gameActive = false;
              messages.push({ from: 'system', text: `🤝 Game ended in a draw!`, timestamp: Date.now() });
              chatMessages.set(roomId, messages);
            } else {
              game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
              // notify both clients of new board state via system message (JSON)
              const boardMsg = JSON.stringify({ type: 'game_update', board: game.board, currentPlayer: game.currentPlayer });
              messages.push({ from: 'game', text: boardMsg, timestamp: Date.now() });
              chatMessages.set(roomId, messages);
            }
          }
        }
      }
    } catch(e) { /* ignore non-JSON */ }
  }
  res.json({ success: true });
});

app.post('/api/get-messages', (req, res) => {
  const { sessionId, lastTimestamp } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ success: true, messages: [], chatEnded: true });
  const roomId = chat.roomId;
  const ended = chatEnded.get(roomId) || false;
  if (ended) {
    activeChats.delete(sessionId);
    return res.json({ success: true, messages: [], chatEnded: true });
  }
  const messages = chatMessages.get(roomId) || [];
  const newMessages = messages.filter(m => m.timestamp > (lastTimestamp || 0));
  const filtered = newMessages.filter(m => m.from !== sessionId);
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

// ---------- Admin API (same as before, omitted for brevity) ----------
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

// ------------------- FRONTEND (with Tic-Tac-Toe game) -------------------
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
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); min-height: 100vh; }
        .loading-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:10000; visibility:hidden; opacity:0; transition:0.2s; }
        .loading-overlay.active { visibility:visible; opacity:1; }
        .spinner { width:50px; height:50px; border:4px solid white; border-top-color:#2563eb; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
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
        .chat-header { background:white; border-bottom:1px solid #e2e8f0; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; }
        .logo { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #1e293b, #2563eb); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .header-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .active-badge { background:#f1f5f9; padding:6px 14px; border-radius:40px; font-size:0.8rem; display:flex; align-items:center; gap:8px; }
        .boost-btn { background:#f59e0b; border:none; padding:6px 16px; border-radius:40px; color:white; font-weight:600; font-size:0.8rem; cursor:pointer; display:none; }
        .boost-btn.visible { display:block; }
        .game-btn { background:#10b981; border:none; padding:6px 16px; border-radius:40px; color:white; font-weight:600; font-size:0.8rem; cursor:pointer; margin-left:5px; }
        .pref-selector { display:flex; align-items:center; gap:8px; background:#f1f5f9; padding:6px 14px; border-radius:40px; }
        .pref-selector label { font-weight:500; font-size:0.75rem; }
        .pref-selector select { background:white; border:1px solid #cbd5e1; border-radius:30px; padding:4px 10px; font-size:0.75rem; }
        @media (max-width: 768px) {
            .chat-header { flex-direction:column; align-items:stretch; }
            .header-right { justify-content:space-between; }
        }
        .chat-messages { flex:1; overflow-y:auto; padding:0; display:flex; flex-direction:column; gap:8px; background:#ffffff; }
        .msg { max-width:85%; padding:10px 14px; border-radius:18px; font-size:0.9rem; margin:4px 8px; }
        .msg-in { background:#f1f5f9; align-self:flex-start; border-bottom-left-radius:4px; margin-left:12px; }
        .msg-out { background:#2563eb; color:white; align-self:flex-end; border-bottom-right-radius:4px; margin-right:12px; }
        .sys-msg { text-align:center; font-size:0.75rem; color:#64748b; margin:8px 0; padding:0 12px; background:#f8fafc; border-radius:20px; width:fit-content; align-self:center; max-width:80%; }
        .game-board { display:grid; grid-template-columns:repeat(3, 80px); gap:8px; justify-content:center; margin:10px 0; background:#f8fafc; padding:15px; border-radius:16px; align-self:center; }
        .game-cell { width:80px; height:80px; background:white; border:2px solid #cbd5e1; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:2rem; font-weight:bold; cursor:pointer; transition:0.2s; }
        .game-cell:hover { background:#eef2ff; }
        .game-cell.disabled { cursor:not-allowed; opacity:0.6; }
        .typing { text-align:left; font-size:1rem; font-weight:500; font-style:italic; padding:6px 20px; color:#3b82f6; min-height:36px; animation:pulse 1.5s infinite; }
        @keyframes pulse { 0% { opacity:0.6; } 50% { opacity:1; } 100% { opacity:0.6; } }
        .input-area { display:flex; gap:10px; padding:12px 16px; background:white; border-top:1px solid #e2e8f0; }
        .input-area input { flex:1; padding:12px 16px; border-radius:40px; border:1px solid #e2e8f0; font-family:inherit; font-size:0.9rem; }
        .send-btn { background:#2563eb; border:none; width:auto; padding:0 20px; border-radius:40px; color:white; font-weight:600; cursor:pointer; }
        .action-buttons { display:flex; gap:10px; padding:0 16px 16px 16px; }
        .action-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; cursor:pointer; }
        .main-action-btn { background:#2563eb; color:white; border:none; }
        .skip-btn { background:#f59e0b; color:white; border:none; }
        .main-action-btn.end { background:#ef4444; }
        @media (max-width:700px) {
            .msg { max-width:90%; }
            .action-buttons { flex-direction:column; }
            .action-buttons button { width:100%; }
            .game-board { grid-template-columns:repeat(3, 60px); gap:6px; }
            .game-cell { width:60px; height:60px; font-size:1.5rem; }
        }
    </style>
</head>
<body>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Real people · ₹2 boost for male→female · Play games together</p></div>
        <div class="terms-content">
            <div class="rule-block"><div class="rule-title"><i class="fas fa-gavel"></i> 1. Guidelines</div><div class="rule-text">Be respectful. No harassment.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-venus-mars"></i> 2. Payment Policy</div><div class="rule-text">Male → Female: ₹2 unlocks 30min of real female matches. Female/Other: always free.</div></div>
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
        <div class="logo"><i class="fas fa-waveform"></i> ChatWave</div>
        <div class="header-right">
            <div class="pref-selector">
                <label><i class="fas fa-heart"></i> I want:</label>
                <select id="chatPreferSelect">
                    <option value="any">Anyone</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                </select>
            </div>
            <div class="active-badge"><i class="fas fa-users"></i> <span id="activeUserCount">--</span> online</div>
            <button id="boostHeaderBtn" class="boost-btn"><i class="fas fa-rupee-sign"></i> Pay ₹2 Boost</button>
            <button id="gameBtn" class="game-btn"><i class="fas fa-gamepad"></i> Play Tic-Tac-Toe</button>
        </div>
    </div>
    <div class="chat-messages" id="chatMsgsArea">
        <div class="sys-msg">✨ Select your preference and click "Find Partner". Play Tic-Tac-Toe with connected users!</div>
    </div>
    <div class="typing" id="typingIndicator"></div>
    <div class="input-area">
        <input type="text" id="chatMsgInput" placeholder="Type a message..." autocomplete="off" disabled>
        <button id="sendChatMsgBtn" class="send-btn" disabled><i class="fas fa-paper-plane"></i> Send</button>
    </div>
    <div class="action-buttons">
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
    let gameVisible = false;
    let gameBoard = null;
    let myTurn = false;
    let gameActive = false;

    function showLoading(show){ document.getElementById('loadingOverlay').classList.toggle('active',show); }

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
        updateBoostButtonVisibility();
    }
    async function getActiveUsers() { var res = await apiCall('/api/active-users', 'GET'); document.getElementById('activeUserCount').innerText = res.count; }

    function updateBoostButtonVisibility() {
        var boostBtn = document.getElementById('boostHeaderBtn');
        var prefer = document.getElementById('chatPreferSelect').value;
        if(userGender === 'male' && prefer === 'female' && !hasPremium) {
            boostBtn.classList.add('visible');
        } else {
            boostBtn.classList.remove('visible');
        }
    }

    async function startGame() {
        if(!chatActive) { addSystemMsg("You need to be connected to someone first."); return; }
        if(!gameActive) {
            // Initialize game board on client side only; server will store state only after first move
            gameBoard = Array(9).fill('');
            myTurn = true; // assume we start? Actually we need to agree who starts. Simpler: first to click starts.
            renderGameBoard();
            gameActive = true;
            addSystemMsg("🎮 You started a Tic-Tac-Toe game! Click on a cell to make your move.");
            // Send game start notification
            var gameMsg = JSON.stringify({ type: 'game_start' });
            await apiCall('/api/send-message', 'POST', { sessionId, text: gameMsg });
        } else {
            addSystemMsg("Game already active. Finish or end chat to start new.");
        }
    }

    function renderGameBoard() {
        var oldBoard = document.getElementById('gameBoard');
        if(oldBoard) oldBoard.remove();
        var container = document.getElementById('chatMsgsArea');
        var boardDiv = document.createElement('div');
        boardDiv.id = 'gameBoard';
        boardDiv.className = 'game-board';
        for(var i=0;i<9;i++) {
            var cell = document.createElement('div');
            cell.className = 'game-cell';
            if(!gameActive || !myTurn || gameBoard[i] !== '') cell.classList.add('disabled');
            cell.innerText = gameBoard[i];
            cell.onclick = (function(idx) { return function() { makeMove(idx); }; })(i);
            boardDiv.appendChild(cell);
        }
        container.appendChild(boardDiv);
        boardDiv.scrollIntoView({behavior:'smooth'});
    }

    async function makeMove(index) {
        if(!chatActive || !gameActive || !myTurn) return;
        if(gameBoard[index] !== '') return;
        gameBoard[index] = myTurn ? 'X' : 'O'; // but we need consistent symbol assignment
        // Actually we need to know if we are X or O. Let's simplify: first player to move is X.
        // We'll store player symbol in a variable.
        if(typeof mySymbol === 'undefined') {
            mySymbol = 'X';
            opponentSymbol = 'O';
        }
        gameBoard[index] = mySymbol;
        renderGameBoard();
        myTurn = false;
        // Send move via chat message
        var moveMsg = JSON.stringify({ type: 'game_move', index: index });
        await apiCall('/api/send-message', 'POST', { sessionId, text: moveMsg });
        // Check win/draw locally (server will also handle)
        checkGameStatus();
    }

    function checkGameStatus() {
        // We'll rely on server messages for game over; but we can do quick check
        // Not needed, will be updated via system messages.
    }

    function handleGameMessage(data) {
        if(data.type === 'game_move') {
            // Opponent move
            if(gameActive && !myTurn) {
                gameBoard[data.index] = opponentSymbol;
                renderGameBoard();
                myTurn = true;
                addSystemMsg("Your turn!");
            }
        } else if(data.type === 'game_update') {
            // Full board update from server (after move)
            gameBoard = data.board;
            myTurn = (data.currentPlayer === 'X' && mySymbol === 'X') || (data.currentPlayer === 'O' && mySymbol === 'O');
            renderGameBoard();
        } else if(data.type === 'game_start') {
            // Opponent started game
            if(!gameActive) {
                gameActive = true;
                mySymbol = 'O';
                opponentSymbol = 'X';
                myTurn = false;
                gameBoard = Array(9).fill('');
                renderGameBoard();
                addSystemMsg("🎮 Opponent started a Tic-Tac-Toe game! It's their turn.");
            }
        }
    }

    async function findMatch() {
        if(chatActive) { endChat(); return; }
        var prefer = document.getElementById('chatPreferSelect').value;
        if(userGender === 'male' && prefer === 'female' && !hasPremium) {
            addSystemMsg("⚠️ You need to pay ₹2 to chat with real females. Click the Boost button.");
            return;
        }
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
        clearChatMsgs();
        var genderDisplay = partner.actualGender === 'male' ? 'Male' : (partner.actualGender === 'female' ? 'Female' : 'Other');
        addSystemMsg('✨ Connected with a real person (' + genderDisplay + ')! Say hello or play Tic-Tac-Toe!');
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
                    addSystemMsg(msg.text);
                } else if(msg.from === 'game') {
                    try {
                        var data = JSON.parse(msg.text);
                        handleGameMessage(data);
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
        div.scrollIntoView({behavior:'smooth'}); 
    }
    function addBubble(t, type) { 
        var area = document.getElementById('chatMsgsArea'); 
        var div = document.createElement('div'); 
        div.className = 'msg ' + (type === 'out' ? 'msg-out' : 'msg-in'); 
        div.innerText = t; 
        area.appendChild(div); 
        div.scrollIntoView({behavior:'smooth'}); 
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

    async function openRazorpay() {
        if(userGender !== 'male'){ addSystemMsg("Only male users can buy boost."); return; }
        if(hasPremium && premiumExpiry && Date.now()<premiumExpiry){ addSystemMsg("Premium already active."); return; }
        showLoading(true);
        var res = await apiCall('/api/create-order', 'POST', { amount: 2 });
        showLoading(false);
        if(!res.success){ addSystemMsg("Failed to create order."); return; }
        var options = { key: res.key, amount: res.amount, currency: res.currency, name: "ChatWave", description: "Premium Boost (30 min)", order_id: res.orderId, handler: async function(response){
            showLoading(true);
            var verifyRes = await apiCall('/api/verify-payment', 'POST', { razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature, sessionId });
            showLoading(false);
            if(verifyRes.success){ 
                addSystemMsg("✅ Payment successful! Premium activated for 30 minutes.");
                await checkPremium(); 
                updateBoostButtonVisibility(); 
            } else {
                addSystemMsg("Payment verification failed.");
            }
        }, prefill: { name: "ChatWave User", email: "user@chatwave.com" }, theme: { color: "#2563eb" } };
        var rzp = new Razorpay(options);
        rzp.open();
    }

    // Page transitions
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
        addSystemMsg("👋 Only real users! Male users: select 'Female' to see the Boost button (₹2). Play Tic-Tac-Toe with your partner!");
        document.getElementById('chatPreferSelect').addEventListener('change', updateBoostButtonVisibility);
        updateBoostButtonVisibility();
    });

    document.getElementById('mainActionBtn').onclick = findMatch;
    document.getElementById('skipChatBtn').onclick = skipChat;
    document.getElementById('sendChatMsgBtn').onclick = sendMessage;
    document.getElementById('chatMsgInput').onkeypress = function(e) { if(e.key === 'Enter') sendMessage(); };
    document.getElementById('boostHeaderBtn').onclick = openRazorpay;
    document.getElementById('gameBtn').onclick = startGame;
    
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
  console.log(`💰 Payment amount: ₹2 (male→female boost)`);
  console.log(`🎮 Tic-Tac-Toe game integrated for connected users`);
});
