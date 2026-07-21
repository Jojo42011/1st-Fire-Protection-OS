/* Motion - a calm, staggered load-in for the daily-driver pages. Each top-level
   block rises and fades in sequence so a page assembles itself instead of
   snapping in. Only opacity/transform are touched (safe for any layout) and the
   inline styles are cleared once the entrance finishes, so hover/transition
   behavior is untouched afterward. Fully skipped under reduced-motion. Pairs with
   count.js: the blocks rise in while their numbers roll up. */
(function () {
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) {}
  if (reduce) return;

  function run() {
    var host = document.querySelector('.wrap') || document.body;
    var skip = { SCRIPT: 1, STYLE: 1, LINK: 1, TEMPLATE: 1, BR: 1 };
    var blocks = [];
    for (var i = 0; i < host.children.length; i++) {
      var el = host.children[i];
      if (skip[el.tagName]) continue;
      if (el.hasAttribute('hidden')) continue;
      var cls = el.className && el.className.baseVal !== undefined ? '' : (el.className || '');
      if (/\b(scrim|overlay|toast)\b/.test(cls) || el.id === 'brief') continue; // never animate overlays
      blocks.push(el);
    }
    if (!blocks.length) return;
    blocks.forEach(function (el, i) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(14px)';
      el.style.transition = 'opacity .55s cubic-bezier(.2,.7,.3,1), transform .55s cubic-bezier(.2,.7,.3,1)';
      el.style.transitionDelay = Math.min(i * 0.06, 0.6) + 's';
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        blocks.forEach(function (el) { el.style.opacity = ''; el.style.transform = ''; });
      });
    });
    // clear the leftover inline transition props after the entrance so they
    // never interfere with the components' own hover transitions
    setTimeout(function () {
      blocks.forEach(function (el) { el.style.transition = ''; el.style.transitionDelay = ''; });
    }, 1400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
