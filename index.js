const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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

    const creditAmount = amount || orderData.amount || 0;
    if (creditAmount <= 0) {
      return res.status(200).json({ status: "ok", msg: "invalid amount" });
    }

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;

      const userData = userSnap.data();
      const newWallet = (userData.walletPoints || 0) + creditAmount;
      const newJoin = (userData.joinPoints || 0) + creditAmount;

      // 1) Wallet credit
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
          amount: creditAmount,
        },
        { merge: true }
      );

      // 3) Wallet history
      tx.set(userRef.collection("wallet_history").doc(), {
        type: "credit",
        title: "Deposit via Payment Gateway",
        amount: creditAmount,
        balance_after: newWallet,
        date: admin.firestore.FieldValue.serverTimestamp(),
        orderId: orderId,
      });

      // 4) Deposit section mein dikhane ke liye
      const depRef = db.collection("deposit_requests").doc();
      tx.set(depRef, {
        uid: uid,
        amount: creditAmount,
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

    console.log("Credited + deposit entry:", orderId, creditAmount);
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ error: "error" });
  }
});

app.get("/", (req, res) => res.send("Zap Webhook is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
