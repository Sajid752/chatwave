// ==================== server.js ====================
// Real users only. ₹2 payment for male→female.
// Admin dashboard at /admin?key=YOUR_SECRET_KEY
// Shows partner's gender on connection (not your own)

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
let totalMatches = 0;                      // simple counter for matches created

function isPremiumActive(sessionId) {
  const expiry = userPremiums.get(sessionId);
  return expiry && expiry > Date.now();
}

function createRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

// Match two real users from the waiting queue
function tryMatchRealUsers() {
  if (waitingQueue.length < 2) return false;
  const userA = waitingQueue.shift();
  const userB = waitingQueue.shift();
  if (!userA || !userB) return false;
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
    userPremiums.set(sessionId, Date.now() + 30 * 60 * 1000);
    // Save payment record
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
    res.json({ success: true, message: 'Premium activated' });
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
  for (let [id, time] of activeSessions.entries()) if (Date.now() - time > 60000) activeSessions.delete(id);
  const realCount = activeSessions.size;
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

  const existingIndex = waitingQueue.indexOf(sessionId);
  if (existingIndex !== -1) waitingQueue.splice(existingIndex, 1);
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
    setTimeout(() => {
      chatMessages.delete(roomId);
      chatEnded.delete(roomId);
      typingStatus.delete(roomId);
    }, 60000);
  }
  const idx = waitingQueue.indexOf(sessionId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
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
      const partnerChat = activeChats.get(chat.partnerSessionId);
      if (partnerChat) activeChats.delete(chat.partnerSessionId);
    }
    activeChats.delete(sessionId);
    setTimeout(() => {
      chatMessages.delete(roomId);
      chatEnded.delete(roomId);
      typingStatus.delete(roomId);
    }, 60000);
  }
  const idx = waitingQueue.indexOf(sessionId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
  res.json({ success: true });
});

// ---------- Admin API endpoints (protected) ----------
function adminAuth(req, res, next) {
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const now = Date.now();
  const activeUsers = Array.from(activeSessions.values()).filter(t => now - t < 60000).length;
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalPayments = payments.length;
  // Last 7 days payments
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dayStr = date.toISOString().split('T')[0];
    const dayPayments = payments.filter(p => p.date.split('T')[0] === dayStr);
    last7Days.push({
      date: dayStr,
      count: dayPayments.length,
      amount: dayPayments.reduce((s, p) => s + p.amount, 0)
    });
  }
  res.json({
    success: true,
    activeUsers,
    totalMatches,
    totalRevenue,
    totalPayments,
    last7Days,
    recentPayments: payments.slice(-10).reverse()
  });
});

// Admin dashboard HTML (same as before)
app.get('/admin', (req, res) => {
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).send('Unauthorized. Provide ?key=YOUR_SECRET');
  }
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatWave Admin Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: monospace; background: #f1f5f9; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 20px; margin-bottom: 30px; }
        .card { background: white; border-radius: 16px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .card h3 { margin: 0 0 8px 0; color: #475569; font-size: 0.9rem; }
        .card .value { font-size: 2rem; font-weight: bold; color: #1e293b; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { background: #f8fafc; font-weight: 600; }
        .chart-container { margin-top: 30px; background: white; padding: 20px; border-radius: 16px; }
        canvas { max-height: 300px; }
        .refresh { margin-bottom: 20px; }
        button { background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 40px; cursor: pointer; }
    </style>
</head>
<body>
<div class="container">
    <h1>📊 ChatWave Admin Dashboard</h1>
    <div class="refresh"><button onclick="loadData()">⟳ Refresh</button></div>
    <div class="stats" id="stats"></div>
    <div class="chart-container"><canvas id="dailyChart"></canvas></div>
    <h3>📋 Recent Payments</h3>
    <table id="paymentsTable">
        <thead><tr><th>Payment ID</th><th>Amount</th><th>Date & Time</th><th>Session</th></tr></thead>
        <tbody></tbody>
    </table>
</div>
<script>
    const API_BASE = '/api/admin/stats?key=${key}';
    async function loadData() {
        const res = await fetch(API_BASE);
        const data = await res.json();
        if (!data.success) return;
        document.getElementById('stats').innerHTML = \`
            <div class="card"><h3>👥 Active Users (5min)</h3><div class="value">\${data.activeUsers}</div></div>
            <div class="card"><h3>💬 Total Matches</h3><div class="value">\${data.totalMatches}</div></div>
            <div class="card"><h3>💰 Total Revenue (₹)</h3><div class="value">₹\${data.totalRevenue}</div></div>
            <div class="card"><h3>💳 Total Payments</h3><div class="value">\${data.totalPayments}</div></div>
        \`;
        const tbody = document.querySelector('#paymentsTable tbody');
        tbody.innerHTML = data.recentPayments.map(p => \`
            <tr><td>\${p.id}</td><td>₹\${p.amount}</td><td>\${new Date(p.timestamp).toLocaleString()}</td><td>\${p.sessionId.substring(0,12)}...</td></tr>
        \`).join('');
        const ctx = document.getElementById('dailyChart').getContext('2d');
        if (window.dailyChart) window.dailyChart.destroy();
        window.dailyChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.last7Days.map(d => d.date),
                datasets: [{
                    label: 'Payments (₹)',
                    data: data.last7Days.map(d => d.amount),
                    backgroundColor: '#3b82f6'
                }]
            }
        });
    }
    loadData();
    setInterval(loadData, 30000);
</script>
</body>
</html>
  `);
});

// ------------------- FRONTEND (removed self-gender badge, shows partner gender) -------------------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>ChatWave · Real Chat Only</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); min-height: 100vh; }
        .toast-container { position:fixed; top:20px; right:20px; z-index:9999; display:flex; flex-direction:column; gap:10px; }
        .toast { background:white; border-radius:12px; padding:12px 20px; box-shadow:0 10px 25px rgba(0,0,0,0.1); display:flex; align-items:center; gap:12px; border-left:4px solid #2563eb; }
        .toast.success { border-left-color:#10b981; }
        .loading-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:10000; visibility:hidden; opacity:0; transition:0.2s; }
        .loading-overlay.active { visibility:visible; opacity:1; }
        .spinner { width:50px; height:50px; border:4px solid white; border-top-color:#2563eb; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        /* First page */
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
        /* Chat page */
        .chat-page { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#ffffff; flex-direction:column; }
        .chat-page.active { display:flex; }
        .chat-header { background:white; border-bottom:1px solid #e2e8f0; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; }
        .logo { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #1e293b, #2563eb); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .header-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .active-badge { background:#f1f5f9; padding:6px 14px; border-radius:40px; font-size:0.8rem; display:flex; align-items:center; gap:8px; }
        .boost-btn { background:#f59e0b; border:none; padding:6px 16px; border-radius:40px; color:white; font-weight:600; font-size:0.8rem; cursor:pointer; display:none; }
        .boost-btn.visible { display:block; }
        .pref-selector { display:flex; align-items:center; gap:8px; background:#f1f5f9; padding:6px 14px; border-radius:40px; }
        .pref-selector label { font-weight:500; font-size:0.75rem; }
        .pref-selector select { background:white; border:1px solid #cbd5e1; border-radius:30px; padding:4px 10px; font-size:0.75rem; }
        @media (max-width: 768px) {
            .chat-header { flex-direction:column; align-items:stretch; }
            .header-right { justify-content:space-between; }
            .pref-selector { justify-content:center; }
        }
        .chat-messages { flex:1; overflow-y:auto; padding:0; display:flex; flex-direction:column; gap:8px; background:#ffffff; }
        .msg { max-width:85%; padding:10px 14px; border-radius:18px; font-size:0.9rem; margin:4px 8px; }
        .msg-in { background:#f1f5f9; align-self:flex-start; border-bottom-left-radius:4px; margin-left:12px; }
        .msg-out { background:#2563eb; color:white; align-self:flex-end; border-bottom-right-radius:4px; margin-right:12px; }
        .sys-msg { text-align:center; font-size:0.7rem; color:#64748b; margin:8px 0; padding:0 12px; }
        .typing { font-size:0.7rem; padding:4px 16px; color:#64748b; font-style:italic; min-height:28px; }
        .input-area { display:flex; gap:10px; padding:12px 16px; background:white; border-top:1px solid #e2e8f0; }
        .input-area input { flex:1; padding:12px 16px; border-radius:40px; border:1px solid #e2e8f0; font-family:inherit; font-size:0.9rem; }
        .send-btn { background:#2563eb; border:none; width:auto; padding:0 20px; border-radius:40px; color:white; font-weight:600; cursor:pointer; }
        .action-buttons { display:flex; gap:10px; padding:0 16px 16px 16px; }
        .action-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; cursor:pointer; }
        .main-action-btn { background:#2563eb; color:white; border:none; }
        .skip-btn { background:#f59e0b; color:white; border:none; }
        .main-action-btn.end { background:#ef4444; }
        .partner-info { font-size:0.8rem; color:#475569; margin-left:12px; }
        @media (max-width:700px) {
            .msg { max-width:90%; }
            .action-buttons { flex-direction:column; }
            .action-buttons button { width:100%; }
        }
    </style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Connect with real people · ₹2 payment for male→female</p></div>
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
        </div>
    </div>
    <div class="chat-messages" id="chatMsgsArea">
        <div class="sys-msg">✨ Select your preference and click "Find Partner". Only real people – no bots.</div>
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

    function showToast(msg, type) { var c=document.getElementById('toastContainer'); var t=document.createElement('div'); t.className='toast '+type; t.innerHTML='<span>'+(type==='success'?'✅':type==='error'?'❌':'ℹ️')+'</span><span>'+msg+'</span>'; c.appendChild(t); setTimeout(()=>t.remove(),4000); }
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

    async function findMatch() {
        if(chatActive) { endChat(); return; }
        var prefer = document.getElementById('chatPreferSelect').value;
        if(userGender === 'male' && prefer === 'female' && !hasPremium) {
            showToast("You need to pay ₹2 to chat with real females. Click the Boost button.", "warning");
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
        clearChatMsgs();
        // Show partner's gender in a system message
        var genderDisplay = partner.actualGender === 'male' ? 'Male' : (partner.actualGender === 'female' ? 'Female' : 'Other');
        addSystemMsg('✨ Connected with a real person (' + genderDisplay + ')! Say hello.');
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
            showToast("Your partner has left the chat.", "warning");
            endChat();
            addSystemMsg("Chat ended because your partner disconnected.");
            return;
        }
        if(res.success && res.messages && res.messages.length) {
            for(var i=0;i<res.messages.length;i++) {
                var msg = res.messages[i];
                addBubble(msg.text, 'in');
                if(msg.timestamp > lastMsgTimestamp) lastMsgTimestamp = msg.timestamp;
            }
        }
    }

    async function pollTyping() {
        if(!chatActive) return;
        var res = await apiCall('/api/get-typing', 'POST', { sessionId });
        if(res.isTyping) {
            document.getElementById('typingIndicator').innerText = 'Stranger is typing...';
        } else {
            document.getElementById('typingIndicator').innerText = '';
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
            showToast("Chat already ended.", "error");
            endChat();
        }
    }

    function addSystemMsg(t) { var area=document.getElementById('chatMsgsArea'); var div=document.createElement('div'); div.className='sys-msg'; div.innerHTML='<i class="fas fa-info-circle"></i> '+t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function addBubble(t, type) { var area=document.getElementById('chatMsgsArea'); var div=document.createElement('div'); div.className='msg '+(type==='out'?'msg-out':'msg-in'); div.innerText=t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function clearChatMsgs(keepSys){ var area=document.getElementById('chatMsgsArea'); area.innerHTML=''; if(keepSys) addSystemMsg("Chat ended. Click 'Find Partner' to start a new conversation."); }

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
        if(userGender !== 'male'){ showToast("Only male users can buy boost.",'warning'); return; }
        if(hasPremium && premiumExpiry && Date.now()<premiumExpiry){ showToast("Premium already active.",'info'); return; }
        showLoading(true);
        var res = await apiCall('/api/create-order', 'POST', { amount: 2 });
        showLoading(false);
        if(!res.success){ showToast("Failed to create order.",'error'); return; }
        var options = { key: res.key, amount: res.amount, currency: res.currency, name: "ChatWave", description: "Premium Boost (30 min)", order_id: res.orderId, handler: async function(response){
            showLoading(true);
            var verifyRes = await apiCall('/api/verify-payment', 'POST', { razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature, sessionId });
            showLoading(false);
            if(verifyRes.success){ showToast("Payment successful! Premium activated.",'success'); await checkPremium(); updateBoostButtonVisibility(); }
            else showToast("Payment verification failed.",'error');
        }, prefill: { name: "ChatWave User", email: "user@chatwave.com" }, theme: { color: "#2563eb" } };
        var rzp = new Razorpay(options);
        rzp.open();
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
        addSystemMsg("👋 Only real users! Male users: select 'Female' to see the Boost button (₹2) for real female matches.");
        document.getElementById('chatPreferSelect').addEventListener('change', updateBoostButtonVisibility);
        updateBoostButtonVisibility();
    });

    document.getElementById('mainActionBtn').onclick = findMatch;
    document.getElementById('skipChatBtn').onclick = skipChat;
    document.getElementById('sendChatMsgBtn').onclick = sendMessage;
    document.getElementById('chatMsgInput').onkeypress = function(e) { if(e.key === 'Enter') sendMessage(); };
    document.getElementById('boostHeaderBtn').onclick = openRazorpay;
    
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
  console.log(`📊 Admin dashboard at /admin?key=YOUR_ADMIN_SECRET`);
  console.log(`👤 Partner's gender is shown on connection (not your own)`);
});
