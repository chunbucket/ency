/* The gate: the mesh, the password → number flow, the lobby, and the studio
 * lock. It is also the shell the rooms open inside — createGate() returns
 * { demote, restore } for the router to call.
 *
 * `createRibbon`, `createLobby` and `createWormhole` are globals from
 * js/vendor/*.js, which are classic scripts rather than modules — they are
 * vendored from the artifact and deliberately left alone.
 */

export function createGate() {
  'use strict';

  // the page is an app surface: no pinch, no double-tap zoom. iOS ignores
  // user-scalable=no in Safari, so its gesture events are blocked directly.
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault());

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = document.getElementById('cv');
  const foot = document.getElementById('foot');
  const line = document.getElementById('line');
  const form = document.getElementById('sub');
  const input = document.getElementById('word');
  const said = document.getElementById('said');
  const enterBtn = document.getElementById('enter');

  let ribbon = null, lobby = null, savedMouse = null;
  let demoted = false, roomScale = null;

  /* ---- the lobby ---------------------------------------------------- */

  // a small centered window; the mesh keeps playing behind it, pushed back —
  // a little blurred, a little darker
  function bootLobby(animate) {
    if (lobby) return lobby;
    foot.style.display = 'none';
    cv.style.transition = animate ? 'opacity 1200ms ease, filter 1200ms ease' : 'none';
    cv.style.opacity = '1';                          // undo the beam's dimming
    cv.style.filter = 'blur(4px) brightness(0.55)';
    if (ribbon) {
      if (savedMouse === null) savedMouse = ribbon.getState().mouse;
      ribbon.setState({ mouse: 0 });   // backdrop, not a toy, while it is up
      ribbon.setPace(2);               // and blurred anyway — half rate is invisible
    }
    // starts as just you; the stream corrects the count on connect
    lobby = createLobby({ count: 1, reduced });
    if (demoted) lobby.root.style.visibility = 'hidden';   // a room is already open
    return lobby;
  }

  // Esc steps back out: the room closes, the mesh sharpens, and the foot
  // returns as a doorway — one button for those already aboard.
  function exitLobby() {
    if (!lobby) return;
    lobby.destroy();
    lobby = null;
    if (ribbon) {
      ribbon.setPace(1);
      if (savedMouse !== null) ribbon.setState({ mouse: savedMouse });
    }
    cv.style.transition = 'filter 700ms ease, opacity 700ms ease';
    cv.style.filter = 'none';
    foot.style.display = '';
    foot.style.opacity = '1';        // it may still carry the beam's fade-out
    line.textContent = 'welcome back';
    form.style.display = 'none';
    enterBtn.hidden = false;
    said.classList.remove('on');
  }

  enterBtn.addEventListener('click', () => bootLobby(false));

  /* ---- the shell ----------------------------------------------------
   * Opening a room demotes this mesh rather than building another, so the
   * animation carries straight through instead of restarting.
   *
   * Everything the gate put on the page goes with it: the foot, and the whole
   * of the lobby — coordinates, window and countdown. A room is a room, not a
   * room with the front door still standing in it.
   * setState({ scale }) rebuilds the targets without calling play(), so the
   * clock is untouched. */

  function demoteRibbon() {
    if (!ribbon) return;
    if (savedMouse === null) savedMouse = ribbon.getState().mouse;
    if (roomScale === null) roomScale = ribbon.getState().scale;
    ribbon.setState({ mouse: 0, scale: 0.5 });
    ribbon.setPace(2);
  }

  const shell = {
    demote() {
      demoted = true;
      foot.style.display = 'none';
      if (lobby) lobby.root.style.visibility = 'hidden';
      cv.style.transition = 'filter 700ms ease, opacity 700ms ease';
      cv.style.filter = 'blur(7px) brightness(0.4)';
      cv.style.opacity = '0.62';
      demoteRibbon();                        // no-op until the ribbon exists
      document.documentElement.classList.add('room');
      document.body.classList.add('room');
    },

    restore() {
      demoted = false;
      document.documentElement.classList.remove('room');
      document.body.classList.remove('room');
      if (ribbon) {
        if (roomScale !== null) ribbon.setState({ scale: roomScale });
        ribbon.setPace(lobby ? 2 : 1);
        if (!lobby && savedMouse !== null) ribbon.setState({ mouse: savedMouse });
      }
      // the lobby has its own idea of how the mesh should sit behind it
      cv.style.filter = lobby ? 'blur(4px) brightness(0.55)' : 'none';
      cv.style.opacity = '1';
      if (lobby) lobby.root.style.visibility = '';
      else foot.style.display = '';
    },
  };

  /* ---- boot ---------------------------------------------------------- */

  (async () => {
    // joined once from this device → the panel is already there on arrival
    const remembered = localStorage.getItem('ency_joined') === '1';

    // load the published preset before first paint, so visitors never see the
    // defaults flash over to the real settings
    let preset = null;
    try {
      const res = await Promise.race([
        fetch('/api/preset', { headers: { accept: 'application/json' } }),
        new Promise(r => setTimeout(() => r(null), 1500)),
      ]);
      if (res && res.ok) preset = (await res.json()).preset;
    } catch { /* fall through to defaults */ }

    // exposed for console poking, same as flowfield's window.__ff.
    // try/catch so a zero-size first layout (hidden tab, restored session)
    // cannot take the gate down with the mesh — the renderer's own resize
    // handler rebuilds it once the viewport is real
    try {
      ribbon = window.__ribbon = createRibbon({
        canvas: cv,
        container: document.body,
        state: preset || {},
        skipIntro: remembered,     // lobby-first loads start on the formed mark
      });
    } catch (err) {
      console.warn('ribbon deferred:', err.message);
    }

    // a room opened while this was still loading: honour it now rather than
    // coming up at full size behind the cards
    if (demoted) demoteRibbon();

    if (remembered) { if (!demoted) bootLobby(); return; }

    bindJoinFlow();
  })();

  /* ---- password, then the number ------------------------------------- */

  function bindJoinFlow() {
    const say = (msg, bad) => {
      said.textContent = msg;
      said.classList.toggle('bad', !!bad);
      said.classList.add('on');
    };

    let stage = 'gate';    // -> 'phone' once the word is right
    let gateWord = '';

    // mirror of the server's rule, so a typo bounces without a round-trip:
    // strip formatting, a bare US 10-digit gets +1, then E.164's 7–15 digits
    const normalizePhone = raw => {
      let s = raw.replace(/[\s().\-]/g, '');
      if (/^\d{10}$/.test(s)) s = '+1' + s;
      else if (/^\d{11,15}$/.test(s)) s = '+' + s;
      return /^\+\d{7,15}$/.test(s) ? s : null;
    };

    // in the phone stage, letters never even land in the field
    input.addEventListener('input', () => {
      if (stage !== 'phone') return;
      const clean = input.value.replace(/[^\d\s().+\-]/g, '');
      if (clean !== input.value) input.value = clean;
    });

    function toPhoneStage() {
      stage = 'phone';
      form.classList.remove('flash');
      void form.offsetWidth;           // restart the breath if they re-enter
      form.classList.add('flash');
      input.value = '';
      input.type = 'tel';
      input.name = 'phone';
      input.autocomplete = 'tel';
      input.inputMode = 'tel';
      input.placeholder = 'phone number';
      input.setAttribute('aria-label', 'Phone number for texts');
      line.textContent = 'your number — texts, occasionally';
      said.classList.remove('on', 'bad');
      said.textContent = '';
      input.focus();
    }

    function backToGate(msg) {
      stage = 'gate'; gateWord = '';
      input.value = '';
      input.type = 'password';
      input.name = 'gate';
      input.autocomplete = 'off';
      input.placeholder = 'password';
      input.setAttribute('aria-label', 'Password');
      line.textContent = 'say the word';
      if (msg) say(msg, true);
    }

    // The beam: the field falls away and the mesh dims while the wormhole
    // forms from its characters; your digits fly in first; then the whole
    // tunnel collapses into the little lobby panel in the corner.
    function beamIn(phone) {
      localStorage.setItem('ency_joined', '1');
      const fromRect = input.getBoundingClientRect();
      foot.style.transition = 'opacity 450ms ease';
      foot.style.opacity = '0';
      cv.style.transition = 'opacity 1200ms ease';
      cv.style.opacity = '0.35';
      createWormhole({ text: phone, fromRect, reduced }, () => bootLobby(true).panel);
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;

      if (stage === 'gate') {
        try {
          const res = await fetch('/api/gate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: value }),
          });
          if (res.ok) { gateWord = value; toPhoneStage(); }
          else if (res.status === 429) say('too many attempts — wait a while', true);
          else { say('no', true); input.select(); }
        } catch {
          say('no connection', true);
        }
        return;
      }

      const phone = normalizePhone(value);
      if (!phone) {
        say("that doesn't look like a phone number", true);
        input.select();
        return;
      }

      try {
        const res = await fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: gateWord, phone }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          form.classList.add('done');
          beamIn(value);
        } else if (res.status === 401) {
          backToGate('the word changed — try again');   // rotated mid-session
        } else {
          say(body.error || 'that did not go through', true);
        }
      } catch {
        say('no connection', true);
      }
    });
  }

  /* ---- the studio lock ------------------------------------------------ */

  const scrim = document.getElementById('scrim');
  const pw = document.getElementById('pw');
  const err = document.getElementById('err');

  const openLock = on => {
    scrim.classList.toggle('on', on);
    if (on) setTimeout(() => pw.focus(), 60);
    else { pw.value = ''; err.textContent = ''; }
  };

  document.getElementById('lock').addEventListener('click', () => openLock(true));
  scrim.addEventListener('click', e => { if (e.target === scrim) openLock(false); });

  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (scrim.classList.contains('on')) { openLock(false); return; }
    if (lobby) exitLobby();          // step back out to the mesh
  });

  document.getElementById('unlock').addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    try {
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      if (res.ok) { location.href = '/studio'; return; }
      const body = await res.json().catch(() => ({}));
      err.textContent = res.status === 429
        ? 'too many attempts — wait a while'
        : (body.error || 'no');
      pw.select();
    } catch {
      err.textContent = 'no connection';
    }
  });

  return shell;
}
