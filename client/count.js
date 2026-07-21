/* Count-up for tracking numbers - the same slow, eased roll the Operator hub
   uses, applied to every KPI/stat across the tabs. It watches the page for
   numbers that get rendered (KPIs fill in via fetch after load) and animates
   each from zero once, preserving any prefix/suffix ($ , % , /mo , K) and the
   comma grouping. Time values (2:08) and non-numbers are left untouched.
   Respects prefers-reduced-motion. No per-page wiring needed. */
(function () {
  var SEL = '.kpi .value, .strip .t .v, .vend .vv';
  var DUR = 1500;
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) {}

  function parse(txt) {
    if (txt.indexOf(':') >= 0) return null;               // skip clock-style values
    var m = txt.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/); // prefix, number, suffix
    if (!m) return null;
    return { prefix: m[1], numStr: m[2], suffix: m[3] };
  }
  function format(n, numStr) {
    var dec = (numStr.split('.')[1] || '').length;
    var s = dec ? n.toFixed(dec) : Math.round(n).toString();
    if (numStr.indexOf(',') >= 0) {                        // restore thousands separators
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      s = parts.join('.');
    }
    return s;
  }
  function animate(el) {
    var txt = el.textContent.trim();
    var p = parse(txt);
    el.dataset.counted = '1';
    if (!p) return;
    var target = parseFloat(p.numStr.replace(/,/g, ''));
    if (!isFinite(target) || target === 0) return;
    if (reduce) return;                                    // leave the final value in place
    var t0 = null;
    function ease(x) { return 1 - Math.pow(1 - x, 3); }
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / DUR);
      el.textContent = p.prefix + format(target * ease(k), p.numStr) + p.suffix;
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = txt;                           // land exactly on the source text
    }
    requestAnimationFrame(step);
  }
  function scan() {
    document.querySelectorAll(SEL).forEach(function (el) {
      if (!el.dataset.counted && /\d/.test(el.textContent)) animate(el);
    });
  }
  function boot() {
    scan();
    // KPIs render after fetch; watch for new number nodes (childList only, so the
    // animation's own text changes never feed back into the observer).
    var queued = false;
    var mo = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; scan(); });
    });
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
