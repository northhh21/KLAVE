import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

let db = null;
let initError = null;
function ensureInit() {
  if (db) return;
  if (initError) throw initError;
  try {
    const pk = process.env.FIREBASE_PRIVATE_KEY;
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !pk) {
      throw new Error('Server config missing: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY');
    }
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: pk.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
        }),
      });
    }
    db = getFirestore();
  } catch (e) {
    initError = e;
    throw e;
  }
}
const ADMIN_UID = 'SlUg15UFENNJglFw9KfRqQNWdkx2';

async function requireAdmin(req, res) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return null; }
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    if (!(decoded.admin === true || decoded.uid === ADMIN_UID)) {
      res.status(403).json({ error: 'Admin only' }); return null;
    }
    return decoded;
  } catch (e) {
    res.status(401).json({ error: 'Invalid auth token' }); return null;
  }
}

// /api/admin-users — replaces set-admin-claim.js (delete that file) so no extra
// serverless-function slot is used.
//
// 1) GET /api/admin-users?secret=ADMIN_SETUP_SECRET
//      Same as the old set-admin-claim.js: sets the admin claim on the admin UID only.
// 2) POST (admin only) — admin user tools:
//   { action: 'status', uids: [...] }  -> { status: { uid: { verified } } }
//   { action: 'remove', uid }          -> removes the user, their beats, follows, private data and login

async function deleteQuery(q) {
  ensureInit();
  let n = 0;
  for (;;) {
    const snap = await q.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    n += snap.size;
    if (snap.size < 400) break;
  }
  return n;
}

async function removeUser(req, res, caller) {
  ensureInit();
  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') return res.status(400).json({ error: 'uid required' });
  if (uid === ADMIN_UID || uid === caller.uid) {
    return res.status(400).json({ error: 'You cannot remove the admin account' });
  }
  // Protect sales history.
  const asSeller = await db.collection('orders').where('producerId', '==', uid).limit(1).get();
  const asBuyer = await db.collection('orders').where('buyerId', '==', uid).limit(1).get();
  if (!asSeller.empty || !asBuyer.empty) {
    return res.status(409).json({ error: 'This user has purchase/sales records, so they were not removed.' });
  }
  const beats = await deleteQuery(db.collection('beats').where('producerId', '==', uid));
  await deleteQuery(db.collection('follows').where('followerId', '==', uid));
  await deleteQuery(db.collection('follows').where('followingId', '==', uid));
  await deleteQuery(db.collection('users').doc(uid).collection('private'));
  await db.collection('users').doc(uid).delete();
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  return res.status(200).json({ ok: true, beatsDeleted: beats });
}

async function userStatus(req, res) {
  const raw = req.body && req.body.uids;
  const uids = Array.isArray(raw) ? raw.filter(u => typeof u === 'string').slice(0, 300) : [];
  const status = {};
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    const r = await getAuth().getUsers(chunk.map(uid => ({ uid })));
    r.users.forEach(u => {
      const google = (u.providerData || []).some(p => p.providerId === 'google.com');
      status[u.uid] = { verified: !!u.emailVerified || google };
    });
    r.notFound.forEach(n => { status[n.uid] = { verified: false, missing: true }; });
  }
  return res.status(200).json({ status });
}

export default async function handler(req, res) {
  try { ensureInit(); } catch (e) {
    console.error('admin-users init failed:', e);
    return res.status(500).json({ error: 'Init failed: ' + (e.message || e) });
  }
  // Legacy one-time admin-claim setup (kept from set-admin-claim.js)
  if (req.query && req.query.secret !== undefined) {
    const secret = req.query.secret;
    if (!secret || secret !== process.env.ADMIN_SETUP_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      await getAuth().setCustomUserClaims(ADMIN_UID, { admin: true });
      return res.status(200).json({ success: true, message: 'Admin claim set. Sign out and back in on the app.' });
    } catch (err) {
      console.error('Failed to set admin claim:', err);
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const caller = await requireAdmin(req, res);
  if (!caller) return;
  try {
    const action = req.body && req.body.action;
    if (action === 'remove') return await removeUser(req, res, caller);
    if (action === 'status') return await userStatus(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin-users failed:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
