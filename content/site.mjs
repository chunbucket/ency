/* Site content, as data. Server-side only — never served to the browser.
 *
 * A section renders one card per slot: an entry from `items` where there is
 * one, a coming-soon placeholder where there is not. Shipping a release means
 * adding to `items` here, not editing markup. */

export const MUSIC_SECTIONS = [
  {
    id: 'ARMORY01',
    rail: true,          // one horizontal track, not a grid that reflows
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
  lede: 'Drop a link. Get a record.',
  body:
    'Crates sits in your menu bar. Drag any link onto it and the track lands in your ' +
    'crate a moment later, with the art, title, BPM and key already filled in. Play it ' +
    'there, or drag it straight into Ableton.',
  steps: [
    { k: 'drop', v: 'any link onto the menu bar icon' },
    { k: 'keep', v: 'it lands in your crate, tagged and sorted' },
    { k: 'play', v: 'from there, or drag it into Ableton' },
  ],
  requires: 'Lossless FLAC · free and open source · macOS 14 or later, Apple silicon',
  rights: 'For music you have the right to record.',
  network:
    'Crates only talks to the site your link points at, and to GitHub once a day to check ' +
    'for a newer version. Nothing you drop ever leaves your machine.',
};

/* The before/after. Two renders of the same forty-five seconds of Solstice.
 *
 * `lufs` is what each file measures as rendered — the honest number, printed on
 * the page. The files themselves are both encoded at -18 LUFS, because the
 * master is 19 dB louder and louder always wins a blind comparison. Swapping in
 * a different pair is two paths here; keep them the same length and the same
 * bounce, or the switch compares two different moments. */
export const AB = {
  track: 'Solstice',
  from: '5:20',
  length: '45 seconds',
  lede: 'The same forty-five seconds, before and after mastering.',
  body:
    'Switch sides while it plays. The playhead does not move, so you are always ' +
    'hearing the same moment two ways.',
  a: { label: 'premaster', src: '/media/audio/solstice-premaster.mp3', lufs: '\u221228.4 LUFS' },
  b: { label: 'master',    src: '/media/audio/solstice-master.mp3',    lufs: '\u22129.0 LUFS' },
  matched:
    'Both sides play at \u221218 LUFS. As rendered the master is 19 dB louder, and ' +
    'louder always sounds better \u2014 an A/B that does not match levels is a volume ' +
    'test, not a comparison.',
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
