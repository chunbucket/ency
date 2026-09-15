/* Site content, as data. Server-side only — never served to the browser.
 *
 * A section renders one card per slot: an entry from `items` where there is
 * one, a coming-soon placeholder where there is not. Shipping a release means
 * adding to `items` here, not editing markup. */

export const MUSIC_SECTIONS = [
  {
    id: 'ARMORY01',
    note:
      'Seven original progressive house and techno records, written and ' +
      'mastered in New York City. Built as tools for DJ sets — bridging ' +
      'classic soul with ethereal, futuristic sound design.',
    slots: 6,
    items: [
      // { title: '…', href: '…', art: '/art/….jpg' }
    ],
  },
];

export const TOOLS = {
  slots: 2,
  wide: true,
  items: [
    { title: 'Crates', href: '/crates', art: '/media/crates/card.png' },
  ],
};

/* Crates — the Mac app, on its own room off tools. `available` gates the
 * download button: flip it when a signed build is on GitHub. Wording is
 * deliberate: it records a link; it never names a site. */
export const CRATES = {
  available: false,
  version: '0.3.0',
  download: 'https://github.com/chunbucket/crates/releases/latest/download/Crates.dmg',
  source: 'https://github.com/chunbucket/crates',
  lede: 'A menu bar record player. Drop a link, get a record.',
  body:
    'Drag a link from the address bar onto the icon. The record spins while it records, ' +
    'then the FLAC is filed in your crate with the art, title and source inside. Open the ' +
    'crate to play it, scrub it, sort by BPM or key, or drag it straight into Ableton.',
  steps: [
    { k: 'drop',   v: 'a link onto the menu bar icon, or the tray that slides in' },
    { k: 'record', v: 'the audio comes down and is pressed to FLAC' },
    { k: 'file',   v: 'into your crates, analysed for BPM and key, art and source embedded' },
  ],
  requires: 'Apple silicon · macOS 14 or later · free · open source',
  rights: 'For material you have the right to record.',
  network:
    'It talks to the site the link points at, and to GitHub once a day to see if there is ' +
    'a newer version. Nothing else, and nothing is sent anywhere.',
};

/* Services — offered work, on its own room off the gate. Deliberately thin:
 * no rates, turnaround or credits until they are real. */
export const SERVICES = {
  lede: 'Mixing and mastering, available for booking.',
  body:
    'I master my own records for release and for DJ sets, and I take on work ' +
    'for other artists.',
  items: [
    { name: 'Mixing',    note: 'balance, space, and the low end' },
    { name: 'Mastering', note: 'loud enough for a club, intact on headphones' },
  ],
  cta: { label: 'Enquire', href: 'mailto:noah@ency.world?subject=Mixing%20%2F%20mastering' },
};
