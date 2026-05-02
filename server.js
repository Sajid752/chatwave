// ==================== server.js ====================
// Real users only. ₹2 boost for male→female.
// Fixed re‑matching bug: users will not reconnect to the same person immediately.
// Typing indicator: larger, italic, with subtle animation.
// Engagement: Daily Lucky Spin (free premium minutes) – users can spin once every 12 hours.
// Admin dashboard at /admin?key=YOUR_SECRET_KEY

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

const SPINS_FILE = path.join(__dirname, 'spins.json');
let spins = {};
if (fs.existsSync(SPINS_FILE)) {
  try {
    spins = JSON.parse(fs.readFileSync(SPINS_FILE, 'utf8'));
  } catch(e) {}
}
function saveSpin(sessionId, lastSpin, freePremiumExpiry) {
  spins[sessionId] = { lastSpin, freePremiumExpiry };
  fs.writeFileSync(SPINS_FILE, JSON.stringify(spins, null, 2));
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
const lastPartner = new Map();             // sessionId -> { partnerId, timestamp } (to avoid immediate rematch)
let totalMatches = 0;

function isPremiumActive(sessionId) {
  const expiry = userPremiums.get(sessionId);
  return expiry && expiry > Date.now();
}

function createRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

// Remove a user from waiting queue if present
function removeFromQueue(sessionId) {
  const idx = waitingQueue.indexOf(sessionId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

// Match two real users from the waiting queue
function tryMatchRealUsers() {
  if (waitingQueue.length < 2) return false;
  const userA = waitingQueue.shift();
  const userB = waitingQueue.shift();
  if (!userA || !userB) return false;

  // Check if they recently chatted (to avoid immediate rematch)
  const lastA = lastPartner.get(userA);
  const lastB = lastPartner.get(userB);
  if (lastA && lastA.partnerId === userB && (Date.now() - lastA.timestamp) < 60000) {
    // They just ended chat within 60 seconds – put them back and try different
    waitingQueue.push(userA);
    waitingQueue.push(userB);
    return false;
  }
  if (lastB && lastB.partnerId === userA && (Date.now() - lastB.timestamp) < 60000) {
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
    userPremiums.set(sessionId, Date.now() + 30 * 60 * 1000);
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

app.post('/api/lucky-spin', (req, res) => {
  const { sessionId } = req.body;
  const spinData = spins[sessionId] || { lastSpin: 0, freePremiumExpiry: 0 };
  const now = Date.now();
  const hoursSinceLastSpin = (now - spinData.lastSpin) / (1000 * 60 * 60);
  if (spinData.lastSpin && hoursSinceLastSpin < 12) {
    return res.json({ success: false, message: `Come back in ${Math.ceil(12 - hoursSinceLastSpin)} hours`, canSpin: false });
  }
  // Random win: 10% chance to win 30 min premium, 30% chance 10 min, 60% nothing
  const rand = Math.random();
  let winMinutes = 0;
  let message = '';
  if (rand < 0.1) {
    winMinutes = 30;
    message = '🎉 Lucky you! You won 30 minutes of free premium! 🎉';
  } else if (rand < 0.4) {
    winMinutes = 10;
    message = '🍀 Congratulations! You won 10 minutes of free premium! 🍀';
  } else {
    message = '😔 Better luck next time! Spin again after 12 hours.';
  }
  if (winMinutes > 0) {
    const currentExpiry = userPremiums.get(sessionId) || 0;
    const newExpiry = Math.max(currentExpiry, now) + winMinutes * 60 * 1000;
    userPremiums.set(sessionId, newExpiry);
    spinData.freePremiumExpiry = newExpiry;
  }
  spinData.lastSpin = now;
  spins[sessionId] = spinData;
  fs.writeFileSync(SPINS_FILE, JSON.stringify(spins, null, 2));
  res.json({ success: true, winMinutes, message });
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
      // Record last partner for both sides to avoid immediate rematch
      lastPartner.set(sessionId, { partnerId, timestamp: Date.now() });
      lastPartner.set(partnerId, { partnerId: sessionId, timestamp: Date.now() });
    }
    activeChats.delete(sessionId);
    setTimeout(() => {
      chatMessages.delete(roomId);
      chatEnded.delete(roomId);
      typingStatus.delete(roomId);
    }, 60000);
  }
  removeFromQueue(sessionId);
  res.json({ success: true });
});

// ---------- Admin endpoints (unchanged, shortened for brevity) ----------
function adminAuth(req, res, next) {
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const now = Date.now();
  const activeUsers = Array.from(activeSessions.values()).filter(t => now - t < 60000).length;
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

// ------------------- FRONTEND (with bigger typing indicator and lucky spin button) -------------------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>ChatWave · Real Chat</title>
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
        .spin-btn { background:#10b981; border:none; padding:6px 16px; border-radius:40px; color:white; font-weight:600; font-size:0.8rem; cursor:pointer; margin-left:5px; }
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
        .sys-msg { text-align:center; font-size:0.7rem; color:#64748b; margin:8px 0; padding:0 12px; }
        .typing { text-align:left; font-size:1rem; font-weight:500; font-style:italic; padding:6px 20px; color:#3b82f6; min-height:36px; letter-spacing:0.3px; animation:pulse 1.5s infinite; }
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
        }
    </style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Real people · ₹2 boost for male→female · Daily lucky spin</p></div>
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
            <button id="spinBtn" class="spin-btn"><i class="fas fa-gift"></i> Lucky Spin</button>
        </div>
    </div>
    <div class="chat-messages" id="chatMsgsArea">
        <div class="sys-msg">✨ Select your preference and click "Find Partner". Spin daily for free premium!</div>
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

    async function luckySpin() {
        showLoading(true);
        var res = await apiCall('/api/lucky-spin', 'POST', { sessionId });
        showLoading(false);
        if(res.success) {
            if(res.winMinutes > 0) {
                showToast(res.message, 'success');
                await checkPremium();
            } else {
                showToast(res.message, 'info');
            }
        } else {
            showToast(res.message, 'warning');
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
        addSystemMsg("👋 Only real users! Male users: select 'Female' to see the Boost button (₹2). Click Lucky Spin for free premium!");
        document.getElementById('chatPreferSelect').addEventListener('change', updateBoostButtonVisibility);
        updateBoostButtonVisibility();
    });

    document.getElementById('mainActionBtn').onclick = findMatch;
    document.getElementById('skipChatBtn').onclick = skipChat;
    document.getElementById('sendChatMsgBtn').onclick = sendMessage;
    document.getElementById('chatMsgInput').onkeypress = function(e) { if(e.key === 'Enter') sendMessage(); };
    document.getElementById('boostHeaderBtn').onclick = openRazorpay;
    document.getElementById('spinBtn').onclick = luckySpin;
    
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
  console.log(`🎁 Lucky spin: users can win free premium every 12 hours.`);
});
