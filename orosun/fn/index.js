const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const stripe = require("stripe")(functions.config().stripe.key);

// SHORT NAMES
// pay  = create Stripe Checkout session
// hook = Stripe webhook (marks paid=true)

exports.pay = functions.https.onRequest(async (req, res) => {
  try {
    // Basic CORS for browser calls
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).send("");

    if (req.method !== "POST") return res.status(405).send("POST only");

    const { leadId } = req.body || {};
    if (!leadId) return res.status(400).json({ error: "missing leadId" });

    const db = admin.firestore();

    // Read lead
    const leadRef = db.collection("leads").doc(leadId);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) return res.status(404).json({ error: "lead not found" });

    const lead = leadSnap.data();
    const tier = lead.tier;
    if (!tier) return res.status(400).json({ error: "lead missing tier" });

    // Read cfg/main
    const cfgSnap = await db.collection("cfg").doc("main").get();
    const cfg = cfgSnap.data() || {};
    const priceId = cfg?.tiers?.[tier]?.price;
    if (!priceId) return res.status(400).json({ error: "missing priceId for tier" });

    const domain = "https://app.orosunhealth.com";

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${domain}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domain}/pay.html?lead=${encodeURIComponent(leadId)}`,
      metadata: { leadId }
    });

    // Save session id on lead (so success page can look it up)
    await leadRef.update({
      stripeSession: session.id,
      paid: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "pay_failed" });
  }
});

exports.hook = functions.https.onRequest(async (req, res) => {
  try {
    // Stripe requires raw body for webhook verification.
    // Firebase Functions v1: works if you deploy as-is; if webhook fails verification,
    // we’ll switch to a raw-body handler (common fix).
    const sig = req.headers["stripe-signature"];
    const whsec = functions.config().stripe.whsec;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
    } catch (err) {
      console.error("Webhook signature verify failed:", err.message);
      return res.status(400).send(`Bad signature`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const leadId = session?.metadata?.leadId;
      if (!leadId) return res.status(200).send("no leadId");

      const db = admin.firestore();
      const leadRef = db.collection("leads").doc(leadId);

      await leadRef.set(
        {
          paid: true,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          stripeSession: session.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("hook_failed");
  }
});
