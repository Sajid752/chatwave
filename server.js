async function confirmPayment() {
    const res = await apiCall('/api/confirm-payment', 'POST', { sessionId });
    if(res.success) {
        addSystemMsg("✅ Premium activated for 10 minutes.");
        await checkPremium();
        document.getElementById('paymentModal').classList.remove('active');
        if(pendingFindMatch) performFindMatch();
    }
}
