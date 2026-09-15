/* Search metadata, as data.
 *
 * Every public page gets its head built here and interpolated server-side, so
 * there is one place where the site says who it is. The rule for this file:
 * nothing aspirational. A crawler that reads a claim we cannot back up learns
 * to distrust the rest, and an artist entity is built out of consistency
 * across sources, not out of adjectives.
 *
 * `sameAs` is the load-bearing field. It is how Google merges the Instagram,
 * TikTok and SoundCloud profiles into one entity with the site at its centre
 * rather than four unrelated pages that happen to share a word. Add a profile
 * here the day it exists — Spotify, Apple Music, Bandcamp, Beatport, Resident
 * Advisor, MusicBrainz — and make the name string identical on every one.
 */

export const SITE = {
  origin: 'https://ency.world',
  name: 'Ency',
  legalName: 'ENCY WORLD, LLC',
  locality: 'New York',
  region: 'NY',
  country: 'US',
  genres: ['Progressive house', 'Techno', 'Electronic'],
  blurb:
    'Ency is a progressive house and techno producer and DJ based in New York City.',
  sameAs: [
    'https://instagram.com/en.cy_',
    'https://www.tiktok.com/@en.cy_',
    'https://soundcloud.com/encymusic',
  ],
};

/* Per-page title and description. Titles lead with the distinguishing words,
 * not with the brand: "ency" alone competes with a dictionary entry and a
 * CAD/CAM company that runs a conference called ENCY World, so the qualifier
 * is what makes the result findable at all. Descriptions are written to be
 * read by a person in a result list, not stuffed. */
const PAGES = {
  '/': {
    title: 'Ency — progressive house and techno producer and DJ, New York City',
    description:
      'Ency is a progressive house and techno producer and DJ based in New York ' +
      'City, building a record and a world around it. Music, mixing and ' +
      'mastering, and the tools behind them.',
  },
  '/music': {
    title: 'Music — Ency | progressive house and techno from New York City',
    description:
      'ARMORY01 — seven original progressive house and techno records by Ency, ' +
      'written and mastered in New York City.',
  },
  '/services': {
    title: 'Mixing and mastering — Ency | New York City',
    description:
      'Mixing and mastering by Ency, a progressive house and techno producer in ' +
      'New York City. Loud enough for a club, intact on headphones.',
  },
  '/tools': {
    title: 'Tools — Ency | software for producers and DJs',
    description:
      'Software built by Ency for the work: Crates, a menu bar record player for ' +
      'the Mac, and a reference-matching mastering engine in progress.',
  },
  '/crates': {
    title: 'Crates — a menu bar record player for the Mac | Ency',
    description:
      'Drop a link, get a record. Crates files the audio as FLAC with art, title ' +
      'and source embedded, analysed for BPM and key. Free and open source.',
  },
};

/* Pages a crawler should see, and roughly how often each changes. The
 * portfolio is deliberately absent: it is noindex, and a Disallow line in
 * robots.txt would publish the very path it is meant to keep quiet. */
export const INDEXABLE = ['/', '/music', '/services', '/tools', '/crates'];

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* One JSON-LD graph, emitted on every page, describing the same two nodes with
 * stable @ids. Repeating it per page is correct: each page is independently
 * crawled, and a consistent entity across all of them is the signal. */
function jsonLd(pathname) {
  const page = PAGES[pathname] || PAGES['/'];
  const graph = [
    {
      '@type': 'MusicGroup',
      '@id': SITE.origin + '/#artist',
      name: SITE.name,
      alternateName: 'ENCY',
      url: SITE.origin + '/',
      description: SITE.blurb,
      genre: SITE.genres,
      foundingLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: SITE.locality,
          addressRegion: SITE.region,
          addressCountry: SITE.country,
        },
      },
      sameAs: SITE.sameAs,
    },
    {
      '@type': 'WebSite',
      '@id': SITE.origin + '/#website',
      url: SITE.origin + '/',
      name: SITE.name,
      description: page.description,
      publisher: { '@id': SITE.origin + '/#artist' },
      inLanguage: 'en',
    },
  ];
  // </script> inside a string would close the block early
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003c');
}

/** The whole head block for a path: title, description, canonical, social
 *  cards and the entity graph. Interpolated into `<!--{{head}}-->`. */
export function head(pathname) {
  const page = PAGES[pathname] || PAGES['/'];
  const canonical = SITE.origin + (pathname === '/' ? '/' : pathname);
  const image = SITE.origin + '/icon-512.png';

  return [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    '',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(SITE.name)}">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(page.description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(page.title)}">`,
    `<meta name="twitter:description" content="${esc(page.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    '',
    `<script type="application/ld+json">${jsonLd(pathname)}</script>`,
  ].join('\n');
}

/** robots.txt — everything open except the API, with the sitemap advertised. */
export function robotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /studio',
    '',
    `Sitemap: ${SITE.origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** sitemap.xml, generated from INDEXABLE so a new room is one line, not a file. */
export function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = INDEXABLE.map(p =>
    '  <url>\n' +
    `    <loc>${SITE.origin}${p === '/' ? '/' : p}</loc>\n` +
    `    <lastmod>${today}</lastmod>\n` +
    `    <priority>${p === '/' ? '1.0' : '0.8'}</priority>\n` +
    '  </url>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls + '\n</urlset>\n';
}
