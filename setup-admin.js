'use strict';
/**
 * إنشاء/تحديث حساب المدير بكلمة مرور عشوائية قوية جداً.
 *   node setup-admin.js البريد [كلمة_مرور_خاصة]
 * - بدون كلمة مرور: تُولَّد كلمة من 40 حرفاً عشوائياً (≈ 240 بت) وتُطبع مرة واحدة فقط.
 * - التشفير: scrypt بتكلفة N=2^17 (≈ 8 أضعاف المستخدم العادي) + salt عشوائي 32 بايت.
 */
const crypto = require('node:crypto');
process.argv.push('--init-only');
const { db } = require('./server.js');
const email = (process.argv[2] || '').toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.log('الاستخدام: node setup-admin.js email@example.com'); process.exit(1); }
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
const gen = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');
const custom = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const pw = custom || gen(40);
const N = 131072, r = 8, p = 1, salt = crypto.randomBytes(32);
const key = crypto.scryptSync(pw, salt, 64, { N, r, p, maxmem: 512 * 1024 * 1024 });
const hash = `s2$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
const ex = db.prepare('SELECT id FROM users WHERE email=?').get(email);
if (ex) db.prepare("UPDATE users SET pass=?, role='admin', banned=0, fails=0, locked_until=0 WHERE id=?").run(hash, ex.id);
else db.prepare("INSERT INTO users(username,email,pass,role,created_at) VALUES(?,?,?,'admin',?)").run(email.split('@')[0].replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 20), email, hash, Date.now());
db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=?)').run(email);
console.log(custom ? `تم تحديث المدير ${email}` : `المدير: ${email}\nكلمة المرور (تُعرض مرة واحدة فقط، احفظها في مدير كلمات مرور):\n${pw}`);
