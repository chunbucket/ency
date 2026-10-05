/* The release room's one moving part: the countdown, and the button's label
 * flipping once the record is out.
 *
 * Spotify drops at midnight in each listener's own timezone, so the target is
 * local midnight on the release date — not a fixed UTC instant. Someone in
 * Seoul sees zero half a day before someone in New York, which is exactly
 * when the record appears for them.
 *
 * The link never changes: HyperFollow forwards to the live release once it
 * exists, so after the drop the same URL is the listen link. */

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
