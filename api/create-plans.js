// api/create-plans.js — ONE-TIME SETUP endpoint. Call this once (e.g. via
// curl or Postman, signed in as the admin account) to create the $15/mo
// recurring Pro plan on Paystack. It prints back the plan_code — paste it
// into PAYSTACK_PLAN_CODE_PRO15 in the frontend (and set the env var
// PAYSTACK_PLAN_PRO15 on Vercel to the same value), then this endpoint is
// never needed again. The old $7 / $25 plans already exist and are NOT
// recreated here, so running this will not duplicate them.
//
// IMPORTANT — exchange rate caveat: Paystack plans bill a FIXED NGN amount
// on every renewal. This converts $7/$25 to NGN once, at creation time,
// using today's rate. If USD/NGN moves a lot afterward, the NGN amount
// your subscribers pay monthly does NOT auto-adjust — you'd need to
// create new plans and migrate subscribers to reprice. Fine to launch
// with, but revisit periodically.
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const ADMIN_UID = 'SlUg15UFENNJglFw9KfRqQNWdkx2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid auth token' });
  }
  if (decoded.uid !== ADMIN_UID) {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const rateRes = await fetch('https://open.er-api.com/v6/latest/USD');
    const rateData = await rateRes.json();
    const rate = (rateData && rateData.rates && rateData.rates.NGN) ? rateData.rates.NGN : 1600;

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY missing' });

    async function createPlan(name, usdAmount) {
      const amountKobo = Math.round(usdAmount * rate * 100);
      const r = await fetch('https://api.paystack.co/plan', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          amount: amountKobo,
          interval: 'monthly',
          currency: 'NGN',
        }),
      });
      const data = await r.json();
      if (!data.status) throw new Error(data.message || 'Plan creation failed');
      return data.data.plan_code;
    }

    const pro15Code = await createPlan('KLAVE Pro ($15/mo)', 15);

    return res.status(200).json({
      success: true,
      rateUsed: rate,
      pro15: pro15Code,
      note: 'Paste this plan_code into PAYSTACK_PLAN_CODE_PRO15 in the frontend and set env var PAYSTACK_PLAN_PRO15 on Vercel to the same value.',
    });
  } catch (e) {
    console.error('Plan creation error:', e);
    return res.status(500).json({ error: e.message });
  }
}
