/* The release room's one moving part: the countdown, and the button's label
 * flipping once the record is out.
 *
 * Spotify drops at midnight in each listener's own timezone, so the target is
 * local midnight on the release date — not a fixed UTC instant. Someone in
 * Seoul sees zero half a day before someone in New York, which is exactly
 * when the record appears for them.
 *
 * Before the drop the button goes straight to Spotify's sign-in for the
 * presave; after it, to the HyperFollow link, which forwards to the release. */

const root = document.querySelector('.drop');

if (root) {
  const [y, m, d] = root.dataset.release.split('-').map(Number);
  const target = new Date(y, m - 1, d).getTime();   // local midnight

  const count = root.querySelector('.drop-count');
  const date = root.querySelector('.drop-date');
  const cta = root.querySelector('.drop-cta');

  const pad = n => String(n).padStart(2, '0');

  const tick = () => {
    const left = target - Date.now();
    if (left <= 0) {
      count.hidden = true;
      date.textContent = 'out now';
      cta.textContent = 'listen on spotify';
      if (cta.dataset.listen) cta.href = cta.dataset.listen;
      return false;
    }
    const s = Math.floor(left / 1000);
    const days = Math.floor(s / 86400);
    const hrs = Math.floor(s / 3600) % 24;
    const min = Math.floor(s / 60) % 60;
    const sec = s % 60;
    count.textContent = `${days}d ${pad(hrs)}h ${pad(min)}m ${pad(sec)}s`;
    count.hidden = false;
    return true;
  };

  if (tick()) {
    const id = setInterval(() => { if (!tick()) clearInterval(id); }, 1000);
  }
}

/* The sleeve follows the cursor anywhere on the page, not only while hovered:
 * it leans toward the pointer, and a soft glare slides across the art. The
 * target is set on pointermove; a frame loop eases toward it and parks itself
 * once settled, so nothing runs while the mouse is still. Touch and reduced
 * motion leave it flat. */

const tilt = document.querySelector('.drop-tilt');
const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

if (tilt && !still) {
  const MAX_X = 9, MAX_Y = 12;          // degrees at the far edge of the window
  const cur = { rx: 0, ry: 0, gx: 50, gy: 30, go: 0 };
  const tgt = { ...cur };
  let raf = 0;

  const frame = () => {
    let moving = false;
    for (const k in cur) {
      const d = tgt[k] - cur[k];
      if (Math.abs(d) > 0.01) { cur[k] += d * 0.09; moving = true; }
      else cur[k] = tgt[k];
    }
    const s = tilt.style;
    s.setProperty('--rx', cur.rx.toFixed(2) + 'deg');
    s.setProperty('--ry', cur.ry.toFixed(2) + 'deg');
    s.setProperty('--gx', cur.gx.toFixed(1) + '%');
    s.setProperty('--gy', cur.gy.toFixed(1) + '%');
    s.setProperty('--go', cur.go.toFixed(3));
    raf = moving ? requestAnimationFrame(frame) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const r = tilt.getBoundingClientRect();
    // distance from the art's centre, normalised to the window so the lean
    // is gentle from across the page and fullest near the edges
    const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
    tgt.ry = nx * MAX_Y;
    tgt.rx = -ny * MAX_X;
    tgt.gx = 50 + nx * 45;
    tgt.gy = 50 + ny * 45;
    tgt.go = 1;
    kick();
  }, { passive: true });

  // mouse leaves the window: settle back flat
  document.documentElement.addEventListener('pointerleave', () => {
    Object.assign(tgt, { rx: 0, ry: 0, gx: 50, gy: 30, go: 0 });
    kick();
  });
}
