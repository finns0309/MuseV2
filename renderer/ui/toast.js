// Toast — the inverted pill at the bottom of the panel (above the composer at
// home). One at a time; a new message replaces the old one and restarts the
// clock. Any module can call show(); cmdk mounts it.

let toastEl = null;
let timer = null;

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export function mountToast(el) { toastEl = el; }

export function show(msg, level = 'error') {
  if (!toastEl) return;
  toastEl.textContent = cap(String(msg));     // sentence case, whatever the caller wrote
  toastEl.dataset.level = level;
  toastEl.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}
