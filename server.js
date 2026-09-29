require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const admin = require('firebase-admin');

const BH = 'https://bot-hosting.net/api/v1';
const KEY = process.env.BH_API_KEY;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!KEY) { console.error('BH_API_KEY haipo kwenye .env'); process.exit(1); }
if (!ADMIN_EMAIL) { console.error('ADMIN_EMAIL haipo kwenye .env'); process.exit(1); }

// Service account: ama kwa variable FIREBASE_SERVICE_ACCOUNT_JSON (inafaa hosting, hakuna faili kwenye GitHub),
// ama kwa faili serviceAccount.json (kompyuta yako tu).
function loadServiceAccount() {
  let raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8'); // inakubali pia base64
      const sa = JSON.parse(raw);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      return sa;
    } catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT_JSON si JSON sahihi: ' + e.message); process.exit(1); }
  }
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || './serviceAccount.json';
  if (!fs.existsSync(saPath)) {
    console.error('Service account haipo. Weka variable FIREBASE_SERVICE_ACCOUNT_JSON, au faili ' + saPath);
    process.exit(1);
  }
  return require(path.resolve(saPath));
}
admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ---------- bot-hosting.net helper ---------- */
async function bh(method, url, body) {
  const res = await fetch(BH + url, {
    method,
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data.error && (data.error.message || data.error)) || data.message || ('bot-hosting.net ' + res.status));
    err.status = res.status; throw err;
  }
  return data;
}
// Deployment mpya inaweza kuchukua sekunde chache kabla mafaili hayajapatikana: jaribu tena.
async function retry(fn, tries = 8, ms = 3000) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries - 1 || [400, 401, 403, 429].includes(e.status)) throw e;
      await sleep(ms);
    }
  }
}

/* ---------- auth: Firebase ID token + lazima awe ametengenezewa akaunti na admin ---------- */
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Ingia kwanza.' });
    const decoded = await admin.auth().verifyIdToken(h.slice(7), true); // true = kataa akaunti zilizozimwa
    req.uid = decoded.uid;
    req.email = (decoded.email || '').toLowerCase();
    req.isAdmin = req.email === ADMIN_EMAIL;
    if (!req.isAdmin) {
      const ok = (await db.ref(`users/${req.uid}/approved`).get()).val();
      if (ok !== true) return res.status(403).json({ error: 'Akaunti hii haijatengenezwa na msimamizi.' });
    }
    next();
  } catch { res.status(401).json({ error: 'Session imeisha au akaunti imezimwa. Ingia tena.' }); }
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Ni kwa msimamizi tu.' });
  next();
}
const botRef = (uid) => db.ref(`users/${uid}/bot`);
async function getBot(uid) { return (await botRef(uid).get()).val(); }
async function needBot(req, res) {
  const bot = await getBot(req.uid);
  if (!bot || !bot.deploymentId) { res.status(404).json({ error: 'Bado hujaupload bot.' }); return null; }
  return bot;
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e.message);
  const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  res.status(code === 401 ? 502 : code).json({ error: e.message });
});

/* ---------- login kupitia seva (Firebase Auth REST) - browser haihitaji Firebase SDK ---------- */
const WEB_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyALCj5EHqEnEAMpGQRnZ9vaGkXRHJ7aFyc';
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); attempts.set(ip, a); return a.length > 10;
}
function fbError(code) {
  code = String(code || '');
  if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|INVALID_EMAIL/.test(code)) return 'Email au password si sahihi.';
  if (/USER_DISABLED/.test(code)) return 'Akaunti yako imezimwa na msimamizi.';
  if (/TOO_MANY_ATTEMPTS/.test(code)) return 'Umejaribu mara nyingi. Subiri dakika chache.';
  if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(code)) return 'Email/Password haijawashwa kwenye Firebase Authentication > Sign-in method.';
  if (/API_KEY|API key|REFERER|blocked/i.test(code)) return 'Firebase API key ina tatizo au imewekewa restrictions (Google Cloud > Credentials).';
  return 'Kuingia kumeshindikana (' + code + ').';
}
app.post('/api/login', wrap(async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Umejaribu mara nyingi. Subiri dakika moja.' });
  const email = String(req.body.email || '').trim(), password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Weka email na password.' });
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + WEB_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(401).json({ error: fbError(j.error && j.error.message) });
  const decoded = await admin.auth().verifyIdToken(j.idToken);
  const isAdmin = (decoded.email || '').toLowerCase() === ADMIN_EMAIL;
  if (!isAdmin) {
    const ok = (await db.ref(`users/${decoded.uid}/approved`).get()).val();
    if (ok !== true) return res.status(403).json({ error: 'Password ni sahihi, lakini ' + (decoded.email || email) + ' si admin na haijafunguliwa kupitia kichupo cha Watumiaji. Kama wewe ni admin: weka email hii kwenye ADMIN_EMAIL kwenye faili la .env, kisha zima na uwashe seva (npm start).' });
  }
  res.json({ idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: Number(j.expiresIn) || 3600, email: decoded.email, admin: isAdmin });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  const rt = String(req.body.refreshToken || '');
  if (!rt) return res.status(400).json({ error: 'Session haipo.' });
  const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + WEB_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(401).json({ error: 'Session imeisha. Ingia tena.' });
  res.json({ idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: Number(j.expires_in) || 3600 });
}));

/* ---------- me ---------- */
app.get('/api/me', auth, (req, res) => res.json({ email: req.email, admin: req.isAdmin }));

/* ---------- upload ---------- */
const isText = (buf) => !buf.subarray(0, 4000).includes(0);

async function ensureDirs(id, filePath, made) {
  const parts = filePath.split('/').filter(Boolean); parts.pop();
  let root = '/';
  for (const name of parts) {
    const full = root + name;
    if (!made.has(full)) {
      await bh('POST', `/deployments/${id}/files/folder`, { root, name }).catch(() => {});
      made.add(full);
    }
    root = full + '/';
  }
}

app.post('/api/upload', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chagua faili la bot.' });
  const name = req.file.originalname;
  let files = [];

  if (/\.zip$/i.test(name)) {
    let zip;
    try { zip = new AdmZip(req.file.buffer); } catch { return res.status(400).json({ error: 'Zip imeharibika au si zip sahihi.' }); }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.includes('node_modules/') && !e.entryName.startsWith('__MACOSX') && !e.entryName.includes('..'));
    const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
    const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/'));
    for (const e of entries) {
      const buf = e.getData();
      if (!isText(buf) || buf.length > 2 * 1024 * 1024) continue;
      files.push({ path: '/' + (strip ? e.entryName.split('/').slice(1).join('/') : e.entryName), content: buf.toString('utf8') });
    }
  } else {
    if (!isText(req.file.buffer)) return res.status(400).json({ error: 'Faili si la maandishi. Tumia .js, .py, .json au .zip.' });
    files.push({ path: '/' + name.replace(/[\\/]/g, '_'), content: req.file.buffer.toString('utf8') });
  }
  if (!files.length) return res.status(400).json({ error: 'Hakuna faili la code ndani ya zip.' });

  const isPy = files.some((f) => f.path.endsWith('.py') || f.path.endsWith('requirements.txt'));
  const runtime = isPy ? (process.env.RUNTIME_PYTHON || 'python') : (process.env.RUNTIME_NODE || 'nodejs');

  let bot = await getBot(req.uid);
  if (!bot || !bot.deploymentId) {
    const d = await bh('POST', '/deployments', {
      name: 'josvexa-' + req.uid.slice(0, 8),
      description: 'JOSVEXA BOT HOST - ' + req.email,
      source: 'blank',
      runtime
    });
    bot = { deploymentId: d.deployment.id, createdAt: Date.now() };
    await botRef(req.uid).set(bot); // hifadhi mara moja ili deployment isipotee kama kitu kitafeli baadaye
  } else {
    await bh('POST', `/deployments/${bot.deploymentId}/power`, { action: 'stop' }).catch(() => {});
  }

  const id = bot.deploymentId, made = new Set();
  for (const f of files) {
    await retry(() => ensureDirs(id, f.path, made));
    await retry(() => bh('POST', `/deployments/${id}/files/content`, { path: f.path, content: f.content }));
  }

  const step = bot.phone ? 'ready' : 'phone';
  await botRef(req.uid).update({ fileName: name, fileCount: files.length, runtime, uploadedAt: Date.now(), step });
  if (bot.phone) await bh('POST', `/deployments/${id}/power`, { action: 'restart' }).catch(() => {});
  res.json({ ok: true, files: files.length, step });
}));

/* ---------- namba ya simu ---------- */
app.post('/api/phone', auth, wrap(async (req, res) => {
  const bot = await needBot(req, res); if (!bot) return;
  const phone = String(req.body.phone || '').replace(/[^\d]/g, '');
  if (phone.length < 9 || phone.length > 15) return res.status(400).json({ error: 'Weka namba kamili na code ya nchi, mfano 255712345678.' });
  const id = bot.deploymentId;
  for (const key of ['PHONE_NUMBER', 'OWNER_NUMBER']) {
    await retry(() => bh('POST', `/deployments/${id}/env`, { key, value: phone, secret: false }));
  }
  await retry(() => bh('POST', `/deployments/${id}/files/content`, { path: '/phone.txt', content: phone }));
  await botRef(req.uid).update({ phone, step: 'ready', phoneAt: Date.now() });
  await bh('POST', `/deployments/${id}/power`, { action: 'restart' });
  res.json({ ok: true });
}));

/* ---------- power / command / logs / status ---------- */
app.post('/api/power', auth, wrap(async (req, res) => {
  const bot = await needBot(req, res); if (!bot) return;
  const action = req.body.action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) return res.status(400).json({ error: 'Action si sahihi.' });
  res.json(await bh('POST', `/deployments/${bot.deploymentId}/power`, { action }));
}));

app.post('/api/command', auth, wrap(async (req, res) => {
  const bot = await needBot(req, res); if (!bot) return;
  const command = String(req.body.command || '').trim();
  if (!command || command.length > 500) return res.status(400).json({ error: 'Command haifai.' });
  res.json(await bh('POST', `/deployments/${bot.deploymentId}/command`, { command }));
}));

const logCache = new Map();
app.get('/api/logs', auth, wrap(async (req, res) => {
  const bot = await needBot(req, res); if (!bot) return;
  const c = logCache.get(bot.deploymentId);
  if (c && Date.now() - c.t < 2500) return res.json(c.data);
  const data = await bh('GET', `/deployments/${bot.deploymentId}/logs?size=65536`);
  logCache.set(bot.deploymentId, { t: Date.now(), data });
  res.json(data);
}));

const resCache = new Map();
app.get('/api/status', auth, wrap(async (req, res) => {
  const bot = await getBot(req.uid);
  if (!bot || !bot.deploymentId) return res.json({ bot: null, resources: null });
  let r = null;
  const c = resCache.get(bot.deploymentId);
  if (c && Date.now() - c.t < 4000) r = c.data;
  else {
    try { r = await bh('GET', `/deployments/${bot.deploymentId}/resources`); resCache.set(bot.deploymentId, { t: Date.now(), data: r }); }
    catch { r = null; } // seva bado inajiandaa: usivunje dashibodi
  }
  res.json({ bot: { fileName: bot.fileName, fileCount: bot.fileCount, phone: bot.phone || null, step: bot.step || 'upload', runtime: bot.runtime }, resources: r });
}));

/* ================= ADMIN: kutengeneza na kusimamia watumiaji ================= */
app.get('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
  const list = await admin.auth().listUsers(1000);
  const all = (await db.ref('users').get()).val() || {};
  res.json({
    users: list.users.map((u) => {
      const d = all[u.uid] || {}, b = d.bot || {};
      return {
        uid: u.uid, email: u.email, disabled: u.disabled,
        isAdmin: (u.email || '').toLowerCase() === ADMIN_EMAIL, approved: d.approved === true,
        createdAt: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime || null,
        bot: b.deploymentId ? { fileName: b.fileName || null, phone: b.phone || null, step: b.step || null } : null
      };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
}));

app.post('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Barua pepe si sahihi.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password iwe na angalau herufi 6.' });
  try {
    const u = await admin.auth().createUser({ email, password, emailVerified: true });
    await db.ref(`users/${u.uid}`).update({ approved: true, createdAt: Date.now(), createdBy: req.email });
    res.json({ ok: true, uid: u.uid });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') return res.status(409).json({ error: 'Barua pepe hii tayari ipo.' });
    throw e;
  }
}));

app.post('/api/admin/users/:uid/password', auth, adminOnly, wrap(async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password iwe na angalau herufi 6.' });
  await admin.auth().updateUser(req.params.uid, { password });
  await admin.auth().revokeRefreshTokens(req.params.uid);
  res.json({ ok: true });
}));

app.post('/api/admin/users/:uid/disable', auth, adminOnly, wrap(async (req, res) => {
  const u = await admin.auth().getUser(req.params.uid);
  if ((u.email || '').toLowerCase() === ADMIN_EMAIL) return res.status(400).json({ error: 'Huwezi kuzima akaunti ya admin.' });
  const disabled = !!req.body.disabled;
  await admin.auth().updateUser(u.uid, { disabled });
  if (disabled) {
    await admin.auth().revokeRefreshTokens(u.uid);
    const bot = await getBot(u.uid);
    if (bot && bot.deploymentId) await bh('POST', `/deployments/${bot.deploymentId}/power`, { action: 'stop' }).catch(() => {});
  }
  res.json({ ok: true, disabled });
}));

app.delete('/api/admin/users/:uid', auth, adminOnly, wrap(async (req, res) => {
  const u = await admin.auth().getUser(req.params.uid);
  if ((u.email || '').toLowerCase() === ADMIN_EMAIL) return res.status(400).json({ error: 'Huwezi kufuta akaunti ya admin.' });
  const bot = await getBot(u.uid);
  if (bot && bot.deploymentId) await bh('DELETE', `/deployments/${bot.deploymentId}`).catch((e) => console.error('delete deployment:', e.message));
  await admin.auth().deleteUser(u.uid);
  await db.ref(`users/${u.uid}`).remove();
  res.json({ ok: true });
}));

/* ---------- makosa ya multer / JSON kama JSON safi ---------- */
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Faili ni kubwa kuliko 20MB.' });
  console.error(err);
  res.status(500).json({ error: 'Hitilafu ya seva.' });
});

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log('JOSVEXA BOT HOST iko hewani: http://localhost:' + port);
  // Ukaguzi wa mwanzo ili kila tatizo la mpangilio lionekane mapema
  try { await bh('GET', '/deployments'); console.log('[OK] API key ya bot-hosting.net inafanya kazi'); }
  catch (e) { console.error('[TATIZO] bot-hosting.net: ' + e.message + ' (angalia BH_API_KEY na scopes)'); }
  try { await db.ref('.info/serverTimeOffset').get(); console.log('[OK] Firebase Realtime Database imeunganishwa'); }
  catch (e) { console.error('[TATIZO] Firebase Database: ' + e.message); }
  try { await admin.auth().listUsers(1); console.log('[OK] Firebase Auth imeunganishwa'); }
  catch (e) { console.error('[TATIZO] Firebase Auth: ' + e.message); }
  try { const u = await admin.auth().getUserByEmail(ADMIN_EMAIL); console.log('[OK] Admin ' + u.email + ' yupo'); }
  catch { console.error('[TATIZO] Admin ' + ADMIN_EMAIL + ' hayupo kwenye Firebase Authentication > Users. Mtengeneze kwanza.'); }
});
