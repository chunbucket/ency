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

export function renderSections(sections) {
  return sections.map(section =>
    '<section class="sect">\n' +
    `    <h2>${esc(section.id)}</h2>\n` +
    '    <div class="rule"></div>\n' +
    (section.note ? `    <p class="sect-note">${esc(section.note)}</p>\n` : '') +
    `    ${renderGrid(section)}\n` +
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
