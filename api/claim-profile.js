// /api/claim-profile.js
// A producer who signed up normally opens their claim link (?claim=CODE&p=m_xxx)
// and this moves everything on the managed profile onto their real account:
// beats, orders and followers. Auth is the claimer's own Firebase ID token
// (email must be verified), and the code is checked against the hash in
// users/m_xxx/private/claim. Safe to retry: if it dies half way, the code is
// still valid and the queries below simply pick up what's left.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { createHash, timingSafeEqual } from 'crypto';

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
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

async function inChunks(docs, fn) {
  for (let i = 0; i < docs.length; i += 200) {
    const batch = db.batch();
    docs.slice(i, i + 200).forEach((d) => fn(batch, d));
    await batch.commit();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid auth token' });
  }
  if (decoded.email_verified !== true) {
    return res.status(403).json({ error: 'Verify your email first', retry: true });
  }
  const uid = decoded.uid;

  const { id, code } = req.body || {};
  if (typeof id !== 'string' || !id.startsWith('m_') || typeof code !== 'string' || !code) {
    return res.status(400).json({ error: 'Invalid claim link' });
  }

  try {
    const mRef = db.collection('users').doc(id);
    const claimRef = mRef.collection('private').doc('claim');
    const [mSnap, claimSnap, userSnap] = await Promise.all([mRef.get(), claimRef.get(), db.collection('users').doc(uid).get()]);

    // One generic message for every "doesn't match" case so links can't be probed.
    if (!mSnap.exists || mSnap.data().managed !== true || !claimSnap.exists || !sameHash(claimSnap.data().codeHash, sha256(code))) {
      return res.status(403).json({ error: 'This claim link is invalid or has already been used' });
    }
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Finish signing up first, then open the link again', retry: true });
    }

    const m = mSnap.data();
    const u = userSnap.data();
    const tier = u.tier || 'free';
    const displayName = m.displayName || u.displayName || (u.username || '');

    // 1) Beats
    const beats = await db.collection('beats').where('producerId', '==', id).get();
    await inChunks(beats.docs, (b, d) => b.update(d.ref, { producerId: uid, prod: displayName, producerTier: tier }));

    // 2) Orders (so sales show up for the real producer)
    const orders = await db.collection('orders').where('producerId', '==', id).get();
    await inChunks(orders.docs, (b, d) => b.update(d.ref, { producerId: uid }));

    // 3) Followers: follow docs are named followerId_followingId, so re-create them.
    const follows = await db.collection('follows').where('followingId', '==', id).get();
    await inChunks(follows.docs, (b, d) => {
      const f = d.data();
      if (f.followerId && f.followerId !== uid) {
        b.set(db.collection('follows').doc(f.followerId + '_' + uid), { ...f, followingId: uid });
      }
      b.delete(d.ref);
    });

    // 4) Finish: upgrade the real account, kill the code, remove the shell profile.
    const fin = db.batch();
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
  } catch (err) {
    console.error('claim-profile failed:', err);
    return res.status(500).json({ error: 'Could not claim profile, try again' });
  }
}
