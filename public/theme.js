'use strict';

// Light or dark theme. Loaded in <head>, before the page is drawn, so there is never a flash of the wrong theme.
// The choice is per device: 'auto' (default: follow the device's own light/dark setting), 'light' or 'dark'.
(function () {
  const KEY = 'hc-theme';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const read = () => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; } };
  const resolve = (choice) => (choice === 'auto' ? (media && media.matches ? 'light' : 'dark') : choice);

  function apply() {
    const choice = read();
    const theme = resolve(choice);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeChoice = choice;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = theme === 'light' ? '#eef3fb' : '#050c1d';
    document.dispatchEvent(new CustomEvent('themechange', { detail: { choice, theme } }));
  }

  window.hcTheme = {
    choice: read,
    set(choice) { try { if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* private mode: this page only */ } apply(); },
  };
  if (media && media.addEventListener) media.addEventListener('change', () => { if (read() === 'auto') apply(); });
  apply();
}());
