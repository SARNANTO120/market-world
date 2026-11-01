'use strict';
const $ = (s, r = document) => r.querySelector(s);
const state = { user: null, csrf: '', paypal: null, cats: [], cat: '', q: '' };

// إنشاء عناصر DOM بأمان (بدون innerHTML إطلاقاً → حماية من XSS)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, { credentials: 'same-origin', ...opt });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}
function toast(msg, ok) {
  const t = h('div', { class: 'toast' + (ok ? ' ok' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3800);
}
const money = (n) => '$' + Number(n).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------- النوافذ ----------
function openModal(m) { m.hidden = false; document.body.classList.add('lock'); }
function closeModals() { document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); document.body.classList.remove('lock'); }
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]') || e.target.classList.contains('modal')) closeModals(); });
addEventListener('keydown', (e) => e.key === 'Escape' && closeModals());

// ---------- الجلسة والمصادقة ----------
function applyAuth() {
  const u = state.user;
  document.body.classList.toggle('authed', !!u);
  $('#btnLogin').hidden = !!u; $('#btnLogout').hidden = !u;
  $('#hello').hidden = !u; $('#navAccount').hidden = !u; $('#account').hidden = !u;
  const adm = !!u && u.role === 'admin';
  $('#admin').hidden = !adm; $('#navAdmin').hidden = !adm;
  if (adm) initAdmin();
  if (u) startChat(); else stopChat();
  if (u) { clear($('#hello')).append('أهلاً، ', h('b', {}, u.username)); $('#accSub').textContent = u.email; loadMine(); }
}
function setAuthMode(mode) {
  const reg = mode === 'register';
  document.querySelectorAll('#authModal .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === mode));
  document.querySelectorAll('[data-only="register"]').forEach((e) => (e.hidden = !reg));
  $('#authTitle').textContent = reg ? 'انضم إلى النخبة' : 'مرحباً بعودتك';
  $('#authSubmit').textContent = reg ? 'إنشاء حساب' : 'دخول';
  $('#authForm').dataset.mode = mode;
  $('#authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authErr').textContent = '';
}
function showAuth(mode = 'login') { setAuthMode(mode); openModal($('#authModal')); setTimeout(() => $('#authForm').email.focus(), 100); }

$('#btnLogin').onclick = () => showAuth('login');
document.querySelectorAll('#authModal .tab').forEach((t) => (t.onclick = () => setAuthMode(t.dataset.tab)));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, mode = f.dataset.mode || 'login', btn = $('#authSubmit');
  btn.disabled = true; $('#authErr').textContent = '';
  try {
    const d = await api(mode, { username: f.username.value, email: f.email.value, password: f.password.value });
    state.user = d.user; state.csrf = d.csrf; f.reset(); closeModals(); applyAuth(); loadItems();
    toast(mode === 'register' ? 'تم إنشاء حسابك بنجاح 🔥' : 'تم تسجيل الدخول — أهلاً بك', true);
  } catch (err) { $('#authErr').textContent = err.message; }
  btn.disabled = false;
});
$('#btnLogout').onclick = async () => {
  try { const d = await api('logout', {}); state.csrf = d.csrf; } catch {}
  state.user = null; applyAuth(); loadItems(); toast('تم تسجيل الخروج بأمان', true);
};

// ---------- السوق ----------
async function loadItems() {
  try {
    const d = await api(`items?q=${encodeURIComponent(state.q)}&cat=${encodeURIComponent(state.cat)}`);
    const grid = clear($('#grid')); $('#empty').hidden = d.items.length > 0;
    d.items.forEach((it, i) => grid.append(card(it, i)));
  } catch (e) { toast(e.message); }
}
function thumb(it) {
  const t = h('div', { class: 'thumb' }, h('span', { class: 'glyph' }, it.title.trim()[0] || '◆'));
  const src = (it.images && it.images[0]) || it.image;
  if (src) { const im = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }); im.onerror = () => im.remove(); t.append(im); }
  t.append(h('span', { class: 'tag' }, it.category));
  if (it.verified) t.append(h('span', { class: 'vbadge' }, '✔ موثّق من الإدارة'));
  return t;
}
function card(it, i) {
  return h('article', { class: 'card', style: `--i:${Math.min(i, 12) * 0.06}s`, tabindex: 0, onclick: () => openItem(it), onkeydown: (e) => e.key === 'Enter' && openItem(it) },
    thumb(it), h('div', { class: 'card-body' }, h('h3', {}, it.title), h('p', {}, it.description),
      h('div', { class: 'card-foot' }, h('span', { class: 'price' }, money(it.price)), h('span', { class: 'by' }, 'متجر كريمسون'))));
}
function renderChips() {
  const box = clear($('#chips'));
  ['الكل', ...state.cats].forEach((c) => {
    const val = c === 'الكل' ? '' : c;
    box.append(h('button', { class: 'chip' + (state.cat === val ? ' on' : ''), onclick: () => { state.cat = val; renderChips(); loadItems(); } }, c));
  });
}
let st; $('#search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { state.q = e.target.value; loadItems(); }, 300); });

// ---------- المنتج والدفع ----------
let ppLoading;
function loadPayPal() {
  if (window.paypal) return Promise.resolve();
  if (ppLoading) return ppLoading;
  return (ppLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.paypal.clientId)}&currency=USD&intent=capture`;
    s.onload = res; s.onerror = () => { ppLoading = null; rej(new Error('تعذّر تحميل PayPal')); };
    document.head.append(s);
  }));
}
function openItem(it) {
  const box = h('div', { id: 'ppBox' });
  const view = clear($('#itemView'));
  view.append(thumb(it), h('div', {}, h('h3', {}, it.title), h('span', { class: 'price' }, money(it.price)),
    h('p', { class: 'desc' }, it.description), h('p', { class: 'by' }, 'البائع: متجر كريمسون (موثّق)'), box,
    it.images && it.images.length > 1 ? h('div', { class: 'gallery' }, it.images.map((u, i) => h('img', { src: u, alt: '', class: i ? '' : 'on', onclick: (e) => {
      const main = view.querySelector('.thumb img'); if (main) main.src = u;
      e.target.parentNode.querySelectorAll('img').forEach((x) => x.classList.toggle('on', x === e.target)); } }))) : null,
    h('div', { class: 'secure' }, '🔒 دفع مشفّر وآمن عبر PayPal')));
  openModal($('#itemModal'));
  if (!state.user) box.append(h('button', { class: 'btn big full', onclick: () => { closeModals(); showAuth('login'); } }, 'سجّل الدخول للشراء'));
  else if (state.user.id === it.sellerId) box.append(h('p', { class: 'by' }, 'هذا إعلانك.'));
  else if (!state.paypal) box.append(h('p', { class: 'err' }, 'الدفع غير مُفعّل حالياً (لم تُضبط مفاتيح PayPal على الخادم).'));
  else loadPayPal().then(() => window.paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' },
    createOrder: async () => (await api('paypal/create-order', { itemId: it.id })).id,
    onApprove: async (d) => { await api('paypal/capture', { orderId: d.orderID }); closeModals(); toast('تمت عملية الشراء بنجاح! 🎉', true); loadItems(); loadMine(); },
    onError: (e) => toast(e && e.message ? e.message : 'فشلت عملية الدفع'),
  }).render(box)).catch((e) => toast(e.message));
}

// ---------- المحادثات ----------
const fmtTime = (t) => new Date(t).toLocaleString('ar', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
function renderMsgs(box, msgs, meIsAdmin) {
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  clear(box);
  if (!msgs.length) box.append(h('p', { class: 'by' }, 'لا توجد رسائل بعد.'));
  msgs.forEach((m) => box.append(h('div', { class: 'msg' + (m.fromAdmin === meIsAdmin ? ' me' : '') }, m.body, h('small', {}, (m.fromAdmin ? 'الإدارة · ' : '') + fmtTime(m.at)))));
  if (atBottom) box.scrollTop = box.scrollHeight;
}
let chatTimer;
async function pollMine() {
  try {
    const d = await api('messages'); renderMsgs($('#myChat'), d.messages, false);
    $('#unreadBadge').hidden = true;
  } catch {}
  if (state.user && state.user.role === 'admin') pollAdmin();
}
function startChat() { stopChat(); pollMine(); chatTimer = setInterval(pollMine, 8000); }
function stopChat() { clearInterval(chatTimer); }
$('#myChatForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  try { await api('messages', { body: f.body.value }); f.reset(); pollMine(); } catch (err) { toast(err.message); }
});

// ---------- لوحة الإدارة ----------
let adminInit = false, activeThread = null;
function initAdmin() {
  if (adminInit) { loadAdminItems(); return; }
  adminInit = true;
  const sel = $('#adminCat'); state.cats.forEach((c) => sel.append(h('option', { value: c }, c)));
  document.querySelectorAll('[data-atab]').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('[data-atab]').forEach((x) => x.classList.toggle('on', x === b));
    ['add', 'users', 'chat'].forEach((n) => ($('#atab-' + n).hidden = n !== b.dataset.atab));
    if (b.dataset.atab === 'users') loadUsers(); if (b.dataset.atab === 'chat') pollAdmin();
  }));
  $('#adminFiles').addEventListener('change', async (e) => {
    const box = clear($('#previews'));
    for (const f of [...e.target.files].slice(0, 4)) box.append(h('img', { src: URL.createObjectURL(f), alt: '' }));
  });
  $('#adminForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target, btn = f.querySelector('button'); btn.disabled = true;
    try {
      const paths = [];
      for (const file of [...f.files.files].slice(0, 4)) paths.push((await api('admin/upload', { data: await shrink(file) })).path);
      await api('admin/items', { title: f.title.value, description: f.description.value, price: f.price.value, category: f.category.value, images: paths });
      f.reset(); clear($('#previews')); toast('تم نشر المنتج الموثّق ✔', true); loadItems(); loadAdminItems();
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
  $('#adminChatForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('admin/messages', { userId: activeThread, body: f.body.value }); f.reset(); openThread(activeThread); } catch (err) { toast(err.message); }
  });
  loadAdminItems();
}
// تصغير الصورة وإعادة ترميزها JPEG (يزيل بيانات EXIF/الموقع ويقلل الحجم)
function shrink(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1400 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.85));
    };
    im.onerror = () => rej(new Error('تعذّر قراءة الصورة'));
    im.src = url;
  });
}
async function loadAdminItems() {
  try {
    const d = await api('items'), L = clear($('#adminItems'));
    d.items.forEach((i) => L.append(h('div', { class: 'li' }, h('span', {}, i.title, ' — ', money(i.price), ' · ', i.seller, i.verified ? ' ✔' : ''),
      h('div', { class: 'acts' },
        h('button', { class: 'btn ghost', onclick: () => itemAct(i.id, i.verified ? 'unverify' : 'verify') }, i.verified ? 'إلغاء التوثيق' : 'توثيق'),
        h('button', { class: 'btn ghost', onclick: () => confirm('حذف هذا المنتج؟') && itemAct(i.id, 'remove') }, 'حذف')))));
  } catch {}
}
async function itemAct(id, action) { try { await api('admin/item-action', { id, action }); loadItems(); loadAdminItems(); } catch (e) { toast(e.message); } }
async function loadUsers() {
  try {
    const d = await api('admin/users'), L = clear($('#userList'));
    d.users.forEach((u) => L.append(h('div', { class: 'li' },
      h('span', {}, u.username, ' ', u.role === 'admin' ? h('span', { class: 'badge adm' }, 'مدير') : null, u.banned ? h('span', { class: 'badge ban' }, 'محظور') : null,
        h('small', {}, u.email + ' · إعلانات: ' + u.listings + (u.fails ? ' · محاولات دخول فاشلة: ' + u.fails : '') + (u.banned && u.banReason ? ' · السبب: ' + u.banReason : ''))),
      u.role === 'admin' ? null : h('div', { class: 'acts' },
        h('button', { class: 'btn ghost', onclick: () => { document.querySelector('[data-atab=chat]').click(); openThread(u.id, u.username); } }, 'راسل'),
        h('button', { class: 'btn' + (u.banned ? ' ghost' : ''), onclick: async () => {
          let reason = '';
          if (!u.banned) { reason = prompt('سبب الحظر (مثلاً: محاولة اختراق):', 'محاولة اختراق / نشاط مشبوه'); if (reason === null) return; }
          try { await api('admin/ban', { userId: u.id, ban: !u.banned, reason }); toast(u.banned ? 'تم فك الحظر' : 'تم حظر المستخدم وطرده فوراً', true); loadUsers(); loadItems(); } catch (e) { toast(e.message); }
        } }, u.banned ? 'فك الحظر' : 'حظر')))));
  } catch (e) { toast(e.message); }
}
async function pollAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  try {
    const d = await api('admin/threads'), L = clear($('#threads')); let un = 0;
    d.threads.forEach((t) => { un += t.unread; L.append(h('button', { class: 'thread' + (t.id === activeThread ? ' on' : ''), onclick: () => openThread(t.id, t.username) },
      h('b', {}, t.username + (t.unread ? ` (${t.unread})` : '')), h('small', {}, t.last))); });
    if (!d.threads.length) L.append(h('p', { class: 'by' }, 'لا توجد محادثات.'));
    $('#adminUnread').hidden = !un; $('#adminUnread').textContent = un;
    if (activeThread) openThread(activeThread, null, true);
  } catch {}
}
async function openThread(id, name, quiet) {
  activeThread = id;
  try {
    const d = await api('admin/thread?user=' + id);
    $('#chatTitle').textContent = 'محادثة مع ' + d.user.username; $('#adminChatForm').hidden = false;
    renderMsgs($('#adminChat'), d.messages, true);
  } catch (e) { if (!quiet) toast(e.message); }
}

async function loadMine() {
  try {
    const d = await api('mine');
    const P = clear($('#myPurchases'));
    if (!d.purchases.length) P.append(h('p', { class: 'by' }, 'لا توجد مشتريات بعد.'));
    d.purchases.forEach((x) => P.append(h('div', { class: 'li' }, h('span', {}, x.title), h('b', {}, money(x.amount)))));
  } catch {}
}

// ---------- واجهة عامة ----------
$('#burger').onclick = () => $('#links').classList.toggle('open');
$('#links').onclick = () => $('#links').classList.remove('open');
$('#yr').textContent = new Date().getFullYear();

(async function init() {
  const img = $('#character img');
  img.onerror = () => { img.onerror = null; img.src = 'img/character.svg'; };
  img.src = 'img/character.png'; // ضع صورتك هنا بهذا الاسم لتستبدل الشخصية الافتراضية
  try {
    const s = await api('session');
    Object.assign(state, { user: s.user, csrf: s.csrf, paypal: s.paypal, cats: s.categories });
  } catch (e) { toast('تعذّر الاتصال بالخادم'); }
  renderChips(); applyAuth(); await loadItems();
  window.observeReveal();
  setTimeout(() => $('#loader').classList.add('done'), 700);
})();
