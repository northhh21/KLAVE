// lib/managed.js
// Managed producer profiles: create/edit/claim, beats on their behalf, and
// payment tracking. Lives in /lib (not /api) on purpose: Vercel's Hobby plan
// allows at most 12 serverless functions, and every file in /api counts as
// one. This is called from api/upload.js, which already routes by `action`,
// so it adds zero functions.
//
// Actions (all arrive as POST /api/upload with the caller's ID token):
//   managed-create          admin  { displayName, bio?, photoURL? } -> { id, code }
//   managed-update          admin  { id, displayName?, bio?, photoURL? }
//   managed-new-code        admin  { id } -> { id, code }
//   managed-record-payment  admin  { id, amount (USD), note? }
//   managed-beat-create     admin  { managedId, title, bpm, key, genre, mood, price,
//                                    exclPrice, audioUrl, previewUrl?, coverUrl?, duration }
//   managed-beat-delete     admin  { beatId }
//   managed-claim           the producer's own token (email verified) { id, code }
//
// Claim codes are stored only as a hash in users/m_xxxx/private/claim, because
// users/{id} is readable by every signed-in user.
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const ADMIN_UID = 'SlUg15UFENNJglFw9KfRqQNWdkx2';
const CLOUD_RE = /^https:\/\/res\.cloudinary\.com\/dcajo9jib\//;

// Keep in step with firestore.rules (validBeatShape) and publishBeat().
// When the floor goes to $7 / $100, change it in all three places.
const MIN_BASIC_PRICE = 5;
const MIN_EXCL_PRICE = 25;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newCode = () => randomBytes(9).toString('base64url'); // 12 chars, ~72 bits
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const isManagedAction = (a) => typeof a === 'string' && a.startsWith('managed-');

export async function handleManaged({ action, body, decoded, res, admin }) {
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const isAdminCaller = decoded.uid === ADMIN_UID || decoded.admin === true;

  async function getManaged(id) {
    if (typeof id !== 'string' || !id.startsWith('m_')) return null;
    const snap = await db.collection('users').doc(id).get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (d.managed !== true || d.claimed === true) return null;
    return snap;
  }
  async function inChunks(docs, fn) {
    for (let i = 0; i < docs.length; i += 200) {
      const batch = db.batch();
      docs.slice(i, i + 200).forEach((d) => fn(batch, d));
      await batch.commit();
    }
  }

  try {
    // ── the producer's own action ──
    if (action === 'managed-claim') {
      if (decoded.email_verified !== true) {
        return res.status(403).json({ error: 'Verify your email first', retry: true });
      }
      const uid = decoded.uid;
      const { id, code } = body;
      if (typeof id !== 'string' || !id.startsWith('m_') || typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'Invalid claim link' });
      }
      const mRef = db.collection('users').doc(id);
      const claimRef = mRef.collection('private').doc('claim');
      const [mSnap, claimSnap, userSnap] = await Promise.all([mRef.get(), claimRef.get(), db.collection('users').doc(uid).get()]);

      // One generic message for every mismatch so links can't be probed.
      if (!mSnap.exists || mSnap.data().managed !== true || !claimSnap.exists || !sameHash(claimSnap.data().codeHash, sha256(code))) {
        return res.status(403).json({ error: 'This claim link is invalid or has already been used' });
      }
      if (!userSnap.exists) {
        return res.status(404).json({ error: 'Finish signing up first, then open the link again', retry: true });
      }
      const m = mSnap.data();
      const u = userSnap.data();
      const tier = u.tier || 'free';
      const displayName = m.displayName || u.displayName || u.username || '';

      // Beats, then orders, then followers (safe to retry if it dies half way).
      const beats = await db.collection('beats').where('producerId', '==', id).get();
      await inChunks(beats.docs, (b, d) => b.update(d.ref, { producerId: uid, prod: displayName, producerTier: tier }));

      const orders = await db.collection('orders').where('producerId', '==', id).get();
      await inChunks(orders.docs, (b, d) => b.update(d.ref, { producerId: uid }));

      const follows = await db.collection('follows').where('followingId', '==', id).get();
      await inChunks(follows.docs, (b, d) => {
        const f = d.data();
        if (f.followerId && f.followerId !== uid) {
          b.set(db.collection('follows').doc(f.followerId + '_' + uid), { ...f, followingId: uid });
        }
        b.delete(d.ref);
      });

      // Finish: upgrade the real account, carry payment history over, kill the code.
      const payRef = mRef.collection('private').doc('payments');
      const paySnap = await payRef.get();
      const fin = db.batch();
      if (paySnap.exists) {
        const pd = paySnap.data();
        fin.set(
          db.collection('users').doc(uid).collection('private').doc('payments'),
          {
            paidTotal: FieldValue.increment(pd.paidTotal || 0),
            ...((pd.entries || []).length ? { entries: FieldValue.arrayUnion(...pd.entries) } : {}),
          },
          { merge: true }
        );
        fin.delete(payRef);
      }
      fin.set(
        db.collection('users').doc(uid),
        {
          role: 'producer',
          displayName,
          ...(m.bio && !u.bio ? { bio: m.bio } : {}),
          ...(m.photoURL && !u.photoURL ? { photoURL: m.photoURL } : {}),
          beatsCount: (u.beatsCount || 0) + beats.size,
          claimedFrom: id,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      fin.delete(claimRef);
      fin.delete(mRef);
      await fin.commit();
      return res.status(200).json({ claimed: true, beats: beats.size });
    }

    // ── everything else is admin-only ──
    if (!isAdminCaller) return res.status(403).json({ error: 'Admin only' });

    if (action === 'managed-create') {
      const displayName = String(body.displayName || '').trim();
      const bio = String(body.bio || '').trim();
      const photoURL = String(body.photoURL || '').trim();
      if (!displayName || displayName.length > 60) return res.status(400).json({ error: 'Name must be 1-60 characters' });
      if (bio.length > 300) return res.status(400).json({ error: 'Bio is max 300 characters' });
      if (photoURL && !CLOUD_RE.test(photoURL)) return res.status(400).json({ error: 'Photo must be a KLAVE Cloudinary URL' });
      const id = 'm_' + randomBytes(8).toString('hex');
      const code = newCode();
      const batch = db.batch();
      batch.set(db.collection('users').doc(id), {
        displayName,
        bio,
        ...(photoURL ? { photoURL } : {}),
        role: 'producer',
        tier: 'free',
        beatsCount: 0,
        managed: true,
        claimed: false,
        managedBy: decoded.uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(db.collection('users').doc(id).collection('private').doc('claim'), {
        codeHash: sha256(code),
        createdAt: FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return res.status(200).json({ id, code });
    }

    if (action === 'managed-update') {
      const snap = await getManaged(body.id);
      if (!snap) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const patch = { updatedAt: FieldValue.serverTimestamp() };
      let newName = null;
      if (body.displayName !== undefined) {
        const n = String(body.displayName).trim();
        if (!n || n.length > 60) return res.status(400).json({ error: 'Name must be 1-60 characters' });
        patch.displayName = n;
        newName = n;
      }
      if (body.bio !== undefined) {
        const b = String(body.bio).trim();
        if (b.length > 300) return res.status(400).json({ error: 'Bio is max 300 characters' });
        patch.bio = b;
      }
      if (body.photoURL !== undefined) {
        const p = String(body.photoURL).trim();
        if (p && !CLOUD_RE.test(p)) return res.status(400).json({ error: 'Photo must be a KLAVE Cloudinary URL' });
        patch.photoURL = p;
      }
      await snap.ref.update(patch);
      if (newName) {
        const beats = await db.collection('beats').where('producerId', '==', snap.id).get();
        await inChunks(beats.docs, (b, d) => b.update(d.ref, { prod: newName }));
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'managed-new-code') {
      const snap = await getManaged(body.id);
      if (!snap) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const code = newCode();
      await snap.ref.collection('private').doc('claim').set({ codeHash: sha256(code), createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ id: snap.id, code });
    }

    if (action === 'managed-record-payment') {
      const snap = await getManaged(body.id);
      if (!snap) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        return res.status(400).json({ error: 'Enter a valid amount in USD' });
      }
      const note = String(body.note || '').trim().slice(0, 100);
      await snap.ref.collection('private').doc('payments').set(
        {
          paidTotal: FieldValue.increment(amount),
          entries: FieldValue.arrayUnion({ amount, note, at: new Date().toISOString() }),
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'managed-beat-create') {
      const prof = await getManaged(body.managedId);
      if (!prof) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const p = prof.data();
      const title = String(body.title || '').trim();
      if (!title || title.length > 100) return res.status(400).json({ error: 'Title must be 1-100 characters' });
      const price = Number(body.price);
      const exclPrice = body.exclPrice ? Number(body.exclPrice) : 0;
      if (!Number.isFinite(price) || price < MIN_BASIC_PRICE) {
        return res.status(400).json({ error: 'Minimum price is $' + MIN_BASIC_PRICE });
      }
      if (!Number.isFinite(exclPrice) || (exclPrice !== 0 && exclPrice < MIN_EXCL_PRICE)) {
        return res.status(400).json({ error: 'Minimum exclusive price is $' + MIN_EXCL_PRICE });
      }
      // Exclusive pricing is allowed on managed profiles even though they're on
      // the free tier (admin-curated). The free-tier exclusive block still
      // applies to producers uploading for themselves.
      const audioUrl = String(body.audioUrl || '').replace(/\/s--[^/]+--\//, '/');
      if (!CLOUD_RE.test(audioUrl)) return res.status(400).json({ error: 'Invalid audio URL' });
      const previewUrl = String(body.previewUrl || '');
      if (previewUrl && !CLOUD_RE.test(previewUrl)) return res.status(400).json({ error: 'Invalid preview URL' });
      const coverUrl = String(body.coverUrl || '');
      if (coverUrl && !CLOUD_RE.test(coverUrl)) return res.status(400).json({ error: 'Invalid cover URL' });

      const beatRef = db.collection('beats').doc();
      const batch = db.batch();
      batch.set(beatRef, {
        title,
        bpm: Number(body.bpm) || 0,
        key: String(body.key || '').slice(0, 20),
        genre: String(body.genre || '').toLowerCase().slice(0, 40),
        mood: String(body.mood || '').toLowerCase().slice(0, 40),
        price,
        exclPrice,
        prod: p.displayName,
        producerId: prof.id,
        producerTier: p.tier || 'free',
        audioUrl,
        ...(previewUrl ? { previewUrl } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        duration: Number(body.duration) || 0,
        createdAt: FieldValue.serverTimestamp(),
        plays: 0,
      });
      batch.update(prof.ref, { beatsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      await batch.commit();
      return res.status(200).json({ ok: true, beatId: beatRef.id });
    }

    if (action === 'managed-beat-delete') {
      if (typeof body.beatId !== 'string' || !body.beatId) return res.status(400).json({ error: 'beatId required' });
      const beatSnap = await db.collection('beats').doc(body.beatId).get();
      if (!beatSnap.exists) return res.status(404).json({ error: 'Beat not found' });
      const prof = await getManaged(beatSnap.data().producerId);
      if (!prof) return res.status(403).json({ error: 'Only beats on unclaimed managed profiles can be deleted here' });
      await beatSnap.ref.delete();
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('managed action failed:', action, err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
