(() => {
  const themeToggle = document.querySelector('.theme-toggle');
  const root = document.documentElement;
  const storedTheme = (() => {
    try {
      return localStorage.getItem('hsms-theme');
    } catch {
      return null;
    }
  })();
  const initialTheme = storedTheme === 'light' || storedTheme === 'dark'
    ? storedTheme
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  function applyTheme(theme) {
    root.dataset.theme = theme;
    if (!themeToggle) return;
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} mode`);
    themeToggle.setAttribute('title', `Switch to ${nextTheme} mode`);
    themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
    themeToggle.querySelector('.theme-icon').textContent = theme === 'dark' ? '☼' : '☾';
  }

  applyTheme(initialTheme);
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
      try {
        localStorage.setItem('hsms-theme', nextTheme);
      } catch {
        // The current page still changes theme when persistent storage is unavailable.
      }
    });
  }

  const toggle = document.querySelector('.menu-toggle');
  const sidebar = document.querySelector('.sidebar');

  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('sidebar-open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', (event) => {
      if (window.innerWidth > 800 || !sidebar.classList.contains('sidebar-open')) return;
      if (!sidebar.contains(event.target) && !toggle.contains(event.target)) {
        sidebar.classList.remove('sidebar-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    const input = document.getElementById(button.getAttribute('aria-controls'));
    if (!input) return;
    button.addEventListener('click', () => {
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      button.textContent = showing ? 'Hide' : 'Show';
      button.setAttribute('aria-label', `${showing ? 'Hide' : 'Show'} password`);
      button.setAttribute('aria-pressed', String(showing));
    });
  });

  const passwordInput = document.querySelector('[data-password-strength]');
  const strengthMeter = document.querySelector('[data-strength-meter]');
  const strengthLabel = document.querySelector('[data-strength-label]');
  if (passwordInput && strengthMeter && strengthLabel) {
    passwordInput.addEventListener('input', () => {
      const password = passwordInput.value;
      const checks = [
        password.length >= 12,
        password.length >= 16,
        /[a-z]/.test(password) && /[A-Z]/.test(password),
        /\d/.test(password),
        /[^A-Za-z0-9]/.test(password)
      ];
      const score = checks.filter(Boolean).length;
      const rating = password.length === 0 ? '' : score <= 2 ? 'weak' : score <= 3 ? 'fair' : 'strong';
      strengthMeter.style.width = `${score * 20}%`;
      strengthMeter.dataset.strength = rating;
      strengthLabel.textContent = password.length === 0
        ? 'Enter a password to check its strength.'
        : `${rating[0].toUpperCase()}${rating.slice(1)} · ${score} of 5 checks`;
    });
  }

  const roleSelect = document.querySelector('#role[name="role"]');
  const subgroupField = document.querySelector('[data-subgroup-field]');
  const subgroupSelect = document.querySelector('#subgroup_code[name="subgroup_code"]');
  if (roleSelect && subgroupField && subgroupSelect) {
    const syncSubgroupRequirement = () => {
      const required = ['subgroup_chairperson', 'subgroup_secretary'].includes(roleSelect.value);
      subgroupField.hidden = !required;
      subgroupSelect.required = required;
      if (!required) subgroupSelect.value = '';
    };
    roleSelect.addEventListener('change', syncSubgroupRequirement);
    syncSubgroupRequirement();
  }

  document.querySelectorAll('form[enctype="multipart/form-data"]').forEach((form) => {
    form.addEventListener('submit', () => {
      const button = form.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = true;
        button.textContent = 'Uploading…';
      }
    });
  });
})();
