/* Turning content into markup, server-side, so a page is complete however it
 * is requested — by a browser, by the router's fetch, or by a crawler. The
 * card markup lives here and nowhere else. */

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* the smeared "content" behind the glass — never legible, just present */
const VEIL =
  '<div class="veil" aria-hidden="true">' +
    '<span class="blob b1"></span><span class="blob b2"></span>' +
    '<span class="ln l1"></span><span class="ln l2"></span><span class="ln l3"></span>' +
  '</div>';

const placeholderCard = () =>
  `<article class="card">${VEIL}<div class="soon">coming soon</div></article>`;

const releaseCard = item => {
  const inner =
    (item.art ? `<img class="art" src="${esc(item.art)}" alt="" loading="lazy">` : VEIL) +
    `<div class="label">${esc(item.title)}</div>`;
  return item.href
    ? `<a class="card" href="${esc(item.href)}"${item.href.startsWith('http')
        ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`
    : `<article class="card">${inner}</article>`;
};

export function renderGrid({ slots = 0, items = [], wide = false }) {
  const cells = [];
  for (let i = 0; i < slots; i++) {
    cells.push(items[i] ? releaseCard(items[i]) : placeholderCard());
  }
  return `<div class="grid${wide ? ' two' : ''}">\n      ${cells.join('\n      ')}\n    </div>`;
}

/* A rail: the same cards on one horizontal track. Slides are server-rendered
   like everything else, so the row is complete before Swiper touches it and
   still scrolls natively if the script never arrives. */
export function renderRail({ slots = 0, items = [] }) {
  const cells = [];
  for (let i = 0; i < slots; i++) {
    cells.push('<div class="swiper-slide rail-cell">' +
      (items[i] ? releaseCard(items[i]) : placeholderCard()) + '</div>');
  }
  return `<div class="rail">
      <div class="swiper rail-track">
        <div class="swiper-wrapper">
          ${cells.join('\n          ')}
        </div>
      </div>
      <div class="rail-nav">
        <button class="prev" type="button" aria-label="Previous">&#8592;</button>
        <button class="next" type="button" aria-label="Next">&#8594;</button>
      </div>
    </div>`;
}

export function renderSections(sections) {
  return sections.map(section =>
    '<section class="sect">\n' +
    `    <h2>${esc(section.id)}</h2>\n` +
    '    <div class="rule"></div>\n' +
    (section.note ? `    <p class="sect-note">${esc(section.note)}</p>\n` : '') +
    `    ${section.rail ? renderRail(section) : renderGrid(section)}\n` +
    '  </section>'
  ).join('\n\n  ');
}

export function renderServices(s) {
  const items = s.items.map(i => `
        <li><span class="k">${esc(i.name)}</span><span class="v">${esc(i.note)}</span></li>`).join('');
  return `<section class="sect">
    <h2>BOOKING</h2>
    <div class="rule"></div>
    <div class="services">
      <p class="svc-lede">${esc(s.lede)}</p>
      <p class="svc-body">${esc(s.body)}</p>
      <ul class="svc-list">${items}
      </ul>
      <a class="svc-cta" href="${esc(s.cta.href)}">${esc(s.cta.label)}</a>
    </div>
  </section>`;
}

export function renderCrates(c) {
  const steps = c.steps.map(i => `
        <li><span class="k">${esc(i.k)}</span><span class="v">${esc(i.v)}</span></li>`).join('');
  const cta = c.available
    ? `<a class="svc-cta" href="${esc(c.download)}">Download for Mac · ${esc(c.version)}</a>`
    : `<span class="svc-cta cuts-off" aria-disabled="true">signed build coming this week</span>`;
  return `<section class="sect">
    <div class="cuts">
      <div class="cuts-hero">
        <img src="/media/crates/icon.png" alt="" width="96" height="96">
        <p class="svc-lede">${esc(c.lede)}</p>
      </div>
      <p class="svc-body">${esc(c.body)}</p>
      <ul class="svc-list">${steps}
      </ul>
      <p class="cuts-req">${esc(c.requires)} · ${esc(c.rights)}</p>
      ${cta}
      <p class="cuts-links"><a href="${esc(c.source)}" target="_blank" rel="noopener noreferrer">source on GitHub</a></p>
      <p class="cuts-note">${esc(c.network)}</p>
    </div>
  </section>`;
}

/* The before/after deck. Server-rendered so the markup is complete before
   js/ab.js touches it, and so the page still says what it is with no script. */
export function renderAB(ab) {
  const sideBtn = (s, i) =>
    `<button class="ab-side${i === 0 ? ' on' : ''}" type="button" role="radio"
              aria-checked="${i === 0}">
          <span class="lb">${esc(s.label)}</span>
          <span class="lu">${esc(s.lufs)}</span>
        </button>`;

  return `<section class="sect">
    <h2>BEFORE / AFTER</h2>
    <div class="rule"></div>
    <div class="ab" tabindex="0" data-a="${esc(ab.a.src)}" data-b="${esc(ab.b.src)}"
         aria-label="Before and after mastering, ${esc(ab.track)}">
      <p class="svc-lede">${esc(ab.lede)}</p>
      <p class="svc-body">${esc(ab.body)}</p>

      <div class="ab-deck">
        <button class="ab-play" type="button" aria-label="Play">
          <span class="ab-glyph" aria-hidden="true"></span>
        </button>
        <span class="ab-bar"><span class="ab-fill"></span></span>
        <span class="ab-time">0:00 / 0:00</span>
      </div>

      <div class="ab-switch" role="radiogroup" aria-label="Which render to hear">
        ${sideBtn(ab.a, 0)}
        ${sideBtn(ab.b, 1)}
      </div>

      <p class="ab-status" role="status" aria-live="polite"></p>
      <p class="ab-meta">${esc(ab.track)} \u00b7 ${esc(ab.length)} from ${esc(ab.from)}</p>
      <p class="ab-note">${esc(ab.matched)}</p>
    </div>
  </section>`;
}
