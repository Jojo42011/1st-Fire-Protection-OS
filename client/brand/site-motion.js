/* Website motion for the OS (pairs with /brand/site-motion.css).
   Reveals [data-reveal] blocks as they scroll into view, the way 1stfpservices.com does: the
   attribute's value is the stagger delay in ms. Content rendered later (after a fetch) is picked
   up automatically. Numbers marked [data-count] roll up from zero when revealed. Rows of a
   .rows-in table get their stagger index. Everything shows at once for reduced motion, for
   browsers without IntersectionObserver, and before printing. A number never stays mid-roll:
   a timer puts the final value back even if the page stopped drawing. */
(function () {
  var root = document.documentElement;
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) {}
  var canObserve = 'IntersectionObserver' in window && !reduce;
  if (canObserve) root.classList.add('js-rv');
  var DUR = 1600;
  var rolling = [];

  function finishRoll(r) { if (r.done) return; r.done = true; r.el.innerHTML = r.keep; }
  function rollUp(el) {
    if (el.__counted) return; el.__counted = true;
    var txt = (el.textContent || '').trim();
    var m = txt.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/);
    if (!m || reduce) return;
    var target = Number(m[2].replace(/,/g, '')), dec = (m[2].split('.')[1] || '').length, comma = m[2].indexOf(',') >= 0;
    var fmt = function (n) { var s = n.toFixed(dec); if (comma) { var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); } return m[1] + s + m[3]; };
    var r = { el: el, keep: el.innerHTML, done: false };
    rolling.push(r);
    var t0 = null, ease = function (t) { return 1 - Math.pow(1 - t, 3); };
    var step = function (ts) {
      if (r.done) return;
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / DUR);
      el.textContent = fmt(target * ease(k));
      if (k < 1) requestAnimationFrame(step); else finishRoll(r);
    };
    requestAnimationFrame(step);
    setTimeout(function () { finishRoll(r); }, DUR + 250);
  }
  function reveal(el) {
    if (el.classList.contains('rv-in')) return;
    el.classList.add('rv-in');
    var counts = el.matches('[data-count]') ? [el] : [];
    counts = counts.concat([].slice.call(el.querySelectorAll('[data-count]')));
    var delay = parseInt(el.getAttribute('data-reveal'), 10) || 0;
    counts.forEach(function (c) { setTimeout(function () { rollUp(c); }, delay + 120); });
    setTimeout(function () { el.classList.add('rv-done'); }, delay + 1200);
  }

  var io = canObserve ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) : null;

  // Safety net: anything already on screen a moment after it was added is shown, even if the
  // observer never reports (a page opened while its window was hidden, an older browser quirk).
  function revealOnScreen() {
    var h = window.innerHeight || document.documentElement.clientHeight;
    var els = document.querySelectorAll('[data-reveal]:not(.rv-in)');
    for (var i = 0; i < els.length; i++) { var b = els[i].getBoundingClientRect(); if (b.top < h && b.bottom > 0) reveal(els[i]); }
  }
  var safety = null;
  function scan(scope) {
    var els = (scope || document).querySelectorAll('[data-reveal]:not(.rv-in)');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__rv) continue; el.__rv = true;
      el.style.setProperty('--rv-d', (parseInt(el.getAttribute('data-reveal'), 10) || 0) + 'ms');
      var rows = el.querySelectorAll('.rows-in tbody tr');
      for (var r = 0; r < rows.length; r++) rows[r].style.setProperty('--ri', String(Math.min(r, 14)));
      if (io) io.observe(el); else reveal(el);
    }
    if (io) { clearTimeout(safety); safety = setTimeout(revealOnScreen, 1500); }
  }
  function showAll() {
    var els = document.querySelectorAll('[data-reveal]');
    for (var i = 0; i < els.length; i++) reveal(els[i]);
    rolling.forEach(finishRoll);
    var c = document.querySelectorAll('[data-count]');
    for (var j = 0; j < c.length; j++) c[j].__counted = true; // printed numbers are final, never mid-roll
  }

  window.FPMotion = { scan: scan, showAll: showAll };
  window.addEventListener('beforeprint', showAll);
  window.addEventListener('scroll', function () { if (io) { clearTimeout(safety); safety = setTimeout(revealOnScreen, 400); } }, { passive: true });
  var start = function () {
    scan(document);
    if ('MutationObserver' in window) new MutationObserver(function () { scan(document); }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
