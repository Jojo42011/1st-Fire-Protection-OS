/* Theme sync - one source of truth for light/dark across the shell and every
   iframe page. Loaded synchronously in <head> BEFORE the stylesheets so the
   theme is applied before first paint (no flash). The shell's toggle writes
   localStorage and postMessages every frame; each page also reads localStorage
   on boot and listens for cross-tab storage changes. Dark is the default
   (no attribute); light sets data-theme="light" on <html>. */
(function () {
  function apply(t) {
    var d = document.documentElement;
    if (t === 'light') d.setAttribute('data-theme', 'light');
    else d.removeAttribute('data-theme');
  }
  try { apply(localStorage.getItem('fpTheme')); } catch (e) {}
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.type === 'fp-theme') {
      try { localStorage.setItem('fpTheme', d.theme); } catch (_) {}
      apply(d.theme);
    }
  });
  window.addEventListener('storage', function (e) {
    if (e.key === 'fpTheme') apply(e.newValue);
  });
})();
