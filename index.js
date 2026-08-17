const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// Environment variable se key lega
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.post("/webhook/zapupi", async (req, res) => {
  try {
    const data = req.body;
    const orderId = data.order_id || data.orderId;
    const status = (data.status || "").toString().toLowerCase();
    const amount = parseFloat(data.amount || data.pay_amount || 0);
    const txnId = data.txn_id || data.txnId || "";
    const utr = data.utr || "";

    console.log("Webhook received:", { orderId, status, amount });

    if (status !== "success" || !orderId) {
      return res.status(200).json({ status: "ok" });
    }

    const db = admin.firestore();
    const orderRef = db.collection("payment_orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists || orderSnap.data().status === "success") {
      return res.status(200).json({ status: "ok" });
    }

    const uid = orderSnap.data().uid;
    if (!uid) return res.status(200).json({ status: "ok" });

    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;

      const userData = userSnap.data();
      const creditAmount = amount || orderSnap.data().amount || 0;

      const newWallet = (userData.walletPoints || 0) + creditAmount;
      const newJoin = (userData.joinPoints || 0) + creditAmount;

      tx.update(userRef, {
        walletPoints: newWallet,
        joinPoints: newJoin,
      });

      tx.set(
        orderRef,
        {
          status: "success",
          creditedAt: admin.firestore.FieldValue.serverTimestamp(),
          txn_id: txnId,
          utr: utr,
        },
        { merge: true }
      );

      tx.set(userRef.collection("wallet_history").doc(), {
        type: "credit",
        title: "Deposit via Payment Gateway",
        amount: creditAmount,
        balance_after: newWallet,
        date: admin.firestore.FieldValue.serverTimestamp(),
        orderId: orderId,
      });
    });

    console.log("Coins credited for order:", orderId);
    res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).json({ error: "error" });
  }
});

app.get("/", (req, res) => res.send("Zap Webhook is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
