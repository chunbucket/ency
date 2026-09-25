/* The rail — one horizontal track you drag through, instead of a grid that
 * reflows into rows.
 *
 * Swiper does the part that is genuinely hard to hand-roll: drag with
 * momentum, touch, trackpad and keyboard all behaving the same way. It is the
 * same library the portfolio crate uses, so there is one carousel in this
 * codebase rather than two.
 *
 * It is loaded on demand. The gate is the shell every room opens inside, and
 * putting 150 KB of carousel on the front door to serve a page the visitor may
 * never open is the wrong trade. Until it arrives — or if it never does — the
 * track is a native horizontal scroller, which is why the fallback styles are
 * scoped to :not(.swiper-initialized).
 *
 * Not centred, unlike the crate. Centring is right when one slide is special
 * because it is the one that plays; a row of releases has no such slide, and
 * centring would just park the first card in the middle with a gap beside it.
 */

const SWIPER_JS  = '/js/vendor/swiper-bundle.min.js';
const SWIPER_CSS = '/styles/swiper.min.css';

let pending = null;

function loadSwiper() {
  if (typeof Swiper !== 'undefined') return Promise.resolve();
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${SWIPER_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = SWIPER_CSS;
      document.head.append(link);
    }
    const s = document.createElement('script');
    s.src = SWIPER_JS;
    s.onload = () => resolve();
    s.onerror = () => { pending = null; reject(new Error('swiper')); };
    document.head.append(s);
  });
  return pending;
}

export async function initRail(root = document) {
  const rail = root.querySelector?.('.rail');
  if (!rail || rail.dataset.wired) return null;
  rail.dataset.wired = '1';

  try { await loadSwiper(); } catch { return null; }   // native scroll still works
  if (!rail.isConnected) return null;                  // navigated away mid-load

  const sw = new Swiper(rail.querySelector('.rail-track'), {
    slidesPerView: 'auto',
    spaceBetween: 14,
    grabCursor: true,
    freeMode: { enabled: true, momentum: true, momentumRatio: 0.7 },
    keyboard: { enabled: true },
    mousewheel: { forceToAxis: true },
    navigation: {
      prevEl: rail.querySelector('.rail-nav .prev'),
      nextEl: rail.querySelector('.rail-nav .next'),
    },
    a11y: { enabled: true },
  });

  return () => { try { sw.destroy(true, true); } catch {} };
}

/** Wire the rail now, and again after every soft navigation. */
export function mountRail() {
  let teardown = null;
  const wire = () => { initRail().then(t => { teardown = t; }); };
  wire();
  document.addEventListener('room:enter', () => { teardown?.(); teardown = null; wire(); });
  document.addEventListener('room:leave', () => { teardown?.(); teardown = null; });
}
