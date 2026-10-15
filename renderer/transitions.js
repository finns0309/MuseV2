// State transition animations — the FLIP shared-element move, window
// appear/hide, the cover tilt. (A track change is the cover dissolve and the
// text-in stagger in ui/hero.js + style.css.) cmdk.js calls these;
// CSS keyframes handle the actual rendering.

// ---- Helpers ----------------------------------------------------------------

export function replay(el, cls) { replayClass(el, cls); }

function replayClass(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ---- FLIP — shared-element move ---------------------------------------------
//
// The cover is the one element that survives the idle ⇄ search morph, so it
// should *travel* between its two homes instead of jumping to the new spot
// and resizing there. Measure, mutate layout, measure again, then play the
// inverse transform back to identity. Size is snapped by CSS; scale carries it.

export const EASE_OUT = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
export const EASE_SETTLE = 'cubic-bezier(0.22, 1.1, 0.3, 1)';   // slight overshoot, for arrivals

export function flip(el, mutate, { duration = 220, easing = EASE_OUT } = {}) {
  if (!el) { mutate(); return Promise.resolve(); }
  const first = el.getBoundingClientRect();
  mutate();
  const last = el.getBoundingClientRect();
  if (!first.width || !last.width) return Promise.resolve();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / last.width;
  const sy = first.height / last.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01) return Promise.resolve();

  el.dataset.flipping = '1';
  el.style.transition = 'none';
  el.style.transformOrigin = 'top left';
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  void el.offsetWidth;
  el.style.transition = `transform ${duration}ms ${easing}`;
  el.style.transform = '';          // → whatever the stylesheet says (idle: the tilt at 0°)

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      el.style.transition = '';
      el.style.transformOrigin = '';
      delete el.dataset.flipping;
      resolve();
    };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, duration + 60);
  });
}

// ---- Window appear / hide ---------------------------------------------------

export function animateAppear(panelEl) {
  replayClass(panelEl, 'appear');
}

export function animateHide(panelEl, then) {
  if (!panelEl) { then?.(); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; panelEl.classList.remove('leaving'); then?.(); };
  panelEl.classList.add('leaving');
  panelEl.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 160);
}

// ---- Cover 3D tilt ----------------------------------------------------------

export function initCoverTilt(coverEl) {
  coverEl.addEventListener('mousemove', (e) => {
    const r = coverEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    coverEl.style.setProperty('--ry', `${x * 8}deg`);
    coverEl.style.setProperty('--rx', `${-y * 8}deg`);
  });
  coverEl.addEventListener('mouseleave', () => {
    coverEl.style.setProperty('--ry', '0deg');
    coverEl.style.setProperty('--rx', '0deg');
  });
}

