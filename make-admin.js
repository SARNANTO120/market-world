'use strict';
// الاستخدام:  node make-admin.js البريد@الإلكتروني     (سجّل الحساب من الموقع أولاً)
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const email = (process.argv[2] || '').toLowerCase();
if (!email) { console.log('الاستخدام: node make-admin.js email@example.com'); process.exit(1); }
const db = new DatabaseSync(path.join(__dirname, 'data', 'market.db'));
const r = db.prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
console.log(r.changes ? `تم: ${email} أصبح مديراً` : 'لا يوجد حساب بهذا البريد — سجّله من الموقع أولاً');
