/* global document, localStorage, window */
// Loaded synchronously in <head> so the chosen theme applies before first paint.
// Preference is 'system' (follow the OS), 'light', or 'dark'.
(function () {
  const root = document.documentElement;
  root.classList.add('js');
  let pref = 'system';
  try {
    const saved = localStorage.getItem('sync-theme');
    if (saved === 'light' || saved === 'dark') pref = saved;
  } catch {
    pref = 'system';
  }
  const preferredDark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.themePref = pref;
  root.dataset.theme = pref === 'system' ? (preferredDark ? 'dark' : 'light') : pref;
})();
