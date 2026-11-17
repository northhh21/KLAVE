// /api/managed-profile.js
// Admin-only. Creates and edits "managed" producer profiles: profiles you run
// for producers who haven't signed up yet. They live in users/m_xxxx so the
// existing profile page, producers strip and beat grouping work unchanged.
// The claim code is stored as a HASH in users/m_xxxx/private/claim, which only
// the admin can read and only server code can write (users/{id} itself is
// readable by every signed-in user, so the code must never go there).
//
// Actions (POST body):
//   { action:'create', displayName, bio?, photoURL? } -> { id, code }
//   { action:'update', id, displayName?, bio?, photoURL? }
//   { action:'new-code', id }                         -> { id, code }

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { randomBytes, createHash } from 'crypto';

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
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

function newCode() {
  return randomBytes(9).toString('base64url'); // 12 chars, ~72 bits
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await getAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  const body = req.body || {};
  try {
    if (body.action === 'create') {
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
        managedBy: admin.uid,
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

    if (body.action === 'update') {
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
      // Each beat stores the producer's name, so keep them in sync.
      if (newName) {
        const beats = await db.collection('beats').where('producerId', '==', snap.id).get();
        for (let i = 0; i < beats.docs.length; i += 400) {
          const b = db.batch();
          beats.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { prod: newName }));
          await b.commit();
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'new-code') {
      const snap = await getManaged(body.id);
      if (!snap) return res.status(404).json({ error: 'Managed profile not found (or already claimed)' });
      const code = newCode();
      await snap.ref.collection('private').doc('claim').set({
        codeHash: sha256(code),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ id: snap.id, code });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('managed-profile failed:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
