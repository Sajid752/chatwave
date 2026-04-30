// ==================== server.js ====================
// Full-stack chat application with Razorpay payments
// Deploy as a single file – no separate frontend files needed

const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
// Replace with your actual Razorpay keys from dashboard.razorpay.com
// For production, use environment variables (Render, Railway, etc.)
const RAZORPAY_KEY_ID = 'rzp_test_SjkRHBxR35ls58';   // <- paste your Key ID here (keep the quotes)
const RAZORPAY_KEY_SECRET = 'nVBr3LEjVAtLM3MfdJrKx3KY';   // <- paste your Key Secret here (keep the quotes)

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

app.use(cors());
app.use(express.json());

// In-memory stores (reset on server restart – use database for production)
const activeSessions = new Map();
const userPremiums = new Map(); // sessionId -> expiry timestamp

// ==================== API ROUTES ====================

// 1. Create Razorpay order
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const options = {
      amount: amount * 100, // convert rupees to paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1,
    };
    const order = await razorpay.orders.create(options);
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

// 2. Verify payment after success
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, sessionId } = req.body;
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest('hex');

  if (expectedSignature === razorpay_signature) {
    // Grant premium for 30 minutes
    userPremiums.set(sessionId, Date.now() + 30 * 60 * 1000);
    res.json({ success: true, message: 'Payment verified, premium activated' });
  } else {
    res.status(400).json({ success: false, message: 'Invalid signature' });
  }
});

// 3. Check if user has premium
app.post('/api/check-premium', (req, res) => {
  const { sessionId } = req.body;
  const expiry = userPremiums.get(sessionId);
  const hasPremium = expiry && expiry > Date.now();
  res.json({ success: true, hasPremium, expiry });
});

// 4. Get active users count (simulated)
app.get('/api/active-users', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) activeSessions.set(sessionId, Date.now());
  // Clean old sessions (older than 1 minute)
  for (let [id, time] of activeSessions.entries()) {
    if (Date.now() - time > 60000) activeSessions.delete(id);
  }
  const baseCount = 50;
  const randomVariation = Math.floor(Math.random() * 100);
  res.json({ success: true, count: activeSessions.size + baseCount + randomVariation });
});

// 5. Find a chat partner (with premium logic)
app.post('/api/find-match', (req, res) => {
  const { myGender, region, prefer, hasPremium } = req.body;
  const strangersDB = [
    { id: 1, name: 'Mei', gender: 'female', region: 'asia' },
    { id: 2, name: 'Rahul', gender: 'male', region: 'asia' },
    { id: 3, name: 'Elena', gender: 'female', region: 'europe' },
    { id: 4, name: 'Liam', gender: 'male', region: 'europe' },
    { id: 5, name: 'Sofia', gender: 'female', region: 'americas' },
    { id: 6, name: 'James', gender: 'male', region: 'americas' },
    { id: 7, name: 'Priya', gender: 'female', region: 'asia' },
    { id: 8, name: 'Kenji', gender: 'male', region: 'asia' },
    { id: 9, name: 'Zara', gender: 'female', region: 'europe' },
    { id: 10, name: 'Oliver', gender: 'male', region: 'europe' },
  ];
  let candidates = strangersDB.filter(s => {
    if (region !== 'global' && s.region !== region) return false;
    if (prefer !== 'any' && s.gender !== prefer) return false;
    return true;
  });
  if (candidates.length === 0) candidates = strangersDB;
  const isMaleSeekingFemale = myGender === 'male' && (prefer === 'female' || prefer === 'any');
  if (isMaleSeekingFemale && !hasPremium) {
    // 85% chance to avoid female if no premium
    if (Math.random() > 0.15) {
      candidates = candidates.filter(c => c.gender !== 'female');
      if (candidates.length === 0) candidates = strangersDB;
    }
  }
  const partner = candidates[Math.floor(Math.random() * candidates.length)];
  res.json({ success: true, partner });
});

// ==================== SERVE FRONTEND ====================
app.get('/{*splat}', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatWave · Real Payments</title>
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
        <div class="terms-header"><h1><i class="fas fa-waveform"></i> ChatWave</h1><p>Random chat · Gender filters · Secure payments</p></div>
        <div class="terms-content">
            <div class="rule-block"><div class="rule-title"><i class="fas fa-gavel"></i> 1. Guidelines</div><div class="rule-text">Be respectful. No harassment.</div></div>
            <div class="rule-block"><div class="rule-title"><i class="fas fa-venus-mars"></i> 2. Payment Policy</div><div class="rule-text">Male → Female: ₹12 real payment (UPI) unlocks 100% match chance. Without payment: 15% chance.</div></div>
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
                <div class="info-badge"><i class="fas fa-lightbulb"></i> <strong>Payment Boost</strong><br>Male → Female: ₹12 real UPI = 100% match chance (30min). Real money, real premium.</div>
                <button id="payBoostBtn" class="pay-boost"><i class="fas fa-qrcode"></i> Pay ₹12 (Real UPI)</button>
                <button id="findChatBtn" class="btn-primary"><i class="fas fa-random"></i> Find Partner</button>
                <button id="endChatPageBtn" class="btn-danger" style="margin-top:8px;"><i class="fas fa-stop"></i> End Chat</button>
                <div id="paymentStatusChat" class="status-chip" style="margin-top:16px; justify-content:center;"><i class="fas fa-wallet"></i> No premium</div>
            </div>
            <div class="chat-panel">
                <div style="padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;"><span id="partnerNameLabel"><i class="fas fa-user-friends"></i> Not connected</span><span id="connBadge" class="status-chip"><span class="dot" style="background:#94a3b8;"></span> Offline</span></div>
                <div class="chat-messages" id="chatMsgsArea"><div class="sys-msg">✨ Welcome to ChatWave! Real payments accepted. Pay ₹12 for premium.</div></div>
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
            hasPremium: hasPremium,
            sessionId
        });
        showLoading(false);
        if(res.success && res.partner) startChat(res.partner);
        else addSystemMsg("No partners available. Try again.");
    }

    function startChat(partner) { if(chatActive) endChat(); activePartner = partner; chatActive = true; clearChatMsgs(); addSystemMsg('✨ Connected with '+partner.name+' ('+partner.gender+') from '+partner.region); updateUI(); setTimeout(()=>{ if(chatActive) addBubble("Hey! Nice to meet you :)", 'in'); },700); }
    function endChat() { chatActive=false; activePartner=null; clearChatMsgs(true); updateUI(); }
    function addSystemMsg(t) { const area=document.getElementById('chatMsgsArea'); const div=document.createElement('div'); div.className='sys-msg'; div.innerHTML='<i class="fas fa-info-circle"></i> '+t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function addBubble(t, type) { const area=document.getElementById('chatMsgsArea'); const div=document.createElement('div'); div.className='msg '+(type==='out'?'msg-out':'msg-in'); div.innerText=t; area.appendChild(div); div.scrollIntoView({behavior:'smooth'}); }
    function clearChatMsgs(keepSys=false){ const area=document.getElementById('chatMsgsArea'); area.innerHTML=''; if(keepSys) addSystemMsg("Chat ended. Click 'Find Partner' to start a new conversation."); }
    function sendMessage(){ if(!chatActive) return; const inp=document.getElementById('chatMsgInput'); const txt=inp.value.trim(); if(!txt) return; addBubble(txt,'out'); inp.value=''; document.getElementById('typingIndicator').innerText=activePartner.name+' is typing...'; setTimeout(()=>{ document.getElementById('typingIndicator').innerText=''; if(chatActive) addBubble(["Interesting!","Cool","Tell me more","I see!"][Math.floor(Math.random()*4)],'in'); },1000);}
    function updateUI() {
        const pSpan=document.getElementById('partnerNameLabel'); const cSpan=document.getElementById('connBadge'); const sendBtn=document.getElementById('sendChatMsgBtn'); const inp=document.getElementById('chatMsgInput'); const payDiv=document.getElementById('paymentStatusChat');
        if(chatActive && activePartner){ pSpan.innerHTML='<i class="fas fa-user-check"></i> '+activePartner.name+' ('+activePartner.gender+')'; cSpan.innerHTML='<span class="dot" style="background:#22c55e;"></span> Connected'; sendBtn.disabled=false; inp.disabled=false; } else { pSpan.innerHTML='<i class="fas fa-user-slash"></i> Not connected'; cSpan.innerHTML='<span class="dot" style="background:#94a3b8;"></span> Offline'; sendBtn.disabled=true; inp.disabled=true; }
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
            if(verifyRes.success){ showToast("Payment successful! Premium activated for 30 min.",'success'); await checkPremium(); updateUI(); }
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
    goBtn.onclick=async()=>{ page1.style.display='none'; page2.classList.add('active'); await checkPremium(); getActiveUsers(); if(activePolling) clearInterval(activePolling); activePolling=setInterval(getActiveUsers,10000); addSystemMsg("👋 Welcome! Select filters and click 'Find Partner'. Real payments active."); };
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
</html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ ChatWave server running on http://localhost:${PORT}`);
  console.log(`🔑 Razorpay integration: ${RAZORPAY_KEY_ID === 'YOUR_KEY_ID_HERE' ? '⚠️  Set your keys in environment variables or directly in code' : 'active'}`);
});