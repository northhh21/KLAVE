// /api/manage-beat.js
// Admin-only. Adds or removes beats on a managed (unclaimed) profile.
// Needed because firestore.rules require producerId == the caller's own uid,
// so the client can't write a beat on someone else's behalf. The audio itself
// is still uploaded straight to Cloudinary using a signature from /api/upload.
//
// Actions (POST body):
//   { action:'create', managedId, title, bpm, key, genre, mood, price,
//     exclPrice, audioUrl, previewUrl?, coverUrl?, duration }
//   { action:'delete', beatId }

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

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
const ADMIN_UID = 'SlUg15UFENNJglFw9KfRqQNWdkx2';
const CLOUD_RE = /^https:\/\/res\.cloudinary\.com\/dcajo9jib\//;

// Keep in step with firestore.rules (validBeatShape). When you raise the
// floor to $7 / $100, change it here, in the rules and in publishBeat().
const MIN_BASIC_PRICE = 5;
const MIN_EXCL_PRICE = 25;

async function getAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try {
    const d = await getAuth().verifyIdToken(token);
    return d.uid === ADMIN_UID || d.admin === true ? d : null;
  } catch (e) {
    return null;
  }
}

async function getManaged(id) {
  if (typeof id !== 'string' || !id.startsWith('m_')) return null;
  const snap = await db.collection('users').doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (d.managed !== true || d.claimed === true) return null;
  return snap;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await getAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  const b = req.body || {};
  try {
    if (b.action === 'create') {
      const prof = await getManaged(b.managedId);
      if (!prof) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const p = prof.data();

      const title = String(b.title || '').trim();
      if (!title || title.length > 100) return res.status(400).json({ error: 'Title must be 1-100 characters' });
      const price = Number(b.price);
      const exclPrice = b.exclPrice ? Number(b.exclPrice) : 0;
      if (!Number.isFinite(price) || price < MIN_BASIC_PRICE) {
        return res.status(400).json({ error: 'Minimum price is $' + MIN_BASIC_PRICE });
      }
      if (!Number.isFinite(exclPrice) || (exclPrice !== 0 && exclPrice < MIN_EXCL_PRICE)) {
        return res.status(400).json({ error: 'Minimum exclusive price is $' + MIN_EXCL_PRICE });
      }
      // Managed profiles are on the free tier, which has no exclusive pricing.
      if (exclPrice > 0 && (p.tier || 'free') === 'free') {
        return res.status(400).json({ error: 'Exclusive pricing is a paid-tier feature' });
      }

      const audioUrl = String(b.audioUrl || '').replace(/\/s--[^/]+--\//, '/');
      if (!CLOUD_RE.test(audioUrl)) return res.status(400).json({ error: 'Invalid audio URL' });
      const previewUrl = String(b.previewUrl || '');
      if (previewUrl && !CLOUD_RE.test(previewUrl)) return res.status(400).json({ error: 'Invalid preview URL' });
      const coverUrl = String(b.coverUrl || '');
      if (coverUrl && !CLOUD_RE.test(coverUrl)) return res.status(400).json({ error: 'Invalid cover URL' });

      const beatRef = db.collection('beats').doc();
      const batch = db.batch();
      batch.set(beatRef, {
        title,
        bpm: Number(b.bpm) || 0,
        key: String(b.key || '').slice(0, 20),
        genre: String(b.genre || '').toLowerCase().slice(0, 40),
        mood: String(b.mood || '').toLowerCase().slice(0, 40),
        price,
        exclPrice,
        prod: p.displayName,
        producerId: prof.id,
        producerTier: p.tier || 'free',
        audioUrl,
        ...(previewUrl ? { previewUrl } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        duration: Number(b.duration) || 0,
        createdAt: FieldValue.serverTimestamp(),
        plays: 0,
      });
      batch.update(prof.ref, { beatsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      await batch.commit();
      return res.status(200).json({ ok: true, beatId: beatRef.id });
    }

    if (b.action === 'delete') {
      if (typeof b.beatId !== 'string' || !b.beatId) return res.status(400).json({ error: 'beatId required' });
      const beatSnap = await db.collection('beats').doc(b.beatId).get();
      if (!beatSnap.exists) return res.status(404).json({ error: 'Beat not found' });
      const prof = await getManaged(beatSnap.data().producerId);
      if (!prof) return res.status(403).json({ error: 'Only beats on unclaimed managed profiles can be deleted here' });
      await beatSnap.ref.delete();
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('manage-beat failed:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
