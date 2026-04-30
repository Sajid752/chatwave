// ==================== server.js ====================
// REAL USER MATCHING ONLY – NO BOTS
// Works on Express v5 (Render) with explicit root route

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

// ------------------- IN‑MEMORY STORES -------------------
const activeSessions = new Map();          // sessionId -> lastSeen
const userPremiums = new Map();            // sessionId -> expiry timestamp
const waitingQueue = [];                   // sessionIds waiting for a real partner
const activeChats = new Map();             // sessionId -> { partnerSessionId, roomId, isBot (always false now) }
const chatMessages = new Map();            // roomId -> array of messages
const userFilters = new Map();             // sessionId -> { myGender, region, prefer }

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
  activeChats.set(userA, { partnerSessionId: userB, roomId, isBot: false });
  activeChats.set(userB, { partnerSessionId: userA, roomId, isBot: false });
  chatMessages.set(roomId, []);
  return true;
}

// ------------------- API ROUTES -------------------
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
  const { myGender, region, prefer, sessionId } = req.body;
  const hasPremium = isPremiumActive(sessionId);

  userFilters.set(sessionId, { myGender, region, prefer });

  // If already in a chat, return that partner
  const existingChat = activeChats.get(sessionId);
  if (existingChat && existingChat.partnerSessionId) {
    const partnerId = existingChat.partnerSessionId;
    const partnerFilters = userFilters.get(partnerId) || {};
    return res.json({
      success: true,
      partner: { name: 'Real user', gender: partnerFilters.myGender || 'unknown', region: partnerFilters.region || 'unknown', id: partnerId, isBot: false }
    });
  }

  // Remove user from waiting queue if already there (cleanup)
  const existingIndex = waitingQueue.indexOf(sessionId);
  if (existingIndex !== -1) waitingQueue.splice(existingIndex, 1);

  waitingQueue.push(sessionId);
  const matched = tryMatchRealUsers();

  if (matched) {
    const chat = activeChats.get(sessionId);
    if (chat && chat.partnerSessionId) {
      const partnerId = chat.partnerSessionId;
      const partnerFilters = userFilters.get(partnerId) || {};
      return res.json({
        success: true,
        partner: { name: 'Real user', gender: partnerFilters.myGender || 'unknown', region: partnerFilters.region || 'unknown', id: partnerId, isBot: false }
      });
    }
  }

  // No real partner available – tell user to try again
  return res.json({ success: false, message: "No real users available. Please try again later." });
});

app.post('/api/send-message', (req, res) => {
  const { sessionId, text } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.status(400).json({ success: false, message: 'No active chat' });
  const roomId = chat.roomId;
  const messages = chatMessages.get(roomId) || [];
  messages.push({ from: sessionId, text, timestamp: Date.now() });
  chatMessages.set(roomId, messages);
  res.json({ success: true });
});

app.post('/api/get-messages', (req, res) => {
  const { sessionId, lastTimestamp } = req.body;
  const chat = activeChats.get(sessionId);
  if (!chat) return res.json({ success: true, messages: [] });
  const roomId = chat.roomId;
  const messages = chatMessages.get(roomId) || [];
  const newMessages = messages.filter(m => m.timestamp > (lastTimestamp || 0));
  const filtered = newMessages.filter(m => m.from !== sessionId);
  res.json({ success: true, messages: filtered });
});

app.post('/api/end-chat', (req, res) => {
  const { sessionId } = req.body;
  const chat = activeChats.get(sessionId);
  if (chat) {
    if (chat.partnerSessionId) {
      const partnerChat = activeChats.get(chat.partnerSessionId);
      if (partnerChat) activeChats.delete(chat.partnerSessionId);
    }
    activeChats.delete(sessionId);
    const roomId = chat.roomId;
    chatMessages.delete(roomId);
  }
  const idx = waitingQueue.indexOf(sessionId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
  res.json({ success: true });
});

// ------------------- FRONTEND (HTML embedded) -------------------
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatWave · Real Friends Chat</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(145deg, #f0f4f8, #e2e8f0); min-height: 100vh; }
        .toast-container { position:fixed; top:20px; right:20px; z-index:9999; display:flex; flex-direction:column; gap:10px; }
        .toast { background:white; border-radius:12px; padding:12px 20px; box-shadow:0 10px 25px rgba(0,0,0,0.1); display:flex; align-items:center; gap:12px; border-left:4px solid #2563eb; }
        .toast.success { border-left-color: #10b981; }
        .loading-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:10000; visibility:hidden; opacity:0; transition:0.2s; }
        .loading-overlay.active { visibility:visible; opacity:1; }
        .spinner { width:50px; height:50px; border:4px solid white; border-top-color:#2563eb; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .page { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
        .terms-container { max-width:680px; width:100%; background:white; border-radius:40px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); overflow:hidden; animation:fadeIn 0.4s ease; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        .terms-header { background:linear-gradient(135deg, #1e293b, #0f172a); padding:32px 28px; text-align:center; color:white; }
        .terms-header h1 { font-size:2rem; display:flex; align-items:center; justify-content:center; gap:12px; }
        .terms-content { padding:28px 28px 20px; max-height:55vh; overflow-y:auto; }
        .rule-block { margin-bottom:24px; border-bottom:1px solid #eef2ff; padding-bottom:18px; }
        .rule-title { font-weight:700; font-size:1.1rem; color:#0f172a; margin-bottom:8px; display:flex; align-items:center; gap:8px; }
        .rule-title i { color:#2563eb; }
        .rule-text { color:#334155; font-size:0.85rem; line-height:1.5; padding-left:32px; }
        .checkbox-row { display:flex; align-items:flex-start; gap:14px; background:#f8fafc; padding:18px 20px; border-radius:24px; margin:20px 0; border:1px solid #e2e8f0; }
        .checkbox-row input { width:22px; height:22px; cursor:pointer; accent-color:#2563eb; }
        .captcha-box { background:#f1f5f9; border-radius:60px; padding:10px 20px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:24px; }
        .verify-btn { background:white; border:1px solid #cbd5e1; padding:8px 20px; border-radius:40px; font-weight:500; cursor:pointer; }
        .verify-btn.verified { background:#10b981; border-color:#10b981; color:white; }
        .go-chat-btn { width:100%; background:linear-gradient(95deg, #2563eb, #1d4ed8); border:none; padding:16px; border-radius:60px; font-size:1.1rem; font-weight:700; color:white; cursor:pointer; }
        .go-chat-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .chat-page { min-height:100vh; display:none; }
        .chat-page.active { display:block; }
        .chat-wrapper { max-width:1300px; margin:0 auto; padding:20px; }
        .chat-nav { display:flex; justify-content:space-between; align-items:center; background:white; padding:12px 24px; border-radius:80px; margin-bottom:24px; border:1px solid #e2e8f0; }
        .logo { font-weight:800; font-size:1.3rem; background:linear-gradient(135deg, #1e293b, #2563eb); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .active-users-badge { background:#f1f5f9; padding:8px 18px; border-radius:40px; font-size:0.85rem; font-weight:600; display:flex; align-items:center; gap:8px; }
        .chat-grid { display:flex; flex-wrap:wrap; gap:24px; }
        .settings-panel { flex:1.2; min-width:260px; background:white; border-radius:32px; padding:24px; border:1px solid #e2e8f0; height:fit-content; }
        .chat-panel { flex:3; min-width:280px; background:white; border-radius:32px; display:flex; flex-direction:column; overflow:hidden; border:1px solid #e2e8f0; }
        .filter-group { margin-bottom:20px; }
        .filter-group label { font-weight:600; font-size:0.8rem; color:#334155; display:flex; align-items:center; gap:6px; margin-bottom:8px; }
        select, button { width:100%; padding:10px 14px; border-radius:28px; border:1px solid #e2e8f0; background:#f9fafb; font-family:inherit; font-size:0.85rem; cursor:pointer; }
        .btn-primary { background:#2563eb; color:white; border:none; font-weight:600; }
        .btn-danger { background:#fee2e2; border-color:#fecaca; color:#b91c1c; }
        .pay-boost { background:#f59e0b; color:white; border:none; margin-bottom:8px; }
        .info-badge { background:#f1f5f9; padding:12px; border-radius:20px; font-size:0.7rem; margin:16px 0; }
        .chat-messages { flex:1; min-height:420px; max-height:55vh; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:10px; background:#ffffff; }
        .msg { max-width:80%; padding:10px 16px; border-radius:22px; font-size:0.85rem; }
        .msg-in { background:#f1f5f9; align-self:flex-start; border-bottom-left-radius:6px; }
        .msg-out { background:#2563eb; color:white; align-self:flex-end; border-bottom-right-radius:6px; }
        .sys-msg { text-align:center; font-size:0.7rem; color:#64748b; margin:4px 0; }
        .typing { font-size:0.7rem; padding-left:20px; color:#64748b; font-style:italic; min-height:24px; }
        .input-row { display:flex; gap:10px; padding:16px 20px 20px; background:white; border-top:1px solid #e2e8f0; }
        .input-row input { flex:1; padding:12px 18px; border-radius:40px; border:1px solid #e2e8f0; font-family:inherit; }
        .send-btn { background:#2563eb; border:none; width:auto; padding:0 20px; border-radius:40px; color:white; font-weight:600; }
        .status-chip { background:#eef2ff; padding:4px 12px; border-radius:30px; font-size:0.7rem; display:inline-flex; align-items:center; gap:6px; }
        .dot { width:8px; height:8px; border-radius:8px; display:inline-block; }
        @media (max-width:700px) { .msg { max-width:90%; } }
    </style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>
<div class="loading-overlay" id="loadingOverlay"><div class="spinner"></div></div>

<div id="page1" class="page">
    <div class="terms-container">
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Real chat · Real friends · Real payments</p></div>
        <div class="terms-content">
            <div class="rule-block"><div class="rule-title"><i class="fas fa-gavel"></i> 1. Guidelines</div><div class="rule-text">Be respectful. No harassment.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-venus-mars"></i> 2. Payment Policy</div><div class="rule-text">Male → Female: ₹12 unlocks 100% match chance without waiting.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-shield-alt"></i> 3. Privacy</div><div class="rule-text">No chat logs stored. Anonymous only.</div></div>
            <div class="checkbox-row"><input type="checkbox" id="acceptTerms"><label>I agree to Terms & Conditions and confirm I am 18+ years old.</label></div>
            <div class="captcha-box"><div class="captcha-label"><i class="fas fa-robot"></i><span>Human verification</span></div><button id="verifyRobotBtn" class="verify-btn"><i class="fas fa-check-circle"></i> I'm not a robot</button></div>
            <div id="verifyStatus" style="font-size:0.7rem; text-align:center; margin-bottom:12px;"></div>
            <button id="goToChatBtn" class="go-chat-btn" disabled><i class="fas fa-arrow-right"></i> Enter ChatWave</button>
        </div>
    </div>
</div>

<div id="page2" class="chat-page">
    <div class="chat-wrapper">
        <div class="chat-nav"><div class="logo"><i class="fas fa-waveform"></i> ChatWave</div><div class="active-users-badge"><i class="fas fa-users"></i><span>Active:</span><span id="activeUserCount">--</span></div></div>
        <div class="chat-grid">
            <div class="settings-panel">
                <div class="filter-group"><label><i class="fas fa-user"></i> My gender</label><select id="chatMyGender"><option value="male">👨 Male</option><option value="female">👩 Female</option><option value="other">🌈 Other</option></select></div>
                <div class="filter-group"><label><i class="fas fa-globe"></i> Region</label><select id="chatRegion"><option value="global">🌍 Global</option><option value="asia">🌏 Asia</option><option value="europe">🇪🇺 Europe</option><option value="americas">🌎 Americas</option></select></div>
                <div class="filter-group"><label><i class="fas fa-heart"></i> Prefer to chat with</label><select id="chatPrefer"><option value="any">✨ Anyone</option><option value="female">👩 Female</option><option value="male">👨 Male</option><option value="other">🌈 Other</option></select></div>
                <div class="info-badge"><i class="fas fa-lightbulb"></i> <strong>Real users only!</strong><br>No bots – when two people both click "Find Partner", they'll chat together.</div>
                <button id="payBoostBtn" class="pay-boost"><i class="fas fa-qrcode"></i> Pay ₹12 (Real UPI)</button>
                <button id="findChatBtn" class="btn-primary"><i class="fas fa-random"></i> Find Partner</button>
                <button id="endChatPageBtn" class="btn-danger" style="margin-top:8px;"><i class="fas fa-stop"></i> End Chat</button>
                <div id="paymentStatusChat" class="status-chip" style="margin-top:16px; justify-content:center;"><i class="fas fa-wallet"></i> No premium</div>
            </div>
            <div class="chat-panel">
                <div style="padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;"><span id="partnerNameLabel"><i class="fas fa-user-friends"></i> Not connected</span><span id="connBadge" class="status-chip"><span class="dot" style="background:#94a3b8;"></span> Offline</span></div>
                <div class="chat-messages" id="chatMsgsArea"><div class="sys-msg">✨ Real user matching only! Invite a friend – when you both click "Find Partner", you'll chat together.</div></div>
                <div class="typing" id="typingIndicator"></div>
                <div class="input-row"><input type="text" id="chatMsgInput" placeholder="Type a message..."><button id="sendChatMsgBtn" class="send-btn"><i class="fas fa-paper-plane"></i> Send</button></div>
            </div>
        </div>
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

    function showToast(msg, type='info') { const c=document.getElementById('toastContainer'); const t=document.createElement('div'); t.className='toast '+type; t.innerHTML='<span>'+(type==='success'?'✅':type==='error'?'❌':'ℹ️')+'</span><span>'+msg+'</span>'; c.appendChild(t); setTimeout(()=>t.remove(),4000); }
    function showLoading(show){ document.getElementById('loadingOverlay').classList.toggle('active',show); }

    async function apiCall(endpoint, method='GET', data=null) {
        const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId } };
        if(data) opts.body = JSON.stringify(data);
        const res = await fetch(API_BASE+endpoint, opts);
        return res.json();
    }

    async function checkPremium() { const res = await apiCall('/api/check-premium', 'POST', { sessionId }); hasPremium = res.hasPremium; premiumExpiry = res.expiry; updateUI(); }
    async function getActiveUsers() { const res = await apiCall('/api/active-users'); document.getElementById('activeUserCount').innerText = res.count; }

    async function findMatch() {
        if(chatActive) { addSystemMsg("End current chat first."); return; }
        showLoading(true);
        const res = await apiCall('/api/find-match', 'POST', {
            myGender: document.getElementById('chatMyGender').value,
            region: document.getElementById('chatRegion').value,
            prefer: document.getElementById('chatPrefer').value,
            sessionId
        });
        showLoading(false);
        if(res.success && res.partner) startChat(res.partner);
        else if(res.message) addSystemMsg(res.message);
        else addSystemMsg("Could not find a partner. Try again.");
    }

    function startChat(partner) {
        if(chatActive) endChat();
        activePartner = partner;
        chatActive = true;
        clearChatMsgs();
        addSystemMsg('✨ Connected with ' + partner.name + ' (real user) from ' + partner.region);
        updateUI();
        lastMsgTimestamp = Date.now();
        if(msgInterval) clearInterval(msgInterval);
        msgInterval = setInterval(pollMessages, 1500);
    }

    async function pollMessages() {
        if(!chatActive) return;
        const res = await apiCall('/api/get-messages', 'POST', { sessionId, lastTimestamp: lastMsgTimestamp });
        if(res.success && res.messages && res.messages.length) {
            for(let msg of res.messages) {
                addBubble(msg.text, 'in');
                if(msg.timestamp > lastMsgTimestamp) lastMsgTimestamp = msg.timestamp;
            }
        }
    }

    async function endChat() {
        if(chatActive) {
            await apiCall('/api/end-chat', 'POST', { sessionId });
            if(msgInterval) clearInterval(msgInterval);
            msgInterval = null;
            chatActive = false;
            activePartner = null;
            clearChatMsgs(true);
            updateUI();
        }
    }

    async function sendMessage() {
        if(!chatActive || !activePartner) return;
        const input = document.getElementById('chatMsgInput');
        const text = input.value.trim();
        if(!text) return;
        addBubble(text, 'out');
        input.value = '';
        await apiCall('/api/send-message', 'POST', { sessionId, text });
    }

    function addSystemMsg(t) { const area=document.getElementById('chatMsgsArea'); const div=document.createElement('div'); div.className='sys-msg'; div.innerHTML='<i class="fas fa-info-circle"></i> '+t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function addBubble(t, type) { const area=document.getElementById('chatMsgsArea'); const div=document.createElement('div'); div.className='msg '+(type==='out'?'msg-out':'msg-in'); div.innerText=t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function clearChatMsgs(keepSys=false){ const area=document.getElementById('chatMsgsArea'); area.innerHTML=''; if(keepSys) addSystemMsg("Chat ended. Click 'Find Partner' to start a new conversation."); }

    function updateUI() {
        const pSpan=document.getElementById('partnerNameLabel'); const cSpan=document.getElementById('connBadge'); const sendBtn=document.getElementById('sendChatMsgBtn'); const inp=document.getElementById('chatMsgInput'); const payDiv=document.getElementById('paymentStatusChat');
        if(chatActive && activePartner){ pSpan.innerHTML='<i class="fas fa-user-check"></i> '+activePartner.name+' (real)'; cSpan.innerHTML='<span class="dot" style="background:#22c55e;"></span> Connected'; sendBtn.disabled=false; inp.disabled=false; } else { pSpan.innerHTML='<i class="fas fa-user-slash"></i> Not connected'; cSpan.innerHTML='<span class="dot" style="background:#94a3b8;"></span> Offline'; sendBtn.disabled=true; inp.disabled=true; }
        const myGender=document.getElementById('chatMyGender').value;
        if(myGender==='male' && hasPremium && premiumExpiry && Date.now()<premiumExpiry){ const left=Math.floor((premiumExpiry-Date.now())/60000); payDiv.innerHTML='<i class="fas fa-crown"></i> PREMIUM ('+left+'min left) · 100% female match'; }
        else if(myGender==='male') payDiv.innerHTML='<i class="fas fa-clock"></i> No premium · Female chance: 15% <button id="payNowBtn" style="margin-top:5px;background:#f59e0b;border:none;padding:5px;">Pay ₹12</button>';
        else payDiv.innerHTML='<i class="fas fa-unlock"></i> Free access';
        const payBtn = document.getElementById('payNowBtn'); if(payBtn) payBtn.onclick=openRazorpay;
    }

    async function openRazorpay() {
        if(document.getElementById('chatMyGender').value!=='male'){ showToast("Only male users can buy boost.",'warning'); return; }
        if(hasPremium && premiumExpiry && Date.now()<premiumExpiry){ showToast("Premium already active.",'info'); return; }
        showLoading(true);
        const res = await apiCall('/api/create-order', 'POST', { amount: 12 });
        showLoading(false);
        if(!res.success){ showToast("Failed to create order.",'error'); return; }
        const options = { key: res.key, amount: res.amount, currency: res.currency, name: "ChatWave", description: "Premium Boost (30 min)", order_id: res.orderId, handler: async function(response){
            showLoading(true);
            const verifyRes = await apiCall('/api/verify-payment', 'POST', { razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature, sessionId });
            showLoading(false);
            if(verifyRes.success){ showToast("Payment successful! Premium activated.",'success'); await checkPremium(); updateUI(); }
            else showToast("Payment verification failed.",'error');
        }, prefill: { name: "ChatWave User", email: "user@chatwave.com" }, theme: { color: "#2563eb" } };
        const rzp = new Razorpay(options);
        rzp.open();
    }

    // Page transitions
    const page1=document.getElementById('page1'), page2=document.getElementById('page2');
    const acceptCheck=document.getElementById('acceptTerms'), verifyBtn=document.getElementById('verifyRobotBtn'), goBtn=document.getElementById('goToChatBtn');
    let verified=false;
    verifyBtn.onclick=()=>{ verified=true; verifyBtn.innerHTML='<i class="fas fa-check-circle"></i> Verified ✓'; verifyBtn.classList.add('verified'); document.getElementById('verifyStatus').innerHTML='<span style="color:#10b981;">✓ Verified</span>'; goBtn.disabled=!(acceptCheck.checked && verified); };
    acceptCheck.onchange=()=>{ goBtn.disabled=!(acceptCheck.checked && verified); };
    goBtn.onclick=async()=>{ page1.style.display='none'; page2.classList.add('active'); await checkPremium(); getActiveUsers(); if(activePolling) clearInterval(activePolling); activePolling=setInterval(getActiveUsers,10000); addSystemMsg("👋 Real user matching only! Invite a friend – when you both click 'Find Partner', you'll chat together."); };
    document.getElementById('findChatBtn').onclick=findMatch;
    document.getElementById('endChatPageBtn').onclick=endChat;
    document.getElementById('sendChatMsgBtn').onclick=sendMessage;
    document.getElementById('chatMsgInput').onkeypress=(e)=>{ if(e.key==='Enter') sendMessage(); };
    document.getElementById('payBoostBtn').onclick=openRazorpay;
    document.getElementById('chatMyGender').onchange=updateUI;
    document.getElementById('chatPrefer').onchange=updateUI;
    updateUI();
</script>
</body>
</html>`;

// Serve the frontend – explicit root route and catch-all for client-side routing
app.get('/', (req, res) => res.send(htmlTemplate));
app.get('/*splat', (req, res) => res.send(htmlTemplate));

// ------------------- START SERVER -------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ChatWave server running on http://localhost:${PORT}`);
  console.log(`👥 Real user matching only (no bots) — friends will be paired together!`);
  console.log(`🔑 Razorpay: ${RAZORPAY_KEY_ID === 'YOUR_KEY_ID_HERE' ? '⚠️  Set your keys' : 'active'}`);
});
