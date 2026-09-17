# ency

Artist project site. The page is the mesh: a parametric Möbius ribbon rasterized
live into a character grid, which resolves into the arc mark. Below it, a gate:
say the word, leave your number, and you're beamed
through a wormhole into the lobby — a small pixel minimap, centered, with the
mesh still playing behind it, blurred and darker. Every number that has ever
joined wanders in there as a tiny body, live. A lock opens the studio.

No build step, no dependencies. `npm start` and open the port.

## Layout

No build step, no dependencies. `npm start` and open the port.

```
index.html        the gate — markup only; also the shell rooms open inside
tools.html        \ rooms: markup plus a {{…}} slot the server fills
music.html        /
studio.html       gated: the mesh plus every dial
lab.html          mesh v2 prototype, unlisted
server.mjs        the whole backend — static, pages, gate/join, lobby, auth
styles/site.css   one stylesheet; <html class="gate|page"> settles the rest
js/
  pages/gate.js   entry: the gate, which hosts the rooms
  pages/room.js   entry: a room loaded directly, with its own backdrop
  gate.js         the gate — join flow, lobby, lock; returns the shell
  router.js       soft routing; never touches anything outside <main>
  chrome.js       the corner nav and the links row
  tilt.js         cards lean toward the cursor
  backdrop.js     the mesh as scenery for a standalone room
  vendor/         ribbon.js, lobby.js — ported from the artifact, left alone
content/
  site.mjs        sections and releases, as data
  render.mjs      content -> markup, server-side only
```

Application code is ES modules; `vendor/` stays classic scripts assigning
globals, because it is a copy of the artifact and not ours to restructure.
Nothing under `content/` is ever served — it is imported by `server.mjs` and
interpolated into a page at request time, so the markup ships complete however
it is asked for.

### Why the router is hand-written

Every framework router swaps DOM to navigate. The mesh must not be torn down,
and a persisted canvas is exactly what those swaps handle worst — Astro's
`transition:persist` detaches the whole body and lost canvas contexts in
Safari 18 over it. This router fills `<main>` and touches nothing else, so the
canvas is the same node from the gate through every room. That is the one
thing to preserve if this ever moves onto a framework.

## The lobby

One tiny pixel body per phone number, grayscale on the site's ink, with the
mesh's own diffraction rainbow (`wl2rgb` ported from `ribbon.js`) firing only
on joins and the odd glint. Joins arrive live over `/api/lobby/stream` (SSE) —
the stream only ever carries a **count**, never a number. Arrows/WASD or tap
inside the panel to move. A device that has joined once skips the gate
(`localStorage.ency_joined`) and gets the panel on arrival.

No texts are sent yet: numbers are collected into `phones.jsonl` and that's
all. When the first text should go out, register a toll-free number with an
SMS provider (Twilio is the boring, right answer) and wire it then — nothing
in this repo needs to change shape for that.

## The renderer

`ribbon.js` is ported from the **ㄴ + ㅅ — ASCII Ribbon Morph** artifact:
<https://claude.ai/code/artifact/30226fb8-9091-4143-88a1-7a52ceb6c557>

The geometry, z-buffer shading, morph staggering and idle motion are unchanged
from there. Three things differ:

1. it takes a canvas and container instead of reaching for control markup by id,
   so the public page and the studio share one copy;
2. `paper` is part of the state object (it was a CSS variable in the artifact);
3. the focal length is `min(W*0.60, H*0.80)` rather than `W*0.60` — identical at
   the artifact's 4:3 (both 432 at 720×540) but it stops the ribbon overflowing
   on a fullscreen wide viewport.

**This is a copy, not a link.** Fixes made in the artifact do not arrive here.

## Studio

`/studio`, behind the lock on the public page. Every dial from the artifact,
live on the real page, plus **publish** — which writes the current settings as
what the public sees. `revert` returns to the last published state, so you can
explore without committing.

Three dials are not from the artifact. **thin** (`thin`, 0–6%) erodes the mark by that fraction of its size on every edge, holes included, so the strokes lose weight uniformly on any viewport. **rotate** (`rotate`, ±45°) turns the artwork about its centre, counter-clockwise positive. And **size** (`scale`, 0.4–2×). It multiplies the
ribbon's focal length and the mark's fit by the same factor so they stay in
proportion through the morph. Past roughly 1.4× the mark starts to overlap the
gate field on a laptop viewport.

## Environment

| var | required | notes |
|---|---|---|
| `ADMIN_PASSWORD` | yes | studio is closed if unset |
| `SESSION_SECRET` | yes | random per boot if unset, which drops sessions on restart |
| `GATE_PASSWORD` | yes | the fan gate; unset fails closed, set to rotate without a deploy |
| `DATA_DIR` | prod | `/data` on Railway; defaults to `./data` locally |
| `PORT` | no | defaults to 4720 |

## Data

Three files under `DATA_DIR`:

- `emails.jsonl` — one `{email, ts}` per line, append-only (the old list; the
  field is gone from the page but the data and `/api/subscribers` remain)
- `phones.jsonl` — one `{phone, ts}` per line, append-only, E.164-normalized
  (bare US 10-digit gets `+1`)
- `preset.json` — the published mesh settings

Deduped via a `Set` loaded at boot. Emails and numbers are never logged, only
written, and numbers only leave the box through studio-authed `/api/phones`.

**This is deliberately the smallest thing that works.** Move to Postgres when you
want dedupe or analytics across more than one instance, or when the file passes a
few thousand lines. Note that a volume means a single writer: scaling the service
to two instances would interleave writes.

## Security

- password compared with `timingSafeEqual` over SHA-256 digests, so neither the
  content nor the length leaks through timing
- session cookie is `exp.HMAC(exp)` — HttpOnly, SameSite=Strict, `Secure` when
  `x-forwarded-proto` says https
- rate limits: 8 unlock attempts / 15 min, 15 gate attempts / 10 min,
  6 joins / min, 5 subscribes / min, per IP. In memory, so they reset on
  redeploy — the passwords are the real control.
- the SSE lobby stream is public but stateless: count only, capped at 200
  concurrent connections, heartbeat every 25s so proxies keep them open.
