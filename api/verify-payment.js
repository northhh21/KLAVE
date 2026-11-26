// /api/verify-payment.js
// Verifies a Paystack beat purchase server-side, records the order once,
// credits any referral commission once, and emails the download link.
//
// Also handles CART purchases: metadata.items = [{beatId,tier}], one Paystack payment for several beats.
//
// Changes in this version:
//  - IDEMPOTENT: replaying the same reference no longer re-credits referral
//    commission or re-sends the email (the order doc is the "already done" marker).
//  - Rejects non-NGN payments (amount is compared against a naira price).
//  - Once a beat is sold exclusively, NO further sales of it are accepted.
//  - A paid-but-rejected sale is logged to `refundsNeeded` so you can refund it.
//  - Email HTML is escaped, and the download link must be a Cloudinary URL.
//  - Optional buyer auth: if the request carries a Firebase ID token, its uid
//    must match the buyer on the payment. Set REQUIRE_BUYER_AUTH=true in Vercel
//    once the app sends the token on this call to make it mandatory.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { buyerDownloadUrl } from '../lib/cloudinary-sign.js';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

const CLOUDINARY_PREFIX = 'https://res.cloudinary.com/dcajo9jib/';
const SOLD_MSG = 'This beat has already been sold exclusively';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function getUsdToNgnRate() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  const data = await res.json();
  const rate = data?.rates?.NGN;
  if (!rate) throw new Error('Could not fetch USD->NGN exchange rate');
  return rate;
}

// Must match commissionTier() in the KLAVE app's admin referral panel.
function commissionTier(referralCount) {
  if (referralCount >= 10) return 15;
  if (referralCount >= 5) return 10;
  return 5;
}

async function creditReferralCommission({ buyerId, saleAmountUsd, beatId, reference }) {
  const buyerSnap = await db.collection('users').doc(buyerId).get();
  const referredBy = buyerSnap.exists ? buyerSnap.data().referredBy : null;
  if (!referredBy) return;

  let referrerDoc = null;
  let referrerCollection = null;

  const userQuery = await db.collection('users').where('username', '==', referredBy).limit(1).get();
  if (!userQuery.empty) {
    referrerDoc = userQuery.docs[0];
    referrerCollection = 'users';
  } else {
    const waitlistQuery = await db.collection('waitlist').where('code', '==', referredBy).limit(1).get();
    if (!waitlistQuery.empty) {
      referrerDoc = waitlistQuery.docs[0];
      referrerCollection = 'waitlist';
    }
  }
  if (!referrerDoc) return;

  const referrerData = referrerDoc.data();
  if (referrerCollection === 'users' && referrerDoc.id === buyerId) return;

  const percent = commissionTier(referrerData.referralCount || 0);
  const commissionAmount = saleAmountUsd * (percent / 100);

  await referrerDoc.ref.update({
    referralEarnings: FieldValue.increment(commissionAmount),
    pendingReferralPayout: FieldValue.increment(commissionAmount),
  });

  await db.collection('referralPayouts').add({
    referrerUsername: referredBy,
    referrerType: referrerCollection,
    referrerUid: referrerDoc.id,
    buyerUid: buyerId,
    beatId,
    saleAmount: saleAmountUsd,
    commissionPercent: percent,
    commissionAmount,
    reference,
    createdAt: new Date().toISOString(),
    paid: false,
  });
}

async function sendDownloadEmail({ toEmail, beat, tier, reference }) {
  if (!toEmail) {
    console.warn('No buyer email available — skipping download email for', reference);
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping download email for', reference);
    return;
  }
  // Only ever link to our own Cloudinary account.
  if (typeof beat.audioUrl !== 'string' || !beat.audioUrl.startsWith(CLOUDINARY_PREFIX)) {
    console.error('Refusing to email non-Cloudinary audioUrl for', reference);
    return;
  }

  const licenseLabel = tier === 'exclusive' ? 'Exclusive Rights' : 'Standard';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'KLAVE <onboarding@resend.dev>', // swap for a verified KLAVE domain address once set up in Resend
      to: toEmail,
      subject: `Your beat is ready — ${String(beat.title ?? '').slice(0, 100)}`,
      html: `
        <div style="font-family:sans-serif;background:#0a0a0a;color:#ffffff;padding:32px;border-radius:12px;">
          <div style="font-size:20px;font-weight:800;letter-spacing:2px;margin-bottom:2px;">KLAVE</div>
          <div style="font-size:11px;color:#888;letter-spacing:1px;margin-bottom:24px;">// your beat is ready.</div>
          <h2 style="margin:0 0 4px;">${esc(beat.title)}</h2>
          <p style="color:#aaa;margin:0 0 4px;">prod. ${esc(beat.prod || 'Unknown')}</p>
          <p style="color:#aaa;margin:0 0 20px;">License: ${licenseLabel}</p>
          <a href="${esc(beat.audioUrl)}" style="display:inline-block;background:#3B5BFF;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Download Your Beat</a>
          <p style="color:#555;font-size:11px;margin-top:28px;">Order reference: ${esc(reference)}</p>
        </div>
      `,
    }),
  });
}

// ── Link previews: /beat/<id> is rewritten here (GET ?og=1&id=...) so shared links
// show the beat's title and cover. Lives in this file to stay within 12 functions.
const _esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function serveBeatPage(req, res) {
  const id = String(req.query.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = 'https://' + host;
  let html;
  try {
    html = await (await fetch(origin + '/index.html')).text();
  } catch (e) {
    res.statusCode = 302; res.setHeader('Location', '/'); return res.end();
  }
  let title = 'KLAVE', desc = 'Verified human-made beats. License them on KLAVE.', img = '';
  try {
    if (id) {
      const snap = await db.collection('beats').doc(id).get();
      if (snap.exists) {
        const b = snap.data();
        title = `${b.title}${b.prod ? ' — prod. ' + b.prod : ''} | KLAVE`;
        const bits = [b.genre, b.bpm ? b.bpm + ' BPM' : '', b.key].filter(Boolean);
        desc = `${b.humanVerified ? 'Verified human-made. ' : ''}${bits.length ? bits.join(' · ') + '. ' : ''}Preview and license on KLAVE.`;
        img = b.coverUrl || '';
      }
    }
  } catch (e) { /* generic tags */ }
  const tags =
    '<meta property="og:type" content="website"/>' +
    '<meta property="og:site_name" content="KLAVE"/>' +
    `<meta property="og:title" content="${_esc(title)}"/>` +
    `<meta property="og:description" content="${_esc(desc)}"/>` +
    `<meta property="og:url" content="${_esc(origin + '/beat/' + id)}"/>` +
    (img ? `<meta property="og:image" content="${_esc(img)}"/>` : '') +
    `<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}"/>` +
    `<meta name="twitter:title" content="${_esc(title)}"/>` +
    `<meta name="twitter:description" content="${_esc(desc)}"/>` +
    (img ? `<meta name="twitter:image" content="${_esc(img)}"/>` : '');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${_esc(title)}</title>`).replace('</head>', tags + '</head>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).send(html);
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.og === '1') {
    return serveBeatPage(req, res);
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
  if (!reference) {
    return res.status(400).json({ error: 'Missing required field: reference' });
  }

  let refundInfo = null;

  try {
    // 0. Optional / required buyer auth
    let callerUid = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        callerUid = (await getAuth().verifyIdToken(authHeader.slice(7))).uid;
      } catch (e) {
        return res.status(401).json({ error: 'Invalid auth token' });
      }
    } else if (process.env.REQUIRE_BUYER_AUTH === 'true') {
      return res.status(401).json({ error: 'Missing auth token' });
    }

    // 1. Verify with Paystack (source of truth)
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data.status !== 'success') {
      return res.status(402).json({
        error: 'Payment not successful',
        details: verifyData.data?.gateway_response || 'Unknown reason',
      });
    }

    // ── CART PURCHASE: several beats paid in one Paystack transaction ──
    const meta0 = verifyData.data.metadata || {};
    if (Array.isArray(meta0.items)) {
      const cBuyer = meta0.buyerId;
      const cEmail = meta0.email || null;
      const items = meta0.items;
      if (!cBuyer) return res.status(400).json({ error: 'Transaction metadata missing buyerId.' });
      if (callerUid && callerUid !== cBuyer) {
        return res.status(403).json({ error: 'This payment belongs to a different account' });
      }
      if (verifyData.data.currency !== 'NGN') {
        return res.status(400).json({ error: `Unsupported currency: ${verifyData.data.currency}` });
      }
      if (items.length < 1 || items.length > 10) {
        return res.status(400).json({ error: 'Cart must contain 1 to 10 beats.' });
      }
      const seen = new Set();
      for (const it of items) {
        if (!it || typeof it.beatId !== 'string' || !it.beatId || seen.has(it.beatId)) {
          return res.status(400).json({ error: 'Invalid or duplicate beat in cart.' });
        }
        if (it.tier !== 'standard' && it.tier !== 'exclusive') {
          return res.status(400).json({ error: `Unrecognized tier: ${it.tier}` });
        }
        seen.add(it.beatId);
      }
      const cPaidNaira = verifyData.data.amount / 100;
      const cBeatRefs = items.map((it) => db.collection('beats').doc(it.beatId));
      const cSnaps = await Promise.all(cBeatRefs.map((r) => r.get()));
      if (cSnaps.some((sn) => !sn.exists)) {
        return res.status(404).json({ error: 'A beat in this cart no longer exists' });
      }
      const cBeats = cSnaps.map((sn) => sn.data());
      const cPrices = items.map((it, i) => (it.tier === 'exclusive' ? cBeats[i].exclPrice : cBeats[i].price));
      if (cPrices.some((p) => typeof p !== 'number')) {
        return res.status(400).json({ error: 'A beat in this cart has no price for the chosen license' });
      }
      const cTotalUsd = cPrices.reduce((a, b) => a + b, 0);
      const cRate = await getUsdToNgnRate();
      if (cPaidNaira < cTotalUsd * cRate * 0.95) {
        return res.status(402).json({
          error: 'Amount paid is below the expected converted price',
          expectedUsd: cTotalUsd, liveRate: cRate, amountPaidNaira: cPaidNaira,
        });
      }

      refundInfo = { reference, buyerId: cBuyer, cart: true, items, amountPaidNaira: cPaidNaira, email: cEmail };
      // One order doc per beat: <reference>-1, <reference>-2 ... The first one is the replay marker.
      const cOrderRefs = items.map((_, i) => db.collection('orders').doc(`${reference}-${i + 1}`));

      const cIsNew = await db.runTransaction(async (t) => {
        const orderSnaps = await Promise.all(cOrderRefs.map((r) => t.get(r)));
        const freshSnaps = await Promise.all(cBeatRefs.map((r) => t.get(r)));
        if (orderSnaps[0].exists) return false; // replay
        if (freshSnaps.some((sn) => sn.data().soldExclusive)) throw new Error(SOLD_MSG);
        items.forEach((it, i) => {
          if (it.tier === 'exclusive') t.update(cBeatRefs[i], { soldExclusive: true });
          t.set(cOrderRefs[i], {
            buyerId: cBuyer,
            beatId: it.beatId,
            amount: cPrices[i],
            amountPaidNaira: Math.round((cPrices[i] / cTotalUsd) * cPaidNaira * 100) / 100,
            exchangeRateUsed: cRate,
            tier: it.tier,
            email: cEmail,
            status: 'completed',
            paystackReference: reference,
            cartReference: reference,
            beatTitle: cBeats[i].title,
            producerId: cBeats[i].producerId,
            createdAt: new Date().toISOString(),
          });
        });
        return true;
      });

      const cUrls = cBeats.map((b) => buyerDownloadUrl(b, process.env.CLOUDINARY_API_SECRET));
      if (cIsNew) {
        let buyerEmail = cEmail;
        if (!buyerEmail) {
          try {
            const bs = await db.collection('users').doc(cBuyer).get();
            buyerEmail = bs.exists ? bs.data().email : null;
          } catch (e) { /* ignore */ }
        }
        for (let i = 0; i < items.length; i++) {
          try {
            await creditReferralCommission({ buyerId: cBuyer, saleAmountUsd: cPrices[i], beatId: items[i].beatId, reference: `${reference}-${i + 1}` });
          } catch (e) { console.error('Referral commission crediting failed:', e); }
          try {
            await sendDownloadEmail({ toEmail: buyerEmail, beat: { ...cBeats[i], audioUrl: cUrls[i] }, tier: items[i].tier, reference: `${reference}-${i + 1}` });
          } catch (e) { console.error('Download email failed to send:', e); }
        }
      }

      const showLinks = cIsNew || (callerUid && callerUid === cBuyer);
      return res.status(200).json({
        success: true,
        cart: true,
        alreadyProcessed: !cIsNew,
        reference,
        amountPaidNaira: cPaidNaira,
        currency: 'NGN',
        items: items.map((it, i) => ({
          beatId: it.beatId,
          title: cBeats[i].title,
          prod: cBeats[i].prod,
          tier: it.tier,
          audioUrl: showLinks ? cUrls[i] : undefined,
        })),
      });
    }

    const { beatId, buyerId, tier, email } = verifyData.data.metadata || {};
    if (!beatId || !buyerId || !tier) {
      return res.status(400).json({ error: 'Transaction metadata missing beatId/buyerId/tier.' });
    }
    if (tier !== 'standard' && tier !== 'exclusive') {
      return res.status(400).json({ error: `Unrecognized tier: ${tier}` });
    }
    if (callerUid && callerUid !== buyerId) {
      return res.status(403).json({ error: 'This payment belongs to a different account' });
    }

    const currency = verifyData.data.currency;
    if (currency !== 'NGN') {
      return res.status(400).json({ error: `Unsupported currency: ${currency}` });
    }
    const amountPaidNaira = verifyData.data.amount / 100;

    const beatRef = db.collection('beats').doc(beatId);
    const beatSnap = await beatRef.get();
    if (!beatSnap.exists) {
      return res.status(404).json({ error: 'Beat not found' });
    }
    const beat = beatSnap.data();

    // 2. Amount check against the live USD->NGN rate
    const expectedPriceUsd = tier === 'exclusive' ? beat.exclPrice : beat.price;
    if (typeof expectedPriceUsd !== 'number') {
      return res.status(400).json({ error: `Beat has no ${tier} price set` });
    }

    const liveRate = await getUsdToNgnRate();
    const expectedNaira = expectedPriceUsd * liveRate;
    const minAcceptable = expectedNaira * (1 - 0.05);

    if (amountPaidNaira < minAcceptable) {
      return res.status(402).json({
        error: 'Amount paid is below the expected converted price',
        expectedPriceUsd,
        liveRate,
        expectedNaira,
        amountPaidNaira,
      });
    }

    // 3. Record the sale exactly once. The order doc id IS the Paystack
    //    reference, so if it already exists this call is a replay and
    //    nothing below (commission, email) may run a second time.
    refundInfo = { reference, buyerId, beatId, tier, amountPaidNaira, email: email || null };
    const orderRef = db.collection('orders').doc(reference);

    const isNew = await db.runTransaction(async (t) => {
      const [orderSnap, freshBeatSnap] = await Promise.all([t.get(orderRef), t.get(beatRef)]);

      if (orderSnap.exists) return false; // replay — already processed

      const freshBeat = freshBeatSnap.data();
      if (freshBeat.soldExclusive) {
        throw new Error(SOLD_MSG);
      }

      if (tier === 'exclusive') {
        t.update(beatRef, { soldExclusive: true });
      }

      t.set(orderRef, {
        buyerId,
        beatId,
        amount: expectedPriceUsd,
        amountPaidNaira,
        exchangeRateUsed: liveRate,
        tier,
        email: email || null,
        status: 'completed',
        paystackReference: reference,
        beatTitle: beat.title,
        producerId: beat.producerId,
        createdAt: new Date().toISOString(),
      });
      return true;
    });

    // Beat audio is private on Cloudinary: give the buyer a signed full-quality link.
    const downloadUrl = buyerDownloadUrl(beat, process.env.CLOUDINARY_API_SECRET);

    if (isNew) {
      // 4. Referral commission (first time only)
      try {
        await creditReferralCommission({ buyerId, saleAmountUsd: expectedPriceUsd, beatId, reference });
      } catch (referralErr) {
        console.error('Referral commission crediting failed:', referralErr);
      }

      // 5. Download email (first time only)
      try {
        let buyerEmail = email;
        if (!buyerEmail) {
          const buyerSnap = await db.collection('users').doc(buyerId).get();
          buyerEmail = buyerSnap.exists ? buyerSnap.data().email : null;
        }
        await sendDownloadEmail({ toEmail: buyerEmail, beat: { ...beat, audioUrl: downloadUrl }, tier, reference });
      } catch (emailErr) {
        console.error('Download email failed to send:', emailErr);
      }
    }

    return res.status(200).json({
      success: true,
      alreadyProcessed: !isNew,
      reference,
      beatId,
      tier,
      amountPaidNaira,
      currency,
      // On a replay, only the actual buyer gets the link back.
      audioUrl: isNew || (callerUid && callerUid === buyerId) ? downloadUrl : undefined,
    });
  } catch (err) {
    console.error('Payment verification error:', err);

    if (err.message === SOLD_MSG) {
      // The buyer's money was taken but the sale can't be honoured —
      // flag it so it gets refunded in the Paystack dashboard.
      try {
        if (refundInfo) {
          await db.collection('refundsNeeded').doc(reference).set({
            ...refundInfo,
            reason: SOLD_MSG,
            createdAt: new Date().toISOString(),
            resolved: false,
          });
        }
      } catch (e) {
        console.error('Could not record refundsNeeded for', reference, e);
      }
      return res.status(409).json({ error: err.message });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
}
