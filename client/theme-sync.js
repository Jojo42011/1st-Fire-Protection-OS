/* Theme sync - one source of truth for light/dark across the shell and every
   iframe page. Loaded synchronously in <head> BEFORE the stylesheets so the
   theme is applied before first paint (no flash). The shell's toggle writes
   localStorage and postMessages; each page also reads localStorage on boot and
   listens for cross-tab storage changes.

   Signal is light-first: LIGHT is the default (no attribute); DARK is the opt-in
   and sets data-theme="dark" on <html> (matches signal.css's :root[data-theme="dark"]). */
(function () {
  function apply(t) {
    var d = document.documentElement;
    if (t === 'dark') d.setAttribute('data-theme', 'dark');
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
