const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ============================================================
// DEPOSIT OFFER (extra coin bonus on deposit)
//
// Reads settings/deposit_offer, same document the admin panel's
// "Deposit Offer" tab writes to:
//   { enabled: boolean, tiers: [ { pay: number, credit: number }, ... ] }
//
// Rule: match is always EXACT on "pay". Agar user ne 50 diya aur tiers
// list me { pay: 50, credit: 60 } hai to 60 credit hota hai. Agar usne
// 49 diya (jo kisi tier se match nahi karta) to sirf 49 hi credit hota
// hai — koi partial/threshold bonus nahi milta. Offer OFF ho to kuch
// bhi extra nahi milta, seedha paid amount hi credit hota hai.
// ============================================================
function computeDepositCredit(paidAmount, offerData) {
  const amt = Number(paidAmount) || 0;
  const offer = offerData || {};
  if (!offer.enabled) return { creditAmount: amt, bonusAmount: 0 };

  const tiers = Array.isArray(offer.tiers) ? offer.tiers : [];
  const tier = tiers.find((t) => Math.abs(Number(t.pay) - amt) < 0.005);
  if (!tier) return { creditAmount: amt, bonusAmount: 0 };

  const creditAmount = Number(tier.credit);
  return { creditAmount, bonusAmount: creditAmount - amt };
}

app.post("/webhook/zapupi", async (req, res) => {
  try {
    const data = req.body || {};
    console.log("Webhook body:", JSON.stringify(data));

    const orderId = data.order_id || data.orderId || data.txn_id || "";
    const status = (data.status || data.payment_status || "").toString().toLowerCase();
    const amount = parseFloat(data.amount || data.pay_amount || data.txn_amount || 0);
    const txnId = data.txn_id || data.txnId || data.transaction_id || "";
    const utr = data.utr || data.UTR || "";

    if (!orderId) {
      return res.status(200).json({ status: "ok", msg: "no order_id" });
    }

    // sirf success pe credit
    if (status !== "success" && status !== "completed" && status !== "paid") {
      console.log("Not success:", status);
      return res.status(200).json({ status: "ok" });
    }

    const db = admin.firestore();
    const orderRef = db.collection("payment_orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      console.log("Order not found:", orderId);
      return res.status(200).json({ status: "ok", msg: "order not found" });
    }

    const orderData = orderSnap.data();
    if (orderData.status === "success") {
      return res.status(200).json({ status: "ok", msg: "already credited" });
    }

    const uid = orderData.uid;
    if (!uid) {
      return res.status(200).json({ status: "ok", msg: "no uid" });
    }

    // Ye jo user ne ASAL me pay kiya (offer se pehle wala raw amount) —
    // isi ke against tiers list me exact match dhoondha jaata hai.
    const paidAmount = amount || orderData.amount || 0;
    if (paidAmount <= 0) {
      return res.status(200).json({ status: "ok", msg: "invalid amount" });
    }

    const userRef = db.collection("users").doc(uid);
    const offerRef = db.collection("settings").doc("deposit_offer");

    await db.runTransaction(async (tx) => {
      // Deposit Offer settings live transaction ke andar hi padhte hain
      // taaki credit hamesha us waqt ke actual offer ke hisaab se ho.
      const offerSnap = await tx.get(offerRef);
      const offerData = offerSnap.exists ? offerSnap.data() : {};
      const { creditAmount, bonusAmount } = computeDepositCredit(paidAmount, offerData);

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;

      const userData = userSnap.data();
      const newWallet = (userData.walletPoints || 0) + creditAmount;
      const newJoin = (userData.joinPoints || 0) + creditAmount;

      // 1) Wallet credit — offer bonus (agar tier match hua) sahit
      tx.update(userRef, {
        walletPoints: newWallet,
        joinPoints: newJoin,
      });

      // 2) Order success mark
      tx.set(
        orderRef,
        {
          status: "success",
          creditedAt: admin.firestore.FieldValue.serverTimestamp(),
          txn_id: txnId,
          utr: utr,
          amount: paidAmount,
          creditedAmount: creditAmount,
          bonusAmount: bonusAmount,
        },
        { merge: true }
      );

      // 3) Wallet history
      tx.set(userRef.collection("wallet_history").doc(), {
        type: "credit",
        title:
          bonusAmount > 0
            ? `Deposit via Payment Gateway (+ Offer Bonus ${bonusAmount.toFixed(2)})`
            : "Deposit via Payment Gateway",
        amount: creditAmount,
        balance_after: newWallet,
        date: admin.firestore.FieldValue.serverTimestamp(),
        orderId: orderId,
      });

      // 4) Deposit section mein dikhane ke liye — "amount" wahi raw amount
      // hai jo user ne pay kiya, aur creditedAmount/bonusAmount wahi
      // fields hain jo admin panel ka Manual UPI approve flow bhi use
      // karta hai, taaki "Wallet Credit" column aur Reject (Undo) yahan
      // bhi bilkul waise hi kaam karein.
      const depRef = db.collection("deposit_requests").doc();
      tx.set(depRef, {
        uid: uid,
        amount: paidAmount,
        creditedAmount: creditAmount,
        bonusAmount: bonusAmount,
        utr: utr || txnId || orderId,
        accountName: "Payment Gateway",
        upiId: "zapupi",
        status: "approved",
        source: "gateway",
        orderId: orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        notified: true,
      });
    });

    console.log("Credited + deposit entry:", orderId, paidAmount);
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ error: "error" });
  }
});

app.get("/", (req, res) => res.send("Zap Webhook is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
