'use strict';
/**
 * Crimson Market — خادم بدون أي اعتمادات خارجية (Node >= 22.13)
 * الأمان: scrypt لكلمات المرور، جلسات HttpOnly في SQLite، حماية CSRF،
 * تحديد معدل الطلبات، قفل الحساب بعد محاولات فاشلة، ترويسات أمان صارمة (CSP...).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- تحميل .env بسيط ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const PP_ENV = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const PP_BASE = PP_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const PP_ID = process.env.PAYPAL_CLIENT_ID || '';
const PP_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PP_READY = Boolean(PP_ID && PP_SECRET);
const SESSION_TTL = 1000 * 60 * 60 * 8; // 8 ساعات
const PUBLIC = path.join(__dirname, 'public');

// ---------- قاعدة البيانات ----------
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'market.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL, paypal_email TEXT, fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id INTEGER, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL, price_cents INTEGER NOT NULL,
  category TEXT NOT NULL, image TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, paypal_order_id TEXT UNIQUE NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id), amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, thread_user INTEGER NOT NULL REFERENCES users(id),
  from_admin INTEGER NOT NULL, body TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
`);
for (const sql of [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN ban_reason TEXT",
  "ALTER TABLE items ADD COLUMN images TEXT",
  "ALTER TABLE items ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
]) { try { db.exec(sql); } catch {} }
if (process.argv.includes('--init-only')) { module.exports = { db }; return; } // يُستخدم من setup-admin.js
const UPLOADS = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const q = (sql) => db.prepare(sql);

// ---------- كلمات المرور (scrypt) ----------
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString('hex')}$${(await scrypt(pw, salt)).toString('hex')}`;
}
async function verifyPw(pw, stored) {
  const parts = String(stored).split('$');
  let calc, h;
  if (parts[0] === 's2') { // حسابات الإدارة: scrypt بتكلفة عالية جداً  s2$N$r$p$salt$hash
    const [, N, r, p, salt, hash] = parts; h = hash;
    calc = await new Promise((res, rej) => crypto.scrypt(pw, Buffer.from(salt, 'hex'), 64,
      { N: +N, r: +r, p: +p, maxmem: 512 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  } else { h = parts[2]; calc = await scrypt(pw, Buffer.from(parts[1], 'hex')); }
  const want = Buffer.from(h, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
let DUMMY; // لتفادي كشف وجود الحساب عبر الزمن
hashPw('dummy-password').then((h) => (DUMMY = h));

// ---------- بذر بيانات تجريبية ----------
if (!q('SELECT 1 FROM users').get()) {
  const seedPw = crypto.randomBytes(24).toString('hex');
  hashPw(seedPw).then((h) => {
    const u = q('INSERT INTO users(username,email,pass,created_at) VALUES(?,?,?,?)')
      .run('crimson_house', 'house@crimson.invalid', h, Date.now());
    const add = q('INSERT INTO items(seller_id,title,description,price_cents,category,image,created_at) VALUES(?,?,?,?,?,?,?)');
    [
      ['ساعة يد كلاسيكية سوداء', 'ساعة أوتوماتيكية بهيكل أسود مطفي وسوار جلد أحمر. حالة ممتازة مع الصندوق الأصلي.', 89900, 'إكسسوارات'],
      ['جاكيت جلد فاخر', 'جاكيت جلد طبيعي أسود بتبطين أحمر حريري، مقاس L. لبس مرتين فقط.', 34500, 'أزياء'],
      ['سماعات استوديو محترفة', 'سماعات مغلقة بجودة صوت عالية، مع كيبل مضفر وحافظة.', 21000, 'إلكترونيات'],
      ['كاميرا عتيقة 35mm', 'كاميرا فيلم كلاسيكية تعمل بكفاءة، مناسبة للهواة والمقتنين.', 48000, 'مقتنيات'],
      ['لوحة فنية "الجمرة"', 'لوحة زيتية أصلية 80×60 سم بإطار أسود، بدرجات الأحمر القاني.', 125000, 'فن'],
      ['لابتوب ألعاب مضيء', 'لابتوب بإضاءة حمراء، معالج قوي وبطاقة رسوميات حديثة. ضمان سنة.', 142000, 'إلكترونيات'],
    ].forEach(([t, d, p, c]) => add.run(u.lastInsertRowid, t, d, p, c, null, Date.now()));
  });
}

// ---------- أدوات مساعدة ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://api-m.paypal.com https://api-m.sandbox.paypal.com",
  "frame-src https://www.paypal.com https://www.sandbox.paypal.com",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function secHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Powered-By', '');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++e.n > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();
setInterval(() => q('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 600000).unref();

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const fail = (res, code, msg) => json(res, code, { error: msg });

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad')); } });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
}
function setSessionCookie(res, sid, maxAgeSec) {
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${PROD ? '; Secure' : ''}`);
}
function loadSession(req, res) {
  const sid = getCookie(req, 'sid');
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    const s = q('SELECT * FROM sessions WHERE id=? AND expires>?').get(sid, Date.now());
    if (s) return s;
  }
  const id = crypto.randomBytes(32).toString('hex');
  const s = { id, user_id: null, csrf: crypto.randomBytes(24).toString('hex'), expires: Date.now() + SESSION_TTL };
  q('INSERT INTO sessions(id,user_id,csrf,expires) VALUES(?,?,?,?)').run(s.id, null, s.csrf, s.expires);
  setSessionCookie(res, id, SESSION_TTL / 1000);
  return s;
}
const currentUser = (s) => (s.user_id ? q('SELECT id,username,email,paypal_email,role,banned FROM users WHERE id=?').get(s.user_id) : null);

// ---------- التحقق من المدخلات ----------
const reEmail = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const CATS = ['إلكترونيات', 'أزياء', 'إكسسوارات', 'مقتنيات', 'فن', 'منزل', 'سيارات', 'أخرى'];
function safeImage(u) {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' && u.length < 500 ? x.href : undefined; } catch { return undefined; }
}
const publicItem = (r) => ({ id: r.id, title: r.title, description: r.description, price: r.price_cents / 100,
  category: r.category, image: r.image, images: (() => { try { return JSON.parse(r.images || '[]'); } catch { return []; } })(),
  verified: !!r.verified, status: r.status, seller: r.seller, sellerId: r.seller_id, createdAt: r.created_at });

// ---------- PayPal ----------
async function ppToken() {
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${PP_ID}:${PP_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  if (!r.ok) throw new Error('paypal-auth');
  return (await r.json()).access_token;
}
async function ppApi(method, url, body) {
  const token = await ppToken();
  const r = await fetch(PP_BASE + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    'PayPal-Request-Id': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('paypal-' + r.status);
  return data;
}

// ---------- المسارات ----------
const routes = {};
const route = (m, p, fn) => (routes[`${m} ${p}`] = fn);

route('GET', '/api/session', async ({ s, user }) => ({ user, csrf: s.csrf, categories: CATS, paypal: PP_READY ? { clientId: PP_ID, env: PP_ENV } : null }));

route('POST', '/api/register', async ({ body, req, res, s }) => {
  if (limited('reg:' + req.ip, 5, 3600000)) return [429, 'محاولات كثيرة، حاول لاحقاً'];
  const username = clean(body.username, 20), email = clean(body.email, 120).toLowerCase(), pw = String(body.password || '');
  if (!/^[\p{L}\p{N}_]{3,20}$/u.test(username)) return [400, 'اسم المستخدم 3-20 حرفاً (حروف وأرقام و _ فقط)'];
  if (!reEmail.test(email)) return [400, 'بريد إلكتروني غير صالح'];
  if (pw.length < 10 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return [400, 'كلمة المرور 10 أحرف على الأقل وتحتوي حرفاً ورقماً'];
  if (q('SELECT 1 FROM users WHERE username=? OR email=?').get(username, email)) return [409, 'الاسم أو البريد مستخدم مسبقاً'];
  const r = q('INSERT INTO users(username,email,pass,created_at) VALUES(?,?,?,?)').run(username, email, await hashPw(pw), Date.now());
  return loginAs(res, s, r.lastInsertRowid);
});

function loginAs(res, oldSession, userId) {
  // تجديد معرّف الجلسة بعد الدخول لمنع session fixation
  q('DELETE FROM sessions WHERE id=?').run(oldSession.id);
  const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  q('INSERT INTO sessions(id,user_id,csrf,expires) VALUES(?,?,?,?)').run(id, userId, csrf, Date.now() + SESSION_TTL);
  setSessionCookie(res, id, SESSION_TTL / 1000);
  return { user: currentUser({ user_id: userId }), csrf };
}

route('POST', '/api/login', async ({ body, req, res, s }) => {
  if (limited('login:' + req.ip, 10, 900000)) return [429, 'محاولات كثيرة، حاول بعد 15 دقيقة'];
  const email = clean(body.email, 120).toLowerCase(), pw = String(body.password || '').slice(0, 128);
  const u = q('SELECT * FROM users WHERE email=?').get(email);
  if (u && u.locked_until > Date.now()) return [423, 'الحساب مقفل مؤقتاً بسبب محاولات فاشلة'];
  const ok = await verifyPw(pw, u ? u.pass : DUMMY);
  if (!u || !ok) {
    if (u) {
      const f = u.fails + 1;
      q('UPDATE users SET fails=?, locked_until=? WHERE id=?').run(f >= 5 ? 0 : f, f >= 5 ? Date.now() + 900000 : 0, u.id);
    }
    return [401, 'بيانات الدخول غير صحيحة'];
  }
  if (u.banned) return [403, 'تم حظر هذا الحساب' + (u.ban_reason ? ': ' + u.ban_reason : '')];
  q('UPDATE users SET fails=0, locked_until=0 WHERE id=?').run(u.id);
  return loginAs(res, s, u.id);
});

route('POST', '/api/logout', async ({ res, s }) => {
  q('DELETE FROM sessions WHERE id=?').run(s.id);
  const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  q('INSERT INTO sessions(id,user_id,csrf,expires) VALUES(?,?,?,?)').run(id, null, csrf, Date.now() + SESSION_TTL);
  setSessionCookie(res, id, SESSION_TTL / 1000);
  return { ok: true, csrf };
});

route('POST', '/api/profile', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  const pe = clean(body.paypalEmail, 120).toLowerCase();
  if (!reEmail.test(pe)) return [400, 'بريد PayPal غير صالح'];
  q('UPDATE users SET paypal_email=? WHERE id=?').run(pe, user.id);
  return { ok: true };
});

route('GET', '/api/items', async ({ url }) => {
  const term = clean(url.searchParams.get('q'), 60), cat = clean(url.searchParams.get('cat'), 20);
  const like = '%' + term.replace(/[%_]/g, '') + '%';
  const rows = q(`SELECT i.*, u.username AS seller FROM items i JOIN users u ON u.id=i.seller_id
    WHERE i.status='active' AND (i.title LIKE ? OR i.description LIKE ?) AND (?='' OR i.category=?)
    ORDER BY i.verified DESC, i.created_at DESC LIMIT 100`).all(like, like, cat, cat);
  return { items: rows.map(publicItem) };
});

route('POST', '/api/items', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  if (limited('sell:' + user.id, 20, 3600000)) return [429, 'تجاوزت الحد المسموح من الإعلانات'];
  const title = clean(body.title, 80), desc = clean(body.description, 1000), cat = clean(body.category, 20);
  const price = Math.round(Number(body.price) * 100), image = safeImage(clean(body.image, 500));
  if (title.length < 3) return [400, 'العنوان قصير جداً'];
  if (desc.length < 10) return [400, 'الوصف قصير جداً'];
  if (!CATS.includes(cat)) return [400, 'تصنيف غير صالح'];
  if (!Number.isInteger(price) || price < 100 || price > 10000000) return [400, 'السعر يجب أن يكون بين 1 و 100000 دولار'];
  if (image === undefined) return [400, 'رابط الصورة يجب أن يكون https صالحاً'];
  if (!q('SELECT paypal_email FROM users WHERE id=?').get(user.id).paypal_email) return [400, 'أضف بريد PayPal الخاص بك أولاً لاستلام الأرباح'];
  const r = q('INSERT INTO items(seller_id,title,description,price_cents,category,image,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(user.id, title, desc, price, cat, image, Date.now());
  return { id: Number(r.lastInsertRowid) };
});

route('GET', '/api/mine', async ({ user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  const listings = q(`SELECT i.*, u.username AS seller FROM items i JOIN users u ON u.id=i.seller_id WHERE i.seller_id=? ORDER BY i.created_at DESC`).all(user.id);
  const purchases = q(`SELECT o.amount_cents, o.created_at, i.title FROM orders o JOIN items i ON i.id=o.item_id WHERE o.buyer_id=? AND o.status='COMPLETED' ORDER BY o.created_at DESC`).all(user.id);
  return { listings: listings.map(publicItem), purchases: purchases.map((p) => ({ title: p.title, amount: p.amount_cents / 100, at: p.created_at })) };
});

route('POST', '/api/items/delete', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  const r = q(`UPDATE items SET status='removed' WHERE id=? AND seller_id=? AND status='active'`).run(Number(body.id), user.id);
  return r.changes ? { ok: true } : [404, 'غير موجود'];
});

route('POST', '/api/paypal/create-order', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً للشراء'];
  if (!PP_READY) return [503, 'PayPal غير مُفعّل: أضف PAYPAL_CLIENT_ID و PAYPAL_CLIENT_SECRET'];
  const item = q(`SELECT i.*, u.paypal_email AS payee FROM items i JOIN users u ON u.id=i.seller_id WHERE i.id=? AND i.status='active'`).get(Number(body.itemId));
  if (!item) return [404, 'المنتج غير متاح'];
  if (item.seller_id === user.id) return [400, 'لا يمكنك شراء منتجك'];
  const unit = { reference_id: String(item.id), description: item.title.slice(0, 120),
    amount: { currency_code: 'USD', value: (item.price_cents / 100).toFixed(2) } }; // السعر دائماً من قاعدة البيانات
  if (item.payee) unit.payee = { email_address: item.payee };
  const order = await ppApi('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [unit] });
  q('INSERT INTO orders(paypal_order_id,item_id,buyer_id,amount_cents,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(order.id, item.id, user.id, item.price_cents, 'CREATED', Date.now());
  return { id: order.id };
});

route('POST', '/api/paypal/capture', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  const o = q('SELECT * FROM orders WHERE paypal_order_id=? AND buyer_id=?').get(clean(body.orderId, 64), user.id);
  if (!o || o.status !== 'CREATED') return [404, 'طلب غير صالح'];
  const item = q('SELECT * FROM items WHERE id=?').get(o.item_id);
  if (!item || item.status !== 'active') return [409, 'المنتج لم يعد متاحاً'];
  const cap = await ppApi('POST', `/v2/checkout/orders/${encodeURIComponent(o.paypal_order_id)}/capture`);
  const c = cap.purchase_units?.[0]?.payments?.captures?.[0];
  if (cap.status !== 'COMPLETED' || !c || Math.round(Number(c.amount.value) * 100) !== o.amount_cents || c.amount.currency_code !== 'USD')
    return [402, 'لم تكتمل عملية الدفع'];
  db.exec('BEGIN');
  try {
    q(`UPDATE orders SET status='COMPLETED' WHERE id=?`).run(o.id);
    q(`UPDATE items SET status='sold' WHERE id=?`).run(o.item_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true };
});

// ---------- الإدارة ----------
const isAdmin = (u) => u && u.role === 'admin';
const adminOnly = (fn) => async (ctx) => (isAdmin(ctx.user) ? fn(ctx) : [403, 'للإدارة فقط']);
const IMG_PATH = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/;

// رفع صورة (مع التحقق من نوعها الحقيقي عبر البايتات الأولى، لا من الاسم)
route('POST', '/api/admin/upload', adminOnly(async ({ body }) => {
  const m = String(body.data || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return [400, 'صورة غير صالحة'];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 2000000) return [400, 'حجم الصورة غير مقبول (الحد 2MB)'];
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) return [400, 'نوع الملف غير مدعوم'];
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return { path: '/uploads/' + name };
}));

// إضافة منتج موثّق من الإدارة بصور حقيقية
route('POST', '/api/admin/items', adminOnly(async ({ body, user }) => {
  const title = clean(body.title, 80), desc = clean(body.description, 1000), cat = clean(body.category, 20);
  const price = Math.round(Number(body.price) * 100);
  const images = (Array.isArray(body.images) ? body.images : []).filter((x) => typeof x === 'string' && IMG_PATH.test(x)).slice(0, 4);
  if (title.length < 3 || desc.length < 10) return [400, 'العنوان أو الوصف قصير'];
  if (!CATS.includes(cat)) return [400, 'تصنيف غير صالح'];
  if (!Number.isInteger(price) || price < 100 || price > 10000000) return [400, 'سعر غير صالح'];
  if (!images.length) return [400, 'أرفق صورة حقيقية واحدة على الأقل للمنتج'];
  if (!q('SELECT paypal_email FROM users WHERE id=?').get(user.id).paypal_email) return [400, 'أضف بريد PayPal الخاص بالإدارة أولاً (قسم حسابي)'];
  const r = q('INSERT INTO items(seller_id,title,description,price_cents,category,image,images,verified,created_at) VALUES(?,?,?,?,?,?,?,1,?)')
    .run(user.id, title, desc, price, cat, images[0], JSON.stringify(images), Date.now());
  return { id: Number(r.lastInsertRowid) };
}));

// توثيق/إلغاء توثيق أو حذف أي منتج
route('POST', '/api/admin/item-action', adminOnly(async ({ body }) => {
  const id = Number(body.id);
  if (body.action === 'verify') q('UPDATE items SET verified=1 WHERE id=?').run(id);
  else if (body.action === 'unverify') q('UPDATE items SET verified=0 WHERE id=?').run(id);
  else if (body.action === 'remove') q(`UPDATE items SET status='removed' WHERE id=? AND status='active'`).run(id);
  else return [400, 'إجراء غير معروف'];
  return { ok: true };
}));

route('GET', '/api/admin/users', adminOnly(async () => ({
  users: q(`SELECT u.id,u.username,u.email,u.role,u.banned,u.ban_reason,u.fails,u.created_at,
    (SELECT COUNT(*) FROM items i WHERE i.seller_id=u.id AND i.status='active') AS listings FROM users u
    WHERE u.email NOT LIKE '%@crimson.invalid' ORDER BY u.created_at DESC LIMIT 300`).all()
    .map((x) => ({ id: x.id, username: x.username, email: x.email, role: x.role, banned: !!x.banned, banReason: x.ban_reason, fails: x.fails, listings: x.listings, createdAt: x.created_at })),
})));

route('POST', '/api/admin/ban', adminOnly(async ({ body, user }) => {
  const id = Number(body.userId), target = q('SELECT * FROM users WHERE id=?').get(id);
  if (!target) return [404, 'مستخدم غير موجود'];
  if (target.id === user.id || target.role === 'admin') return [400, 'لا يمكن حظر مدير'];
  if (body.ban) {
    q('UPDATE users SET banned=1, ban_reason=? WHERE id=?').run(clean(body.reason, 200) || 'مخالفة سياسة الموقع', id);
    q('DELETE FROM sessions WHERE user_id=?').run(id);              // طرد فوري
    q(`UPDATE items SET status='removed' WHERE seller_id=? AND status='active'`).run(id); // إخفاء إعلاناته
  } else q('UPDATE users SET banned=0, ban_reason=NULL, fails=0, locked_until=0 WHERE id=?').run(id);
  return { ok: true };
}));

// ---------- المراسلة ----------
route('GET', '/api/messages', async ({ user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  const rows = q('SELECT id,from_admin,body,created_at FROM messages WHERE thread_user=? ORDER BY id ASC LIMIT 200').all(user.id);
  q('UPDATE messages SET is_read=1 WHERE thread_user=? AND from_admin=1').run(user.id);
  return { messages: rows.map((m) => ({ id: m.id, fromAdmin: !!m.from_admin, body: m.body, at: m.created_at })) };
});
route('GET', '/api/messages/unread', async ({ user }) => user
  ? { n: q('SELECT COUNT(*) n FROM messages WHERE thread_user=? AND from_admin=1 AND is_read=0').get(user.id).n } : [401, 'x']);
route('POST', '/api/messages', async ({ body, user }) => {
  if (!user) return [401, 'سجّل الدخول أولاً'];
  if (limited('msg:' + user.id, 30, 3600000)) return [429, 'رسائل كثيرة، حاول لاحقاً'];
  const text = clean(body.body, 1000);
  if (!text) return [400, 'الرسالة فارغة'];
  q('INSERT INTO messages(thread_user,from_admin,body,created_at) VALUES(?,0,?,?)').run(user.id, text, Date.now());
  return { ok: true };
});
route('GET', '/api/admin/threads', adminOnly(async () => ({
  threads: q(`SELECT u.id, u.username, u.banned,
    (SELECT body FROM messages WHERE thread_user=u.id ORDER BY id DESC LIMIT 1) AS last,
    (SELECT created_at FROM messages WHERE thread_user=u.id ORDER BY id DESC LIMIT 1) AS at,
    (SELECT COUNT(*) FROM messages WHERE thread_user=u.id AND from_admin=0 AND is_read=0) AS unread
    FROM users u WHERE EXISTS(SELECT 1 FROM messages WHERE thread_user=u.id) ORDER BY at DESC`).all()
    .map((t) => ({ id: t.id, username: t.username, banned: !!t.banned, last: t.last, at: t.at, unread: t.unread })),
})));
route('GET', '/api/admin/thread', adminOnly(async ({ url }) => {
  const id = Number(url.searchParams.get('user'));
  const u = q('SELECT id,username FROM users WHERE id=?').get(id);
  if (!u) return [404, 'مستخدم غير موجود'];
  const rows = q('SELECT id,from_admin,body,created_at FROM messages WHERE thread_user=? ORDER BY id ASC LIMIT 300').all(id);
  q('UPDATE messages SET is_read=1 WHERE thread_user=? AND from_admin=0').run(id);
  return { user: u, messages: rows.map((m) => ({ id: m.id, fromAdmin: !!m.from_admin, body: m.body, at: m.created_at })) };
}));
route('POST', '/api/admin/messages', adminOnly(async ({ body }) => {
  const id = Number(body.userId), text = clean(body.body, 1000);
  if (!q('SELECT 1 FROM users WHERE id=?').get(id)) return [404, 'مستخدم غير موجود'];
  if (!text) return [400, 'الرسالة فارغة'];
  q('INSERT INTO messages(thread_user,from_admin,body,created_at) VALUES(?,1,?,?)').run(id, text, Date.now());
  return { ok: true };
}));

// ---------- الخادم ----------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try { file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel))); } catch { return fail(res, 400, 'bad'); }
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'غير موجود');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  secHeaders(res);
  req.ip = req.socket.remoteAddress;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/uploads/')) {
      const m = url.pathname.match(/^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp))$/);
      if (!m) return fail(res, 404, 'غير موجود');
      return fs.readFile(path.join(UPLOADS, m[1]), (err, data) => {
        if (err) return fail(res, 404, 'غير موجود');
        res.writeHead(200, { 'Content-Type': MIME['.' + m[2]], 'Cache-Control': 'public, max-age=86400', 'Content-Disposition': 'inline' });
        res.end(data);
      });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method');
      return serveStatic(req, res, url.pathname);
    }
    if (limited('api:' + req.ip, 240, 60000)) return fail(res, 429, 'طلبات كثيرة');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return fail(res, 404, 'غير موجود');
    const s = loadSession(req, res);
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, 'origin');
      const t = Buffer.from(String(req.headers['x-csrf-token'] || '')), c = Buffer.from(s.csrf);
      if (t.length !== c.length || !crypto.timingSafeEqual(t, c)) return fail(res, 403, 'رمز الأمان غير صالح، حدّث الصفحة');
    }
    const me = currentUser(s);
    if (me && me.banned) { q('DELETE FROM sessions WHERE user_id=?').run(me.id); return fail(res, 403, 'تم حظر هذا الحساب'); }
    const body = req.method === 'POST' ? await readBody(req, url.pathname === '/api/admin/upload' ? 3000000 : 20000) : {};
    const out = await handler({ req, res, s, user: me, body, url });
    if (Array.isArray(out)) return fail(res, out[0], out[1]);
    json(res, 200, out);
  } catch (e) {
    if (e.message === 'big' || e.message === 'bad') return fail(res, 400, 'طلب غير صالح');
    console.error(e.message);
    if (!res.headersSent) fail(res, 500, e.message.startsWith('paypal') ? 'خطأ في الاتصال مع PayPal' : 'خطأ في الخادم');
  }
}).listen(PORT, () => console.log(`Crimson Market → http://localhost:${PORT}  (PayPal: ${PP_READY ? PP_ENV : 'غير مُفعّل'})`));
