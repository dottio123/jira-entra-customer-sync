/* global document, localStorage, navigator, window */
(function () {
  const root = document.documentElement;
  const liveRegion = document.querySelector('[data-live-region]');

  function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    window.setTimeout(() => {
      liveRegion.textContent = message;
    }, 50);
  }

  // Theme: cycles System -> Light -> Dark. System follows the OS setting live.
  const THEME_ORDER = ['system', 'light', 'dark'];
  const THEME_NAMES = { system: 'System', light: 'Light', dark: 'Dark' };
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme(pref) {
    root.dataset.themePref = pref;
    root.dataset.theme =
      pref === 'system' ? (darkQuery && darkQuery.matches ? 'dark' : 'light') : pref;
    const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length];
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute(
        'aria-label',
        `Theme: ${THEME_NAMES[pref]}. Switch to ${THEME_NAMES[next].toLowerCase()}`,
      );
      button.setAttribute('title', `Theme: ${THEME_NAMES[pref]}`);
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = THEME_NAMES[pref];
    });
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = root.dataset.themePref || 'system';
      const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
      try {
        if (next === 'system') localStorage.removeItem('sync-theme');
        else localStorage.setItem('sync-theme', next);
      } catch {
        // Storage unavailable; theme still applies for this page view.
      }
      applyTheme(next);
      announce(`Theme: ${THEME_NAMES[next]}`);
    });
  });
  if (darkQuery) {
    darkQuery.addEventListener('change', () => {
      if ((root.dataset.themePref || 'system') === 'system') applyTheme('system');
    });
  }
  applyTheme(root.dataset.themePref || 'system');

  // Copy to clipboard: <button data-copy="#input-id"> or data-copy-text="value"
  document.querySelectorAll('[data-copy], [data-copy-text]').forEach((button) => {
    button.hidden = false;
    button.addEventListener('click', async () => {
      const target = button.dataset.copy ? document.querySelector(button.dataset.copy) : null;
      const value = target ? target.value || target.textContent : button.dataset.copyText;
      if (!value) return;
      const labelEl = button.querySelector('[data-copy-label]');
      const original = labelEl ? labelEl.textContent : '';
      try {
        await navigator.clipboard.writeText(value.trim());
        if (labelEl) labelEl.textContent = 'Copied';
        announce('Copied to clipboard');
      } catch {
        if (target && target.select) target.select();
        announce('Copy failed. The text is selected so you can copy it manually.');
      }
      if (labelEl) {
        window.setTimeout(() => {
          labelEl.textContent = original;
        }, 2000);
      }
    });
  });

  // Auto-refresh pages showing an in-progress run, for at most 30 minutes so an unattended
  // tab does not keep the session alive past the idle timeout.
  const refresh = document.querySelector('[data-auto-refresh]');
  if (refresh) {
    const seconds = Number(refresh.dataset.autoRefresh) || 5;
    const limitMs = 30 * 60 * 1000;
    let startedAt = Date.now();
    try {
      const saved = Number(window.sessionStorage.getItem('sync-refresh-start'));
      if (saved) startedAt = saved;
      else window.sessionStorage.setItem('sync-refresh-start', String(startedAt));
    } catch {
      // Storage unavailable: refresh still stops after one window.
    }
    if (Date.now() - startedAt < limitMs) {
      window.setTimeout(() => window.location.reload(), seconds * 1000);
    }
  } else {
    try {
      window.sessionStorage.removeItem('sync-refresh-start');
    } catch {
      // ignore
    }
  }

  // Friendly schedule picker that writes the cron expression field.
  const builder = document.querySelector('[data-schedule-builder]');
  if (builder) {
    const cronInput = document.getElementById(builder.dataset.cronInput);
    const frequency = builder.querySelector('[data-schedule-frequency]');
    const time = builder.querySelector('[data-schedule-time]');
    const weekday = builder.querySelector('[data-schedule-weekday]');
    const monthday = builder.querySelector('[data-schedule-monthday]');
    const advanced = document.querySelector('[data-schedule-advanced]');
    const summary = document.querySelector('[data-schedule-summary]');
    const pending = document.querySelector('[data-schedule-pending]');

    function markPending() {
      if (summary) summary.hidden = true;
      if (pending) pending.hidden = false;
    }

    function toggleRows() {
      builder.querySelectorAll('[data-show-for]').forEach((row) => {
        row.hidden = row.dataset.showFor !== frequency.value;
      });
      builder.querySelectorAll('[data-hide-for]').forEach((row) => {
        row.hidden = row.dataset.hideFor === frequency.value;
      });
    }

    function compose() {
      toggleRows();
      if (frequency.value === 'CUSTOM') {
        if (advanced) advanced.open = true;
        return;
      }
      const [hourText, minuteText] = (time.value || '02:00').split(':');
      const hour = Number(hourText);
      const minute = Number(minuteText);
      let cron = `${minute} ${hour} * * *`;
      if (frequency.value === 'WEEKDAYS') cron = `${minute} ${hour} * * 1-5`;
      if (frequency.value === 'WEEKLY') cron = `${minute} ${hour} * * ${weekday.value}`;
      if (frequency.value === 'MONTHLY') cron = `${minute} ${hour} ${monthday.value} * *`;
      cronInput.value = cron;
      markPending();
    }

    builder.hidden = false;
    if (advanced && frequency.value !== 'CUSTOM') advanced.open = false;
    toggleRows();
    [frequency, time, weekday, monthday].forEach((el) => el.addEventListener('change', compose));
    cronInput.addEventListener('input', () => {
      frequency.value = 'CUSTOM';
      toggleRows();
      markPending();
    });
  }

  // Disable dependent inputs while their switch is off (visual hint only).
  document.querySelectorAll('[data-controls]').forEach((toggle) => {
    const group = document.getElementById(toggle.dataset.controls);
    if (!group) return;
    const sync = () => group.classList.toggle('is-off', !toggle.checked);
    toggle.addEventListener('change', sync);
    sync();
  });
})();
