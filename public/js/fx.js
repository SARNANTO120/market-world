'use strict';
// جمرات متطايرة في الخلفية
(() => {
  const c = document.getElementById('embers'), g = c.getContext('2d');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let w, h, P = [];
  const resize = () => { w = c.width = innerWidth; h = c.height = innerHeight; };
  addEventListener('resize', resize); resize();
  const mk = (init) => ({ x: Math.random() * w, y: init ? Math.random() * h : h + 10, r: Math.random() * 2.2 + .4,
    vy: Math.random() * .7 + .25, vx: (Math.random() - .5) * .35, a: Math.random() * .7 + .2, t: Math.random() * 6 });
  const N = Math.min(110, Math.floor(innerWidth / 14));
  for (let i = 0; i < N; i++) P.push(mk(true));
  (function loop() {
    g.clearRect(0, 0, w, h);
    for (const p of P) {
      p.y -= p.vy; p.t += .02; p.x += p.vx + Math.sin(p.t) * .3;
      if (p.y < -10) Object.assign(p, mk(false));
      const fade = Math.min(1, p.y / (h * .35));
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283);
      g.fillStyle = `rgba(255,${40 + p.r * 25 | 0},20,${p.a * fade})`;
      g.shadowColor = '#e10600'; g.shadowBlur = 12; g.fill();
    }
    requestAnimationFrame(loop);
  })();
})();

// حركة الشخصية مع المؤشر + إضاءة البطاقات + إمالة ثلاثية الأبعاد
addEventListener('pointermove', (e) => {
  const ch = document.getElementById('character');
  ch.style.setProperty('--px', ((e.clientX / innerWidth - .5) * 26) + 'px');
  ch.style.setProperty('--py', ((e.clientY / innerHeight - .5) * 12) + 'px');
});
document.addEventListener('pointermove', (e) => {
  const card = e.target.closest && e.target.closest('.card');
  if (!card) return;
  const r = card.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  card.style.setProperty('--mx', x + 'px'); card.style.setProperty('--my', y + 'px');
  card.style.transform = `rotateX(${((y / r.height) - .5) * -8}deg) rotateY(${((x / r.width) - .5) * 8}deg) translateY(-6px)`;
});
document.addEventListener('pointerout', (e) => { const c = e.target.closest && e.target.closest('.card'); if (c) c.style.transform = ''; });

// ظهور العناصر عند التمرير + عدّادات
const io = new IntersectionObserver((es) => es.forEach((en) => {
  if (!en.isIntersecting) return;
  en.target.classList.add('in'); io.unobserve(en.target);
  en.target.querySelectorAll('[data-count]').forEach(count);
}), { threshold: .15 });
window.observeReveal = () => document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
function count(el) {
  const to = +el.dataset.count, t0 = performance.now();
  (function step(t) { const k = Math.min(1, (t - t0) / 1800); el.textContent = Math.floor(to * (1 - Math.pow(1 - k, 3))).toLocaleString('en'); if (k < 1) requestAnimationFrame(step); })(t0);
}
addEventListener('scroll', () => document.getElementById('nav').classList.toggle('scrolled', scrollY > 30), { passive: true });
