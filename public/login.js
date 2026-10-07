'use strict';

const form = document.getElementById('f');
const err = document.getElementById('err');
const go = document.getElementById('go');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  go.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }),
    });
    if (res.ok) { location.href = '/'; return; }
    const body = await res.json().catch(() => ({}));
    err.textContent = body.error || 'Sign in failed';
  } catch {
    err.textContent = 'Could not reach the server';
  } finally {
    go.disabled = false;
  }
});

// show / hide the password while typing
const pw = document.getElementById('pw');
const eye = document.getElementById('eye');
eye.addEventListener('click', () => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  eye.classList.toggle('shown', show);
  eye.setAttribute('aria-pressed', String(show));
  eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  eye.title = show ? 'Hide password' : 'Show password';
  pw.focus();
});
