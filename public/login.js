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
