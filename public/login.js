'use strict';

const form = document.getElementById('f');
const err = document.getElementById('err');
const go = document.getElementById('go');
const codeRow = document.getElementById('code-row');
const code = document.getElementById('code');

// Ask for the authenticator code only when the server wants one.
fetch('/api/login-options').then((r) => r.json()).then((o) => { codeRow.hidden = !o.code; code.required = !!o.code; }).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  go.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value, code: code.value.trim() }),
    });
    if (res.ok) { location.href = '/'; return; }
    const body = await res.json().catch(() => ({}));
    err.textContent = body.error || 'Sign in failed';
    code.value = ''; // a code works only once
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
