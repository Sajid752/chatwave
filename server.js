// ==================== server.js ====================
// Full‑screen design, preference modal, ₹2 payment.
// First page: no borders, full viewport, centered.
// Chat page: only chat panel (100% width), modal for preferences.

const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_SjkRHBxR35ls58';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'nVBr3LEjVAtLM3MfdJrKx3KY';
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

app.use(cors());
app.use(express.json());

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

function isPremiumActive(sessionId) {
  const expiry = userPremiums.get(sessionId);
  return expiry && expiry > Date.now();
}

function createRoomId() {
  return 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

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
  res.json({ success: true, count: activeSessions.size + Math.floor(Math.random() * 100) + 50 });
});

app.post('/api/find-match', (req, res) => {
  const { prefer, sessionId, userGender: gender } = req.body;
  userPreferredGender.set(sessionId, prefer);
  if (gender) userGender.set(sessionId, gender);

  const myGender = userGender.get(sessionId);
  const hasPrem = isPremiumActive(sessionId);
  if (myGender === 'male' && prefer === 'female' && !hasPrem) {
    return res.json({ success: false, message: "You need to pay ₹2 to chat with females. Please purchase the boost." });
  }

  const existingChat = activeChats.get(sessionId);
  if (existingChat && existingChat.partnerSessionId) {
    const roomEnded = chatEnded.get(existingChat.roomId);
    if (roomEnded) {
      activeChats.delete(sessionId);
    } else {
      const partnerId = existingChat.partnerSessionId;
      const partnerPref = userPreferredGender.get(partnerId) || 'any';
      return res.json({
        success: true,
        partner: { name: 'Real user', gender: partnerPref, region: 'world', id: partnerId, isBot: false }
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
      return res.json({
        success: true,
        partner: { name: 'Real user', gender: partnerPref, region: 'world', id: partnerId, isBot: false }
      });
    }
  }
  return res.json({ success: false, message: "No real users available. Please try again later." });
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
      return res.json({
        success: true,
        partner: { name: 'Real user', gender: partnerPref, region: 'world', id: partnerId, isBot: false }
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

// ---------- FRONTEND (full‑screen first page, modal preference, ₹2) ----------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>ChatWave · Real Friends Chat</title>
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
        
        /* First page: full viewport, no borders, content centered */
        .page { min-height:100vh; width:100%; display:flex; align-items:center; justify-content:center; position:fixed; top:0; left:0; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); }
        .terms-container { max-width:500px; width:90%; background:white; padding:32px 28px; border-radius:0; box-shadow:none; animation:fadeIn 0.4s ease; text-align:center; }
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
        
        /* Chat page: full‑screen chat panel only (no side panel) */
        .chat-page { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#ffffff; }
        .chat-page.active { display:flex; flex-direction:column; }
        .chat-header { background:white; border-bottom:1px solid #e2e8f0; padding:12px 24px; display:flex; justify-content:space-between; align-items:center; }
        .logo-small { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #1e293b, #2563eb); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .active-badge { background:#f1f5f9; padding:6px 14px; border-radius:40px; font-size:0.8rem; display:flex; align-items:center; gap:8px; }
        .chat-messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:10px; background:#ffffff; }
        .msg { max-width:80%; padding:10px 16px; border-radius:18px; font-size:0.9rem; }
        .msg-in { background:#f1f5f9; align-self:flex-start; border-bottom-left-radius:4px; }
        .msg-out { background:#2563eb; color:white; align-self:flex-end; border-bottom-right-radius:4px; }
        .sys-msg { text-align:center; font-size:0.7rem; color:#64748b; margin:4px 0; }
        .typing { font-size:0.7rem; padding-left:20px; color:#64748b; font-style:italic; min-height:24px; }
        .input-area { display:flex; gap:10px; padding:16px 20px; background:white; border-top:1px solid #e2e8f0; }
        .input-area input { flex:1; padding:12px 18px; border-radius:40px; border:1px solid #e2e8f0; font-family:inherit; font-size:0.9rem; }
        .send-btn { background:#2563eb; border:none; width:auto; padding:0 24px; border-radius:40px; color:white; font-weight:600; cursor:pointer; }
        .action-buttons { display:flex; gap:10px; padding:0 20px 16px 20px; }
        .action-buttons button { flex:1; padding:12px; border-radius:40px; font-weight:600; cursor:pointer; }
        .main-action-btn { background:#2563eb; color:white; border:none; }
        .skip-btn { background:#f59e0b; color:white; border:none; }
        .main-action-btn.end { background:#ef4444; }
        
        /* Premium modal for preference selection */
        .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(6px); display:none; align-items:center; justify-content:center; z-index:2000; }
        .modal-overlay.active { display:flex; }
        .premium-modal { background:white; border-radius:24px; max-width:400px; width:90%; padding:28px 24px; text-align:center; box-shadow:0 40px 60px rgba(0,0,0,0.3); }
        .premium-modal h3 { font-size:1.6rem; margin-bottom:8px; color:#1e293b; }
        .premium-modal p { color:#475569; margin-bottom:20px; }
        .preference-options { display:flex; flex-direction:column; gap:12px; margin:20px 0; }
        .pref-option { display:flex; align-items:center; gap:12px; padding:12px 16px; background:#f8fafc; border-radius:16px; cursor:pointer; border:1px solid #e2e8f0; transition:0.2s; }
        .pref-option.selected { border-color:#2563eb; background:#eef2ff; }
        .pref-option i { font-size:1.2rem; width:28px; color:#2563eb; }
        .pref-option span { flex:1; font-weight:500; }
        .confirm-pref-btn { background:#2563eb; color:white; border:none; padding:14px; border-radius:40px; width:100%; font-weight:600; margin-top:12px; cursor:pointer; }
        @media (max-width:700px) { .msg { max-width:90%; } .action-buttons { flex-direction:column; } .action-buttons button { width:100%; } }
    </style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<!-- First page (terms & gender) -->
<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header">
            <h1><i class="fas fa-waveform"></i> ChatWave</h1>
            <p>Real chat · Real friends · ₹2 payments</p>
        </div>
        <div class="terms-content">
            <div class="rule-block"><div class="rule-title"><i class="fas fa-gavel"></i> 1. Guidelines</div><div class="rule-text">Be respectful. No harassment.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-venus-mars"></i> 2. Payment Policy</div><div class="rule-text">Male → Female: ₹2 unlocks 100% match chance. Female/Other: always free.</div></div>
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

<!-- Chat page (full screen, no side panel) -->
<div id="page2" class="chat-page">
    <div class="chat-header">
        <div class="logo-small"><i class="fas fa-waveform"></i> ChatWave</div>
        <div class="active-badge"><i class="fas fa-users"></i> <span id="activeUserCount">--</span> active</div>
    </div>
    <div class="chat-messages" id="chatMsgsArea">
        <div class="sys-msg">✨ Welcome! Set your chat preference to start.</div>
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

<!-- Premium modal for chat preference -->
<div id="prefModal" class="modal-overlay">
    <div class="premium-modal">
        <i class="fas fa-heart" style="font-size:2rem; color:#2563eb;"></i>
        <h3>Choose who you want to chat with</h3>
        <p>Select your preference to continue</p>
        <div class="preference-options">
            <div class="pref-option" data-pref="any">
                <i class="fas fa-globe"></i>
                <span>✨ Anyone (Random)</span>
            </div>
            <div class="pref-option" data-pref="female">
                <i class="fas fa-female"></i>
                <span>👩 Female only</span>
            </div>
            <div class="pref-option" data-pref="male">
                <i class="fas fa-male"></i>
                <span>👨 Male only</span>
            </div>
            <div class="pref-option" data-pref="other">
                <i class="fas fa-genderless"></i>
                <span>🌈 Other only</span>
            </div>
        </div>
        <button id="confirmPrefBtn" class="confirm-pref-btn">Confirm Preference</button>
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
    let selectedPreference = null;

    // DOM elements
    const page1 = document.getElementById('page1');
    const page2 = document.getElementById('page2');
    const prefModal = document.getElementById('prefModal');
    const prefOptions = document.querySelectorAll('.pref-option');
    const confirmPrefBtn = document.getElementById('confirmPrefBtn');
    const mainActionBtn = document.getElementById('mainActionBtn');
    const skipChatBtn = document.getElementById('skipChatBtn');
    const sendBtn = document.getElementById('sendChatMsgBtn');
    const msgInput = document.getElementById('chatMsgInput');
    const activeUserSpan = document.getElementById('activeUserCount');

    function showToast(msg, type='info') { 
        const c=document.getElementById('toastContainer'); 
        const t=document.createElement('div'); 
        t.className='toast '+type; 
        t.innerHTML='<span>'+(type==='success'?'✅':type==='error'?'❌':'ℹ️')+'</span><span>'+msg+'</span>'; 
        c.appendChild(t); 
        setTimeout(()=>t.remove(),4000); 
    }
    function showLoading(show){ document.getElementById('loadingOverlay').classList.toggle('active',show); }

    async function apiCall(endpoint, method, data) {
        const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId } };
        if(data) opts.body = JSON.stringify(data);
        const res = await fetch(API_BASE+endpoint, opts);
        return res.json();
    }

    async function checkPremium() { 
        const res = await apiCall('/api/check-premium', 'POST', { sessionId }); 
        hasPremium = res.hasPremium; 
        premiumExpiry = res.expiry; 
    }
    async function getActiveUsers() { 
        const res = await apiCall('/api/active-users', 'GET'); 
        activeUserSpan.innerText = res.count; 
    }

    async function findMatch() {
        if(chatActive) { endChat(); return; }
        if(!selectedPreference) { 
            showToast("Please set your chat preference first.", "warning");
            prefModal.classList.add('active');
            return;
        }
        // If male seeking female and no premium, prompt payment
        if(userGender === 'male' && selectedPreference === 'female' && !hasPremium) {
            showToast("You need to pay ₹2 to chat with females. Please purchase the boost.", "warning");
            openRazorpay();
            return;
        }
        showLoading(true);
        const res = await apiCall('/api/find-match', 'POST', {
            prefer: selectedPreference,
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
        const res = await apiCall('/api/skip-chat', 'POST', { sessionId });
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
        addSystemMsg('✨ Connected with a real person! Say hello.');
        updateChatUI();
        lastMsgTimestamp = Date.now();
        if(msgInterval) clearInterval(msgInterval);
        msgInterval = setInterval(pollMessages, 1500);
        if(typingInterval) clearInterval(typingInterval);
        typingInterval = setInterval(pollTyping, 2000);
        msgInput.value = '';
        msgInput.disabled = false;
        sendBtn.disabled = false;
        msgInput.focus();
        mainActionBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat';
        mainActionBtn.classList.add('end');
    }

    async function pollMessages() {
        if(!chatActive) return;
        const res = await apiCall('/api/get-messages', 'POST', { sessionId, lastTimestamp: lastMsgTimestamp });
        if(res.chatEnded) {
            showToast("Your partner has left the chat.", "warning");
            endChat();
            addSystemMsg("Chat ended because your partner disconnected.");
            return;
        }
        if(res.success && res.messages && res.messages.length) {
            for(let msg of res.messages) {
                addBubble(msg.text, 'in');
                if(msg.timestamp > lastMsgTimestamp) lastMsgTimestamp = msg.timestamp;
            }
        }
    }

    async function pollTyping() {
        if(!chatActive) return;
        const res = await apiCall('/api/get-typing', 'POST', { sessionId });
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
        const text = msgInput.value.trim();
        if(!text) return;
        addBubble(text, 'out');
        msgInput.value = '';
        if(typingTimeout) clearTimeout(typingTimeout);
        await sendTyping(false);
        const res = await apiCall('/api/send-message', 'POST', { sessionId, text });
        if(!res.success && res.message === 'Chat already ended') {
            showToast("Chat already ended.", "error");
            endChat();
        }
    }

    function addSystemMsg(t) { 
        const area = document.getElementById('chatMsgsArea'); 
        const div = document.createElement('div'); 
        div.className = 'sys-msg'; 
        div.innerHTML = '<i class="fas fa-info-circle"></i> '+t; 
        area.appendChild(div); 
        div.scrollIntoView({behavior:'smooth'}); 
    }
    function addBubble(t, type) { 
        const area = document.getElementById('chatMsgsArea'); 
        const div = document.createElement('div'); 
        div.className = 'msg '+(type==='out'?'msg-out':'msg-in'); 
        div.innerText = t; 
        area.appendChild(div); 
        div.scrollIntoView({behavior:'smooth'}); 
    }
    function clearChatMsgs(keepSys){ 
        const area = document.getElementById('chatMsgsArea'); 
        area.innerHTML = ''; 
        if(keepSys) addSystemMsg("Chat ended. Click 'Find Partner' to start a new conversation."); 
    }

    function updateChatUI() {
        if(chatActive && activePartner) {
            mainActionBtn.innerHTML = '<i class="fas fa-stop"></i> End Chat';
            mainActionBtn.classList.add('end');
            sendBtn.disabled = false;
            msgInput.disabled = false;
        } else {
            mainActionBtn.innerHTML = '<i class="fas fa-random"></i> Find Partner';
            mainActionBtn.classList.remove('end');
            sendBtn.disabled = true;
            msgInput.disabled = true;
        }
    }

    // Preference modal logic
    prefOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            prefOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            selectedPreference = opt.getAttribute('data-pref');
        });
    });
    confirmPrefBtn.addEventListener('click', () => {
        if(!selectedPreference) {
            showToast("Please select a preference.", "warning");
            return;
        }
        prefModal.classList.remove('active');
        addSystemMsg("Preference set: " + (selectedPreference === 'any' ? 'Anyone' : selectedPreference === 'female' ? 'Female only' : selectedPreference === 'male' ? 'Male only' : 'Other only'));
        // Also store for later use – already in variable
    });

    async function openRazorpay() {
        if(userGender !== 'male'){ showToast("Only male users can buy boost.",'warning'); return; }
        if(hasPremium && premiumExpiry && Date.now()<premiumExpiry){ showToast("Premium already active.",'info'); return; }
        showLoading(true);
        const res = await apiCall('/api/create-order', 'POST', { amount: 2 });
        showLoading(false);
        if(!res.success){ showToast("Failed to create order.",'error'); return; }
        const options = { 
            key: res.key, 
            amount: res.amount, 
            currency: res.currency, 
            name: "ChatWave", 
            description: "Premium Boost (30 min) - ₹2", 
            order_id: res.orderId, 
            handler: async function(response){
                showLoading(true);
                const verifyRes = await apiCall('/api/verify-payment', 'POST', { 
                    razorpay_order_id: response.razorpay_order_id, 
                    razorpay_payment_id: response.razorpay_payment_id, 
                    razorpay_signature: response.razorpay_signature, 
                    sessionId 
                });
                showLoading(false);
                if(verifyRes.success){ 
                    showToast("Payment successful! Premium activated for 30 min.",'success'); 
                    await checkPremium(); 
                } else showToast("Payment verification failed.",'error');
            }, 
            prefill: { name: "ChatWave User", email: "user@chatwave.com" }, 
            theme: { color: "#2563eb" } 
        };
        const rzp = new Razorpay(options);
        rzp.open();
    }

    // First page logic
    const acceptCheck = document.getElementById('acceptTerms');
    const goBtn = document.getElementById('goToChatBtn');
    const genderOptions = document.querySelectorAll('.gender-option');
    const genderError = document.getElementById('genderError');
    let selectedGender = null;

    genderOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            genderOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            const radio = opt.querySelector('input');
            radio.checked = true;
            selectedGender = radio.value;
            genderError.innerText = '';
            validateForm();
        });
    });

    function validateForm() {
        const termsChecked = acceptCheck.checked;
        if(selectedGender && termsChecked) goBtn.disabled = false;
        else goBtn.disabled = true;
    }
    acceptCheck.addEventListener('change', validateForm);

    goBtn.addEventListener('click', async () => {
        if(!selectedGender) { genderError.innerText = 'Please select your gender'; return; }
        if(!acceptCheck.checked) return;
        userGender = selectedGender;
        localStorage.setItem('userGender', userGender);
        page1.style.display = 'none';
        page2.classList.add('active');
        await checkPremium();
        getActiveUsers();
        if(activePolling) clearInterval(activePolling);
        activePolling = setInterval(getActiveUsers, 10000);
        addSystemMsg("👋 Welcome! First, set your chat preference using the button or the modal that appears.");
        // Show preference modal immediately
        prefModal.classList.add('active');
    });

    // Event listeners
    mainActionBtn.onclick = findMatch;
    skipChatBtn.onclick = skipChat;
    sendBtn.onclick = sendMessage;
    msgInput.onkeypress = (e) => { if(e.key === 'Enter') sendMessage(); };
    msgInput.addEventListener('input', () => {
        if(!chatActive) return;
        const currentlyTyping = msgInput.value.length > 0;
        if(currentlyTyping && !isTyping) { isTyping = true; sendTyping(true); }
        else if(!currentlyTyping && isTyping) { isTyping = false; sendTyping(false); }
        if(typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if(isTyping && chatActive) { isTyping = false; sendTyping(false); }
        }, 2000);
    });

    // Also add a floating button to change preference later? (optional: can re‑open modal if needed)
    // For simplicity we'll keep modal accessible via an extra message, but not required.
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(htmlTemplate));
app.get('/*splat', (req, res) => res.send(htmlTemplate));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ChatWave server running on http://localhost:${PORT}`);
  console.log(`🎨 First page: full‑screen, no borders, centered.`);
  console.log(`💬 Chat page: full‑width chat area, preference modal on start.`);
  console.log(`💰 Payment amount changed to ₹2.`);
});
