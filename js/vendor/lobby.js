/* lobby.js — the room behind sarang.
 *
 * Two pieces, both drawn from the mesh's own materials (same character ramp,
 * same monospace, same ink-on-paper, and the holo math ported straight from
 * ribbon.js so any flash of color is the site's actual iridescence):
 *
 *   createWormhole(opts, onDone)  the beam-in, played as a boot sequence:
 *                                 targeting brackets snap in, a log types on,
 *                                 your number is read out and struck through,
 *                                 a hexagonal iris dilates in counted steps —
 *                                 hard cuts throughout, nothing eases — then
 *                                 two frames of inversion and the throat
 *                                 swallows the screen and collapses into the
 *                                 lobby panel.
 *
 *   createLobby(opts)             a small HUD-minimap window, centered, with
 *                                 the mesh playing on behind it. Grayscale,
 *                                 one tiny pixel body per phone number; yours
 *                                 is the white one with the heading wedge.
 *                                 New numbers pop in live off
 *                                 /api/lobby/stream.
 *
 * Holo restraint is deliberate: it fires on joins, on the odd ambient glint,
 * and nowhere else. Everything else in here is grays.
 */
(function (global) {
  'use strict';

  var RAMP = ' .·:-=+*ox%#@';
  var MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

  // ---- holo: wavelength→rgb + summed diffraction orders, desaturated to
  // 0.62 — lifted from ribbon.js so this is the same rainbow, not a hue cycle
  function wl2rgb(w) {
    var r, g, b;
    if      (w < 440) { r = (440 - w) / 60; g = 0; b = 1; }
    else if (w < 490) { r = 0; g = (w - 440) / 50; b = 1; }
    else if (w < 510) { r = 0; g = 1; b = (510 - w) / 20; }
    else if (w < 580) { r = (w - 510) / 70; g = 1; b = 0; }
    else if (w < 645) { r = 1; g = (645 - w) / 65; b = 0; }
    else              { r = 1; g = 0; b = 0; }
    var a = 1;
    if (w < 420) a = 0.3 + 0.7 * (w - 380) / 40;
    if (w > 700) a = 0.3 + 0.7 * (780 - w) / 80;
    function cl(v) { return Math.max(0, Math.min(1, v)) * a; }
    return [cl(r), cl(g), cl(b)];
  }

  function holoRGB(u, v, t) {
    var sd = Math.sin(u * 5.1 + v * 8.3 + (t || 0) * 0.6) * 0.9;
    var r = 0, g = 0, b = 0;
    for (var mo = 1; mo <= 3; mo++) {
      var w = 1600 * Math.abs(sd) / mo;
      if (w > 380 && w < 780) { var c = wl2rgb(w), k = 1.3 / mo; r += c[0]*k; g += c[1]*k; b += c[2]*k; }
    }
    var mx = Math.max(r, g, b, 1); r /= mx; g /= mx; b /= mx;
    var lum = r*0.2126 + g*0.7152 + b*0.0722, SAT = 0.62;
    r = lum + (r-lum)*SAT; g = lum + (g-lum)*SAT; b = lum + (b-lum)*SAT;
    return [(r*255)|0, (g*255)|0, (b*255)|0];
  }

  function holoCss(u, v, t, a) {
    var c = holoRGB(u, v, t);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  var rand = function (a, b) { return a + Math.random() * (b - a); };

  /* ==================================================== wormhole ==== */

  function createWormhole(opts, onDone) {
    var reduced = !!opts.reduced;
    var text = String(opts.text || '');
    var from = opts.fromRect || null;

    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;';
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight);
    cv.width = vw * dpr; cv.height = vh * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var CX = vw / 2, CY = vh / 2;
    var R0 = Math.min(vw, vh) * 0.24;
    var DUR = reduced ? 900 : 3400;

    // Eva's core move: nothing eases. Motion advances in discrete steps.
    function snapT(t, fps) { return Math.floor(t * fps) / fps; }
    function built(t, a, b, n) { return Math.max(0, Math.min(n, Math.floor((t - a) / (b - a) * n + 1e-6))); }

    var LOG = [
      [0.00, 'word accepted'],
      [0.18, 'number bound'],
      [0.36, 'route: lobby'],
      [0.62, 'aperture forming'],
      [1.10, 'hex iris: armed'],
      [1.90, 'transit in 3'],
      [2.10, 'transit in 2'],
      [2.30, 'transit in 1'],
    ];

    function hexPath(r, rot) {
      ctx.beginPath();
      for (var i = 0; i < 6; i++) {
        var a = rot + i / 6 * Math.PI * 2;
        var x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }

    var t0 = performance.now();
    var done = false;

    function frame(now) {
      if (done) return;
      var t = (now - t0) / 1000;                   // seconds into the beam
      if (t >= DUR / 1000) { finish(); return; }
      ctx.clearRect(0, 0, vw, vh);

      if (reduced) {                               // reduced motion: a plain iris
        var rr = Math.hypot(vw, vh) * 0.6 * (1 - t / (DUR / 1000));
        ctx.fillStyle = '#161616';
        ctx.beginPath(); ctx.arc(CX, CY, Math.max(0, rr), 0, 7); ctx.fill();
        requestAnimationFrame(frame);
        return;
      }

      // a dark veil so the instruments read; the dimmed mesh ghosts through
      ctx.fillStyle = 'rgba(28,28,28,0.72)';
      ctx.fillRect(0, 0, vw, vh);

      // corner targeting brackets: snap in one by one
      var m = Math.max(18, Math.min(34, vw * 0.03));
      var L = 30;
      var nb = built(t, 0.05, 0.35, 4);
      ctx.strokeStyle = 'rgba(192,192,192,0.85)'; ctx.lineWidth = 1;
      var corners = [[m, m, 1, 1], [vw - m, m, -1, 1], [m, vh - m, 1, -1], [vw - m, vh - m, -1, -1]];
      for (var i = 0; i < nb; i++) {
        var cx2 = corners[i][0], cy2 = corners[i][1], sx = corners[i][2], sy = corners[i][3];
        ctx.beginPath();
        ctx.moveTo(cx2 + L * sx, cy2); ctx.lineTo(cx2, cy2); ctx.lineTo(cx2, cy2 + L * sy);
        ctx.stroke();
      }

      // grid flicker: the field blinks in for single frames while arming
      if (t > 0.4 && t < 1.1 && ((t * 30) | 0) % 7 === 0) {
        ctx.strokeStyle = 'rgba(192,192,192,0.12)';
        for (var gx = 0; gx < vw; gx += 44) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, vh); ctx.stroke(); }
        for (var gy = 0; gy < vh; gy += 44) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(vw, gy); ctx.stroke(); }
      }

      // the boot log, typing on in hard lines
      ctx.font = '10px ' + MONO; ctx.textAlign = 'left';
      for (var li = 0; li < LOG.length; li++) {
        if (t < LOG[li][0] + 0.05) break;
        ctx.fillStyle = 'rgba(192,192,192,' + (li >= LOG.length - 3 ? 0.95 : 0.45) + ')';
        ctx.fillText(LOG[li][0].toFixed(2) + '  ' + LOG[li][1], m + 4, m + 48 + li * 15);
      }

      // the number, typed on as a readout, struck through once it's bound
      if (text && t >= 0.2) {
        var nch = built(t, 0.2, 0.7, text.length);
        ctx.font = '11px ' + MONO; ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(192,192,192,0.9)';
        ctx.fillText(text.slice(0, nch), vw - m - 4, m + 48);
        if (t > 1.1) {
          var tw = ctx.measureText(text).width;
          ctx.fillStyle = 'rgba(192,192,192,0.5)';
          ctx.fillRect(vw - m - 4 - tw, m + 44, tw, 1);
        }
      }

      // hex iris: assembles side by side, then dilates in counted steps
      if (t >= 0.7) {
        var sides = built(t, 0.7, 1.1, 6);
        ctx.strokeStyle = 'rgba(192,192,192,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var s = 0; s < sides; s++) {
          var a0 = -Math.PI / 2 + s / 6 * Math.PI * 2, a1 = a0 + Math.PI * 2 / 6;
          ctx.moveTo(CX + Math.cos(a0) * R0, CY + Math.sin(a0) * R0);
          ctx.lineTo(CX + Math.cos(a1) * R0, CY + Math.sin(a1) * R0);
        }
        ctx.stroke();
        var steps = built(t, 1.3, 2.3, 4);
        for (var k = 1; k <= steps; k++) {
          ctx.strokeStyle = 'rgba(192,192,192,' + (0.7 - k * 0.12) + ')';
          hexPath(R0 * (1 - k * 0.18), -Math.PI / 2 + k * 0.1);
          ctx.stroke();
        }
        if (steps >= 2) {                          // the void shows through
          ctx.fillStyle = '#161616';
          hexPath(R0 * (1 - steps * 0.18), -Math.PI / 2 + steps * 0.1);
          ctx.fill();
        }
        if (steps >= 1 && steps < 4) {             // one holo seam — the only color
          var ha = -Math.PI / 2 + steps * 0.1;
          var hr = R0 * (1 - steps * 0.18);
          ctx.strokeStyle = holoCss(0.5 + 0.5 * Math.sin(t * 3), 0.5, t, 0.8);
          ctx.beginPath();
          ctx.moveTo(CX + Math.cos(ha) * hr, CY + Math.sin(ha) * hr);
          ctx.lineTo(CX + Math.cos(ha + 1.047) * hr, CY + Math.sin(ha + 1.047) * hr);
          ctx.stroke();
        }
      }

      // commit: two frames of inversion, Eva's alarm cut
      var fk = snapT(t - 2.5, 24);
      if (t >= 2.5 && fk < 3 / 24 && (fk * 24 | 0) % 2 === 0) {
        ctx.fillStyle = '#c0c0c0'; ctx.fillRect(0, 0, vw, vh);
        ctx.fillStyle = '#232323';
        ctx.beginPath(); ctx.arc(CX, CY, R0 * 0.8, 0, 7); ctx.fill();
      }

      // swallow: the throat expands past the frame in hard steps
      if (t >= 2.62) {
        var sk = built(t, 2.62, 3.2, 7);
        ctx.fillStyle = '#161616';
        ctx.beginPath();
        ctx.arc(CX, CY, R0 * 0.8 + (sk / 7) * Math.hypot(vw, vh) * 0.8, 0, 7);
        ctx.fill();
      }

      // scanline texture over everything
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      for (var sy2 = 0; sy2 < vh; sy2 += 3) ctx.fillRect(0, sy2, vw, 1);

      requestAnimationFrame(frame);
    }

    // The landing: onDone builds the lobby panel and hands it back, and the
    // whole tunnel collapses into it — you arrive inside the small thing.
    function finish() {
      if (done) return;
      done = true;
      var panel = onDone ? onDone() : null;
      if (panel && panel.getBoundingClientRect && !reduced) {
        var r = panel.getBoundingClientRect();
        var s = Math.max(0.08, r.width / vw);
        cv.style.transformOrigin = '0 0';
        cv.style.transition = 'transform 560ms cubic-bezier(0.5, 0, 0.2, 1), opacity 560ms ease';
        var tx = r.left + r.width / 2 - (vw / 2) * s;
        var ty = r.top + r.height / 2 - (vh / 2) * s;
        cv.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
        cv.style.opacity = '0';
        setTimeout(function () { cv.remove(); }, 620);
      } else {
        cv.style.transition = 'opacity 500ms ease';
        cv.style.opacity = '0';
        setTimeout(function () { cv.remove(); }, 550);
      }
    }

    requestAnimationFrame(frame);
    // rAF stalls in hidden tabs — if someone backgrounds mid-beam, land them
    // anyway so the lobby is there when they come back
    setTimeout(finish, DUR + 500);
    return { cancel: finish };
  }

  /* ==================================================== lobby ==== */
  //
  // A small fixed panel, bottom-left — the mesh stays the page. Fixed 24x14
  // tile world at 10px per tile internally (240x140), scaled by CSS with
  // pixelated rendering, exactly like the approved mock.

  function createLobby(opts) {
    opts = opts || {};
    var reduced = !!opts.reduced;
    var streamUrl = opts.stream || '/api/lobby/stream';
    var W = 24, H = 14, S = 10;
    var PAD = { x: 12.5, y: 8.5 };
    var RENDER_CAP = 150;             // bodies drawn; the counter is always true

    // ---- the floor plan: a main hall with two side rooms off it, carved
    // into a tile mask so nothing has to be an exact box
    var FLOOR = new Uint8Array(W * H);
    function carve(x0, y0, x1, y1) {
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) FLOOR[y * W + x] = 1;
    }
    carve(5, 3, 20, 13);    // main hall
    carve(1, 6, 4, 12);     // left room
    carve(2, 5, 4, 6);      //   its top notch
    carve(4, 8, 5, 10);     //   doorway
    carve(21, 4, 23, 9);    // right room
    carve(21, 9, 22, 11);   //   its lower leg
    carve(20, 5, 21, 7);    //   doorway

    var floorTiles = [];
    for (var fy = 0; fy < H; fy++) for (var fx = 0; fx < W; fx++)
      if (FLOOR[fy * W + fx]) floorTiles.push({ x: fx + 0.5, y: fy + 0.5 });
    function anyTile(filter) {
      var t, guard = 0;
      do { t = floorTiles[(Math.random() * floorTiles.length) | 0]; } while (filter && !filter(t) && ++guard < 40);
      return t;
    }

    function walkable(x, y) {
      var gx = x | 0, gy = y | 0;
      if (x < 0 || gx >= W || y < 0 || gy >= H) return false;
      return !!FLOOR[gy * W + gx];
    }
    function canStand(x, y) {
      return walkable(x - 0.25, y) && walkable(x + 0.25, y) &&
             walkable(x, y - 0.2) && walkable(x, y + 0.15);
    }

    // rooms + doorways: two-leg waypoint routing instead of pathfinding
    var DOOR_L = { x: 4.5, y: 9 }, DOOR_R = { x: 20.5, y: 6 };
    function roomOf(x) { var gx = x | 0; return gx <= 3 ? 1 : gx >= 21 ? 2 : 0; }
    function routeTo(c, tx, ty) {
      c.tx = tx; c.ty = ty; c.wp = [];
      var a = roomOf(c.x), b = roomOf(tx);
      if (a === b) return;
      if (a === 1 || b === 1) c.wp.push(DOOR_L);
      if (a === 2 || b === 2) c.wp.push(DOOR_R);
      if (a === 2) c.wp.reverse();   // leaving the right room, its door comes first
    }

    // ---- dom: a small centered window, the countdown hanging under it —
    // the blurred mesh plays on behind both
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;' +
      'display:flex;flex-direction:column;align-items:center;gap:11px;' +
      'opacity:0;transition:opacity 700ms ease;';
    document.body.appendChild(wrap);

    // coordinates above the map: quiet telemetry that scrambles every so
    // often and settles left-to-right into new readings
    var coords = document.createElement('div');
    coords.style.cssText = 'font:9px/1 ' + MONO + ';letter-spacing:0.18em;color:#ffffff;' +
      'font-variant-numeric:tabular-nums;user-select:none;white-space:pre;';
    wrap.appendChild(coords);

    var panel = document.createElement('div');
    panel.style.cssText = 'position:relative;' +
      'width:min(400px, 86vw);aspect-ratio:12/7;border-radius:16px;overflow:hidden;' +
      'border:1px solid rgba(255,255,255,0.13);background:#1c1c1c;' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,0.1), 0 26px 64px rgba(0,0,0,0.5);' +
      'touch-action:none;user-select:none;-webkit-user-select:none;';
    wrap.appendChild(panel);

    // months and days, the ticking clock stacked beneath — the colon blinks
    // once a second. Crisp DOM text in the site's own mono, not canvas.
    var timer = document.createElement('div');
    timer.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;user-select:none;';
    var timerDate = document.createElement('div');
    timerDate.style.cssText = 'font:10px/1 ' + MONO + ';letter-spacing:0.22em;color:#ffffff;' +
      'font-variant-numeric:tabular-nums;';
    var timerClock = document.createElement('div');
    timerClock.style.cssText = 'font:700 13px/1 ' + MONO + ';letter-spacing:0.2em;color:#ffffff;' +
      'font-variant-numeric:tabular-nums;';
    timer.appendChild(timerDate);
    timer.appendChild(timerClock);
    // the timer sits centered in a full-width row so the thumb buttons can
    // hang off its right edge on touch screens
    var bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'position:relative;width:100%;display:flex;justify-content:center;';
    bottomRow.appendChild(timer);
    wrap.appendChild(bottomRow);

    var cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;' +
      'image-rendering:pixelated;image-rendering:crisp-edges;';
    panel.appendChild(cv);
    var ctx = cv.getContext('2d');

    var plate = document.createElement('div');
    plate.style.cssText = 'position:absolute;top:7px;left:7px;' +
      'font:9px/1 ' + MONO + ';letter-spacing:0.18em;color:#d0d0d0;' +
      'background:#2a2a2a;border:1px solid #454545;border-radius:2px;' +
      'padding:5px 7px 4px;box-shadow:1px 1px 0 rgba(0,0,0,0.45);pointer-events:none;';
    plate.textContent = '— aboard';
    panel.appendChild(plate);

    // the records spin on a crisp overlay so their circles stay smooth while
    // the room underneath keeps its hard pixels
    var fx = document.createElement('canvas');
    fx.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    panel.insertBefore(fx, plate);
    var fctx = fx.getContext('2d');
    var fscale = 1, fxDpr = 0;
    function sizeFx() {
      var fr = panel.getBoundingClientRect();
      if (!fr.width) { requestAnimationFrame(sizeFx); return; }
      fxDpr = Math.min(devicePixelRatio || 1, 2);
      fx.width = fr.width * fxDpr; fx.height = fr.height * fxDpr;
      fctx.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
      fscale = fr.width / (W * S);       // world-pixel → css-pixel
    }
    sizeFx();
    addEventListener('resize', sizeFx);

    // on touch screens the verbs live on two game-boy buttons beside the
    // timer — A fires or takes, B hugs or dances, both together drop — and
    // the map itself stays a pure walking surface
    function gbBtn(letter) {
      var b = document.createElement('div');
      b.style.cssText = 'position:relative;width:38px;height:38px;border-radius:50%;' +
        'background:#2a2a2a;border:1px solid #454545;box-shadow:1px 1px 0 rgba(0,0,0,0.45);' +
        'color:#d0d0d0;font:700 12px/36px ' + MONO + ';text-align:center;' +
        'cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;';
      b.textContent = letter;
      var lab = document.createElement('div');
      lab.style.cssText = 'position:absolute;top:100%;left:50%;transform:translateX(-50%);' +
        'margin-top:4px;font:8px/1 ' + MONO + ';letter-spacing:0.16em;color:#6e6e6e;white-space:nowrap;';
      b.appendChild(lab);
      b._lab = lab;
      return b;
    }
    var abRow = document.createElement('div');
    abRow.style.cssText = 'position:absolute;right:4px;top:50%;transform:translateY(-58%);' +
      'display:none;gap:7px;align-items:flex-start;';
    var btnB = gbBtn('B'), btnA = gbBtn('A');
    btnB.style.marginTop = '12px';           // the game-boy diagonal
    abRow.appendChild(btnB);
    abRow.appendChild(btnA);
    bottomRow.appendChild(abRow);
    var aDown = false, bDown = false;
    btnA.addEventListener('pointerdown', function (e) {
      e.preventDefault(); aDown = true;
      if (bDown && you.gun) { tryDrop(); cHeld = false; return; }
      tryGun(); cHeld = true;                // holding A streams the fog gun
      if (navigator.vibrate) navigator.vibrate(8);
    });
    btnB.addEventListener('pointerdown', function (e) {
      e.preventDefault(); bDown = true;
      if (aDown && you.gun) { tryDrop(); cHeld = false; return; }
      if (nearestStranger(1.4)) tryHug(); else tryDance();
      if (navigator.vibrate) navigator.vibrate(4);
    });
    addEventListener('pointerup', function () { aDown = false; bDown = false; });

    // the action nudge — crisp DOM text floated over the map, never canvas
    var tipEl = document.createElement('div');
    tipEl.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;text-align:center;' +
      'font:9px/1.7 ' + MONO + ';letter-spacing:0.14em;color:rgba(212,212,212,0.92);' +
      'text-shadow:0 1px 3px rgba(0,0,0,0.9);transform:translate(-50%,-100%);' +
      'opacity:0;transition:opacity 160ms ease;pointer-events:none;';
    panel.appendChild(tipEl);
    // each action nudge flashes once, the first time it's in reach, then
    // trusts you know — never again this visit
    var tipSeen = {}, tipFlashT = 0, tipFlashKind = null;

    // ---- population
    var SHADES = ['#8a8a8a', '#9a9a9a', '#aaaaaa', '#7c7c7c', '#b4b4b4'];
    function makeChar(x, y, isYou) {
      return {
        x: x, y: y, tx: x, ty: y, wp: [], you: !!isYou,
        shade: SHADES[(Math.random() * SHADES.length) | 0],
        pause: rand(0.5, 3), speed: rand(1.1, 1.9),
        moving: false, face: 1,
        busy: 0, hugWith: null, gun: null, hop: 0, noticeCd: 0,
        dance: 0, jamT: rand(3, 12),
        seekGun: false, fireT: 0, dropT: 0,
      };
    }

    var chars = [];
    var you = makeChar(PAD.x, PAD.y, true);
    chars.push(you);

    var count = Math.max(1, opts.count | 0);
    var floats = [], glints = [];

    // ---- hugs and muskets
    var hearts = [], confetti = [];
    var hugCd = 0, flash = 0;
    var HUG_T = 1.2;
    var touch = matchMedia('(pointer: coarse)').matches;
    var gunHintT = 0;                  // "c fire" nudge, shown briefly after a pickup
    var npcHugT = rand(6, 12);         // strangers hug each other too, now and then
    var HEART = [[1,0],[3,0],[0,1],[1,1],[2,1],[3,1],[4,1],[1,2],[2,2],[3,2],[2,3]];

    var floorGuns = [];                // guns dropped with Z, lying where they fell
    var bubbles = [], fogs = [];       // what the new guns shoot
    var cHeld = false, fogAcc = 0;     // held trigger streams the fog machine

    // the armory hangs on the side-room walls; C (or a tap) takes one down.
    // one musket and one bubble gun on the left, musket and fog gun right.
    var RACKS = [
      { x: 1.55,  y: 7.5, side: 1,  type: 'confetti', taken: false },
      { x: 1.55,  y: 9.5, side: 1,  type: 'bubble',   taken: false },
      { x: 22.45, y: 5.5, side: -1, type: 'confetti', taken: false },
      { x: 22.45, y: 7.5, side: -1, type: 'fog',      taken: false },
    ];

    function npcArmed() {
      var n = 0;
      for (var i = 1; i < chars.length; i++) if (chars[i].gun) n++;
      return n;
    }

    function nearestStranger(maxD) {
      var best = null, bd = maxD;
      for (var i = 1; i < chars.length; i++) {
        var c = chars[i];
        if (c.busy > 0) continue;
        var d = Math.hypot(c.x - you.x, c.y - you.y);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    function tryHug() {
      if (you.busy > 0 || hugCd > 0) return;
      var c = nearestStranger(1.4);
      if (!c) return;
      you.busy = c.busy = HUG_T; hugCd = HUG_T + 0.4;
      you.face = c.x > you.x ? 1 : -1; c.face = -you.face;
      you.tx = you.x; you.ty = you.y; you.wp = [];
      you.hugWith = c; c.hugWith = you;
      c.pause = 2.5;
      hearts.push({ x: (you.x + c.x) / 2, y: Math.min(you.y, c.y) - 1.1, t: 0 });
    }

    function tryDrop() {
      if (!you.gun || you.busy > 0) return;
      var gx = you.x + you.face * 0.5, gy = you.y + 0.15;
      if (!walkable(gx, gy)) { gx = you.x; gy = you.y; }
      floorGuns.push({ x: gx, y: gy, type: you.gun });
      you.gun = null; gunHintT = 0;
    }

    function tryDance() {
      if (you.busy > 0) return;
      you.dance = 1.8;
      you.tx = you.x; you.ty = you.y; you.wp = [];   // feet planted
    }

    function tryGun() {
      if (you.busy > 0) return;
      if (!you.gun) {
        for (var g3 = 0; g3 < floorGuns.length; g3++) {         // off the floor first
          var fg = floorGuns[g3];
          if (Math.hypot(fg.x - you.x, fg.y - you.y) < 1.4) {
            you.gun = fg.type; floorGuns.splice(g3, 1); gunHintT = 5;
            return;
          }
        }
        for (var i = 0; i < RACKS.length; i++) {
          var r = RACKS[i];
          if (!r.taken && Math.hypot(r.x - you.x, r.y - you.y) < 1.8) {
            r.taken = true; you.gun = r.type; gunHintT = 5;
            return;
          }
        }
        return;             // nothing on the wall near you, nothing in hand
      }
      gunHintT = 0;
      fireGun(you);
    }

    // anyone holding a gun fires it the same way — you or a stranger
    function fireGun(sh) {
      if (sh.gun === 'bubble') { fireBubbles(sh); return; }
      if (sh.gun === 'fog') { fireFog(sh); return; }
      if (sh.you) flash = 0.07;
      var dir = sh.face;
      var mx = sh.x + dir * 0.7, my = sh.y - 0.45;
      for (var p = 0; p < 24; p++) {
        var a = rand(-0.75, 0.15);                 // mostly upward, out of the muzzle
        var sp = rand(3.5, 9);
        confetti.push({
          x: mx, y: my,
          vx: dir * Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          t: 0, life: rand(0.8, 1.5),
          ph: rand(0, 6.28),      // each fleck rides the diffraction field at its own phase
        });
      }
      var bx2 = sh.x - dir * 0.18;                 // recoil
      if (canStand(bx2, sh.y)) sh.x = bx2;
      // everyone nearby turns to look, and hops — except the shooter, and
      // except you: your facing is yours
      for (var w = 0; w < chars.length; w++) {
        var wc = chars[w];
        if (wc === sh || wc.you) continue;
        if (Math.hypot(wc.x - sh.x, wc.y - sh.y) < 3.2) {
          wc.face = sh.x >= wc.x ? 1 : -1;
          if (!reduced) wc.hop = 0.5;
        }
      }
    }

    // one 10px sprite per gun type — barrel long, nose round, tank chunky
    function drawGunSprite(x, y, type, dir) {
      if (type === 'bubble') {
        ctx.fillStyle = '#8a8a8a'; ctx.fillRect(x + (dir > 0 ? 2 : 3), y, 5, 2);
        ctx.fillStyle = '#c8c8c8'; ctx.fillRect(dir > 0 ? x + 7 : x + 1, y, 2, 2);        // round nose
        ctx.fillStyle = '#565656'; ctx.fillRect(dir > 0 ? x + 3 : x + 6, y + 2, 1, 2);    // grip
      } else if (type === 'fog') {
        ctx.fillStyle = '#6a6a6a'; ctx.fillRect(x + (dir > 0 ? 1 : 3), y - 1, 6, 3);      // tank
        ctx.fillStyle = '#9a9a9a';
        ctx.fillRect(dir > 0 ? x + 7 : x, y - 1, 3, 1);                                    // flared nozzle
        ctx.fillRect(dir > 0 ? x + 7 : x, y + 1, 3, 1);
        ctx.fillStyle = '#565656'; ctx.fillRect(dir > 0 ? x + 3 : x + 6, y + 2, 1, 2);
      } else {
        ctx.fillStyle = '#9a9a9a'; ctx.fillRect(x, y, 10, 1);                              // barrel
        ctx.fillStyle = '#565656'; ctx.fillRect(dir > 0 ? x : x + 7, y + 1, 3, 2);         // stock
      }
    }

    // the bubble gun: a few distinct bubbles, leaving the nose one by one so
    // each gets its own air
    function fireBubbles(sh) {
      var dir = sh.face;
      var mx = sh.x + dir * 0.7, my = sh.y - 0.5;
      for (var i = 0; i < 5; i++) {
        bubbles.push({
          x: mx, y: my,
          vx: dir * rand(0.4, 1.7), vy: -rand(0.25, 1.0),
          r: rand(0.12, 0.32), grow: rand(0.02, 0.07),
          wob: rand(2, 5), ph: rand(0, 6.28),
          t: -i * 0.16, life: rand(1.4, 3.2),
        });
      }
    }

    // the smoke gun: club haze with real machine physics — each puff leaves
    // the nozzle as a fast jet, dissipates, billows as it slows, and climbs
    // gently the way warm fog does. Hold the trigger and it streams.
    function emitFogPuff(sh) {
      var dir = sh.face;
      fogs.push({
        x: sh.x + dir * 0.8 + rand(-0.1, 0.1), y: sh.y - 0.4 + rand(-0.12, 0.12),
        vx: dir * rand(2.2, 4.2),
        vy: rand(-0.25, 0.05),
        r: rand(0.18, 0.32), grow: rand(0.35, 0.6),
        t: 0, life: rand(2.6, 4.6),
        seed: rand(0, 1000), wob: rand(1.5, 3.5),
      });
      while (fogs.length > 60) fogs.shift();   // the room only holds so much haze
    }
    function fireFog(sh) {
      for (var i = 0; i < 5; i++) emitFogPuff(sh);
    }

    // a 1px ring, plotted the old way (midpoint circle) — no anti-aliasing
    function pixelRing(cx, cy, r, style) {
      ctx.fillStyle = style;
      var x = r, y = 0, err = 1 - r;
      while (x >= y) {
        ctx.fillRect(cx + x, cy + y, 1, 1); ctx.fillRect(cx - x, cy + y, 1, 1);
        ctx.fillRect(cx + x, cy - y, 1, 1); ctx.fillRect(cx - x, cy - y, 1, 1);
        ctx.fillRect(cx + y, cy + x, 1, 1); ctx.fillRect(cx - y, cy + x, 1, 1);
        ctx.fillRect(cx + y, cy - x, 1, 1); ctx.fillRect(cx - y, cy - x, 1, 1);
        y++;
        if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
      }
    }

    function syncCount(n, celebrate) {
      var prev = count;
      count = Math.max(1, n | 0);
      plate.textContent = count + ' aboard';
      while (chars.length < Math.min(count, RENDER_CAP)) {
        var t = anyTile();
        var x = t.x + rand(-0.15, 0.15), y = t.y + rand(-0.15, 0.15);
        var c = makeChar(x, y, false);
        c.pause = 1.4;
        chars.push(c);
        if (celebrate && count > prev) {
          floats.push({ x: x, y: y - 1.2, t: 0 });
        }
      }
    }
    syncCount(count, false);

    // ---- input: tap inside the map, or arrows/wasd anywhere
    var keys = {};
    function onKeyDown(e) {
      if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;  // the studio modal types here
      if (e.metaKey || e.ctrlKey || e.altKey) return;                   // keep copy/paste etc. intact
      var k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].indexOf(k) >= 0) {
        keys[k] = true; e.preventDefault();
      } else if (k === 'x') { tryHug(); e.preventDefault(); }
      else if (k === 'c') { if (!e.repeat) tryGun(); cHeld = true; e.preventDefault(); }
      else if (k === 'z') { tryDrop(); e.preventDefault(); }
      else if (k === 'v') { tryDance(); e.preventDefault(); }
    }
    function onKeyUp(e) {
      keys[e.key.toLowerCase()] = false;
      if (e.key.toLowerCase() === 'c') cHeld = false;
    }
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);

    function onPointerDown(e) {
      var r = panel.getBoundingClientRect();
      var tx = (e.clientX - r.left) / r.width * W;
      var ty = (e.clientY - r.top) / r.height * H;

      // with a mouse, clicks can do what X and C do: hug a neighbor, take a
      // musket, fire. On touch the A/B buttons own the verbs and the map is
      // purely for walking — no more mis-taps that stroll instead of shoot.
      if (!touch) {
        var s = nearestStranger(1.4);
        if (s && Math.hypot(s.x - tx, s.y - ty) < 0.9) { tryHug(); return; }
        if (!you.gun) {
          for (var ri = 0; ri < RACKS.length; ri++) {
            var rk = RACKS[ri];
            if (!rk.taken && Math.hypot(rk.x - tx, rk.y - ty) < 1 &&
                Math.hypot(rk.x - you.x, rk.y - you.y) < 1.8) { tryGun(); return; }
          }
        } else if (Math.hypot(you.x - tx, you.y - ty) < 1) {
          tryGun();
          if (you.gun === 'fog') cHeld = true;  // press-and-hold streams; pointerup releases
          return;
        }
        if (!you.gun && Math.hypot(you.x - tx, you.y - ty) < 1) { tryDance(); return; } // tap yourself: dance
      }

      if (!walkable(tx, ty)) {           // tapped a wall or the void → nearest floor
        var best = null, bd = 1e9;
        for (var i = 0; i < floorTiles.length; i++) {
          var ft = floorTiles[i], dd = (ft.x - tx) * (ft.x - tx) + (ft.y - ty) * (ft.y - ty);
          if (dd < bd) { bd = dd; best = ft; }
        }
        tx = best.x; ty = best.y;
      }
      routeTo(you, tx, ty);
    }
    panel.addEventListener('pointerdown', onPointerDown);
    function onPointerUp() { cHeld = false; }
    addEventListener('pointerup', onPointerUp);

    // ---- live joins
    var es = null;
    if ('EventSource' in window) {
      es = new EventSource(streamUrl);
      es.onmessage = function (ev) {
        try {
          var n = JSON.parse(ev.data).count;
          if (typeof n === 'number') syncCount(n, true);
        } catch { /* ignore a torn frame */ }
      };
    }

    // ---- coordinates: current reading, scramble window, next-scramble timer
    function makeCoords() {
      return rand(0, 90).toFixed(4) + '°' + (Math.random() < 0.5 ? 'N' : 'S') +
        '  ' + rand(0, 180).toFixed(4) + '°' + (Math.random() < 0.5 ? 'E' : 'W');
    }
    var coordTarget = makeCoords(), coordScramT = 0, coordNextT = rand(4, 9);
    coords.textContent = coordTarget;

    // ---- sim + draw
    var glintTimer = rand(8, 20);
    var simT = 0, last = performance.now(), raf = 0, alive = true;

    // time until the 13th of november, whichever one is next: whole calendar
    // months, then days, then the hh:mm:ss remainder
    var lastSec = 0;
    function two(n) { return n < 10 ? '0' + n : '' + n; }
    // the activation-clock style: hh:mm:ss:cc with the centiseconds racing.
    // The calendar math runs once in a while; the racing display just counts
    // real milliseconds down from that anchor, every frame.
    var cdMonths = 0, cdRemMs = 0, cdRemAt = 0;
    function recalcCal() {
      var now = new Date();
      var target = new Date(now.getFullYear(), 10, 13);
      if (target <= now) target = new Date(now.getFullYear() + 1, 10, 13);
      var months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
      var probe = new Date(now.getFullYear(), now.getMonth() + months, now.getDate(),
                           now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      if (probe > target) {
        months--;
        probe = new Date(now.getFullYear(), now.getMonth() + months, now.getDate(),
                         now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      }
      cdMonths = months;
      cdRemMs = Math.max(0, target - probe);
      cdRemAt = performance.now();
    }
    function tickTimer() {
      var rem = Math.max(0, cdRemMs - (performance.now() - cdRemAt));
      var days = (rem / 86400000) | 0;
      rem -= days * 86400000;
      var hh = (rem / 3600000) | 0, mm = ((rem / 60000) | 0) % 60, ss = ((rem / 1000) | 0) % 60;
      var cc = ((rem / 10) | 0) % 100;
      timerDate.textContent = cdMonths + ' mo ' + days + ' d';
      timerClock.textContent = two(hh) + ':' + two(mm) + ':' + two(ss) + ':' + two(cc);
    }

    // walk toward the current waypoint (or the target), sliding along walls;
    // returns false once fully arrived
    function stepMove(c, dt, speed) {
      var t = c.wp.length ? c.wp[0] : null;
      var tx = t ? t.x : c.tx, ty = t ? t.y : c.ty;
      var dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
      if (d < 0.12) {
        if (t) { c.wp.shift(); return true; }
        c.moving = false; return false;
      }
      var nx = c.x + dx / d * speed * dt, ny = c.y + dy / d * speed * dt;
      if (canStand(nx, c.y)) c.x = nx;
      if (canStand(c.x, ny)) c.y = ny;
      c.moving = true; if (Math.abs(dx) > 0.02) c.face = dx > 0 ? 1 : -1;
      return true;
    }

    function step(dt) {
      simT += dt;
      if (hugCd > 0) hugCd -= dt;
      if (flash > 0) flash -= dt;

      var vx = 0, vy = 0;
      if (keys['arrowleft'] || keys['a']) vx -= 1;
      if (keys['arrowright'] || keys['d']) vx += 1;
      if (keys['arrowup'] || keys['w']) vy -= 1;
      if (keys['arrowdown'] || keys['s']) vy += 1;
      // your dance: feet planted, face flipping to the beat — and it's
      // contagious: anyone within arm's reach joins in
      if (you.dance > 0) {
        you.dance -= dt;
        you.face = ((simT * 6) | 0) % 2 ? 1 : -1;
        if (vx || vy) you.dance = 0;               // moving breaks the move
        for (var dn = 1; dn < chars.length; dn++) {
          var dc = chars[dn];
          if (dc.busy > 0 || dc.dance > 0) continue;
          if (Math.hypot(dc.x - you.x, dc.y - you.y) < 2.2) {
            dc.dance = rand(1, 1.8);
            dc.pause = Math.max(dc.pause, dc.dance);
          }
        }
      }
      if (you.busy > 0) {
        you.busy -= dt; you.moving = false;
        if (you.busy <= 0) you.hugWith = null;
      } else if (vx || vy) {
        var n = Math.max(1, Math.hypot(vx, vy));
        var nx = you.x + vx / n * 4.4 * dt, ny = you.y + vy / n * 4.4 * dt;
        if (canStand(nx, you.y)) you.x = nx;
        if (canStand(you.x, ny)) you.y = ny;
        you.tx = you.x; you.ty = you.y; you.wp = [];
        you.moving = true; if (vx) you.face = vx > 0 ? 1 : -1;
      } else {
        stepMove(you, dt, 4.4);
      }

      for (var i = 1; i < chars.length; i++) {
        var c = chars[i];
        if (c.hop > 0) c.hop -= dt;
        if (c.noticeCd > 0) c.noticeCd -= dt;
        if (c.jamT > 0) c.jamT -= dt;
        if (c.dance > 0) {
          c.dance -= dt;
          c.face = ((simT * 6) | 0) % 2 ? 1 : -1;   // flips to the beat
        }
        // an armed stranger plays with the thing, then sets it down for the
        // next person
        if (c.gun) {
          c.fireT -= dt;
          if (c.fireT <= 0 && c.busy <= 0) { fireGun(c); c.fireT = rand(2.5, 6); }
          c.dropT -= dt;
          if (c.dropT <= 0) {
            var dgx = c.x + c.face * 0.5, dgy = c.y + 0.15;
            if (!walkable(dgx, dgy)) { dgx = c.x; dgy = c.y; }
            floorGuns.push({ x: dgx, y: dgy, type: c.gun });
            c.gun = null;
          }
        }
        if (c.busy > 0) {
          c.busy -= dt; c.moving = false;
          if (c.busy <= 0) c.hugWith = null;
          continue;
        }
        if (c.pause > 0) {
          c.pause -= dt; c.moving = false;
          // idle strangers notice you when you're close
          if (c.dance <= 0 && Math.hypot(you.x - c.x, you.y - c.y) < 2.2) c.face = you.x >= c.x ? 1 : -1;
          // and now and then one jumps, or hits a little dance
          if (!reduced && c.jamT <= 0 && c.pause > 1.2) {
            if (Math.random() < 0.5) c.hop = 0.5;
            else c.dance = 1.1;
            c.jamT = rand(8, 18);
          }
          continue;
        }
        // a stranger walking past stops for a beat when you come close,
        // the way a person does — then carries on and won't re-startle soon
        if (c.noticeCd <= 0 && Math.hypot(you.x - c.x, you.y - c.y) < 1.9) {
          c.pause = rand(0.7, 1.4);
          c.face = you.x >= c.x ? 1 : -1;
          c.noticeCd = rand(6, 12);
          c.moving = false;
          continue;
        }
        if (!stepMove(c, dt, c.speed)) {
          if (c.seekGun) {                         // arrived where a gun was lying
            c.seekGun = false;
            for (var fgi = 0; fgi < floorGuns.length; fgi++) {
              var fgc = floorGuns[fgi];
              if (Math.hypot(fgc.x - c.x, fgc.y - c.y) < 1.3) {
                c.gun = fgc.type; floorGuns.splice(fgi, 1);
                c.fireT = rand(0.8, 2.5); c.dropT = rand(14, 30);
                break;
              }
            }
          }
          c.pause = rand(1.5, 6);
          var roll = Math.random(), t;
          if (!c.gun && floorGuns.length && npcArmed() < 2 && roll < 0.2) {
            var fgt = floorGuns[(Math.random() * floorGuns.length) | 0];
            t = { x: fgt.x, y: fgt.y };            // curiosity: go see the thing
            c.seekGun = true;
            c.pause = rand(0.3, 1);
          } else if (roll < 0.15) {                // sometimes they come say hi
            var gx2 = you.x + rand(-1.2, 1.2), gy2 = you.y + rand(-1, 1);
            t = walkable(gx2, gy2) ? { x: gx2, y: gy2 } : anyTile();
          } else if (roll < 0.4) {                 // or drift to the consoles
            t = anyTile(function (q) { return q.y < 4.5 && roomOf(q.x) === 0; });
          } else {
            t = anyTile();
          }
          routeTo(c, t.x, t.y);
        }
      }

      // strangers hug each other too, when two idle near enough
      npcHugT -= dt;
      if (npcHugT <= 0) {
        npcHugT = rand(9, 18);
        outer: for (var a2 = 1; a2 < chars.length; a2++) {
          var ca = chars[a2];
          if (ca.busy > 0) continue;
          for (var b2 = a2 + 1; b2 < chars.length; b2++) {
            var cb = chars[b2];
            if (cb.busy > 0) continue;
            if (Math.hypot(ca.x - cb.x, ca.y - cb.y) < 1.5) {
              ca.busy = cb.busy = HUG_T;
              ca.face = cb.x > ca.x ? 1 : -1; cb.face = -ca.face;
              ca.hugWith = cb; cb.hugWith = ca;
              ca.pause = cb.pause = 2;
              hearts.push({ x: (ca.x + cb.x) / 2, y: Math.min(ca.y, cb.y) - 1.1, t: 0 });
              break outer;
            }
          }
        }
      }
      if (gunHintT > 0) gunHintT -= dt;
      if (tipFlashT > 0) tipFlashT -= dt;

      // the coordinates scramble every so often, digits settling left to right
      coordNextT -= dt;
      if (coordNextT <= 0) { coordNextT = rand(6, 14); coordScramT = 0.9; coordTarget = makeCoords(); }
      if (coordScramT > 0) {
        coordScramT -= dt;
        var prog = 1 - coordScramT / 0.9;
        var out = '';
        for (var cq = 0; cq < coordTarget.length; cq++) {
          var chc = coordTarget[cq];
          if (chc >= '0' && chc <= '9' && cq > prog * coordTarget.length) out += (Math.random() * 10) | 0;
          else out += chc;
        }
        coords.textContent = coordScramT <= 0 ? coordTarget : out;
      }

      glintTimer -= dt;
      if (glintTimer <= 0) {
        glintTimer = rand(8, 20);
        var gt = anyTile();
        glints.push({ x: gt.x, y: gt.y, t: 0 });
      }
      var j;
      for (j = floats.length - 1; j >= 0; j--) { floats[j].t += dt; if (floats[j].t > 1.4) floats.splice(j, 1); }
      for (j = glints.length - 1; j >= 0; j--) { glints[j].t += dt; if (glints[j].t > 0.7) glints.splice(j, 1); }
      for (j = hearts.length - 1; j >= 0; j--) { hearts[j].t += dt; if (hearts[j].t > 1.2) hearts.splice(j, 1); }
      for (j = confetti.length - 1; j >= 0; j--) {
        var p = confetti[j];
        p.t += dt;
        if (p.t > p.life) { confetti.splice(j, 1); continue; }
        p.vy += 10 * dt;                 // gravity
        p.vx *= (1 - 1.6 * dt);          // drag
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      for (j = bubbles.length - 1; j >= 0; j--) {
        var bb = bubbles[j];
        bb.t += dt;
        if (bb.t < 0) continue;                  // still queued in the nozzle
        if (bb.t > bb.life) { bubbles.splice(j, 1); continue; }
        bb.vx *= (1 - 1.2 * dt);
        bb.x += (bb.vx + Math.sin(bb.t * bb.wob + bb.ph) * 0.4) * dt;
        bb.y += bb.vy * dt;
        bb.r += bb.grow * dt;
      }
      // the fog machine streams while the trigger is held
      if (cHeld && you.gun === 'fog' && you.busy <= 0) {
        fogAcc += dt * 16;
        while (fogAcc >= 1) { emitFogPuff(you); fogAcc--; }
      } else { fogAcc = 0; }
      for (j = fogs.length - 1; j >= 0; j--) {
        var fo = fogs[j];
        fo.t += dt;
        if (fo.t > fo.life) { fogs.splice(j, 1); continue; }
        fo.vx *= (1 - 2.4 * dt);                       // the jet dissipates fast
        fo.vy *= (1 - 1.2 * dt);
        fo.vy -= 0.10 * dt;                            // warm fog climbs, gently
        fo.vx += Math.sin(simT * fo.wob + fo.seed) * 0.5 * dt;   // billowing wander
        fo.x += fo.vx * dt; fo.y += fo.vy * dt;
        fo.grow *= (1 - 0.45 * dt);                    // expands fast, then holds
        fo.r += fo.grow * dt;
      }
    }

    function draw() {
      var iw = W * S, ih = H * S, gx, gy;
      ctx.fillStyle = '#0f0f0f'; ctx.fillRect(0, 0, iw, ih);   // the void, deeper than the floor

      // the carved floor, then a wall band wherever floor meets void
      ctx.fillStyle = '#202020';
      for (gy = 0; gy < H; gy++) for (gx = 0; gx < W; gx++)
        if (FLOOR[gy * W + gx]) ctx.fillRect(gx * S, gy * S, S, S);
      ctx.fillStyle = '#464646';
      for (gy = 0; gy < H; gy++) for (gx = 0; gx < W; gx++) {
        if (!FLOOR[gy * W + gx]) continue;
        var X = gx * S, Y = gy * S;
        if (!gy || !FLOOR[(gy - 1) * W + gx]) ctx.fillRect(X, Y - 2, S, 2);
        if (gy === H - 1 || !FLOOR[(gy + 1) * W + gx]) ctx.fillRect(X, Y + S, S, 2);
        if (!gx || !FLOOR[gy * W + gx - 1]) ctx.fillRect(X - 2, Y, 2, S);
        if (gx === W - 1 || !FLOOR[gy * W + gx + 1]) ctx.fillRect(X + S, Y, 2, S);
      }

      // three decks against the hall's top wall — the boxes and their beeping
      // dots stay pixel; the records themselves spin on the crisp overlay
      for (var u = 0; u < 3; u++) {
        var bx = 65 + u * 45;      // three decks, centred on the hall's top wall
        ctx.fillStyle = '#3a3a3a'; ctx.fillRect(bx, 9, 30, 19);
        ctx.fillStyle = ((simT * 2 + u) | 0) % 3
          ? holoCss(u / 3, 0.2, simT * 0.8 + u * 2.1, 0.95)
          : '#303030';
        ctx.fillRect(bx + 3, 22, 3, 3);
      }

      // guns dropped on the floor, waiting to be picked back up
      for (var fg2 = 0; fg2 < floorGuns.length; fg2++) {
        var fgd = floorGuns[fg2];
        var fgx = Math.round(fgd.x * S) - 5, fgy = Math.round(fgd.y * S);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(fgx, fgy + 1, 10, 1);
        drawGunSprite(fgx, fgy, fgd.type, 1);
      }

      // the armory on the side-room walls, waiting on its pegs
      for (var rr2 = 0; rr2 < RACKS.length; rr2++) {
        var rk = RACKS[rr2];
        if (rk.taken) continue;
        var rx = rk.side > 0 ? Math.round((rk.x - 0.45) * S) : Math.round((rk.x + 0.45) * S) - 10;
        var ry = Math.round(rk.y * S) - 5;
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(rx + 2, ry - 1, 1, 3); ctx.fillRect(rx + 7, ry - 1, 1, 3);   // pegs
        drawGunSprite(rx, ry, rk.type, rk.side);
      }

      // bodies, back to front
      var sorted = chars.slice().sort(function (a, b) { return a.y - b.y; });
      for (var i = 0; i < sorted.length; i++) {
        var c = sorted[i];
        var lean = 0;
        if (c.busy > 0 && c.hugWith) {   // hugging pairs lean into each other
          var hp = Math.min(1, (HUG_T - c.busy) / HUG_T);
          lean = Math.round(Math.sin(hp * Math.PI) * 2) * (c.hugWith.x >= c.x ? 1 : -1);
        }
        var x = Math.round(c.x * S) + lean, y = Math.round(c.y * S);
        if (c.dance > 0) x += Math.round(Math.sin(simT * 12) * 1.5);   // the shuffle
        var f = c.moving && !reduced ? ((simT * 7 + c.x * 3) | 0) % 2 : 0;
        ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x - 1, y, 3, 1);
        // a confetti blast makes the neighbors jump — the shadow stays put
        var yb = y - (c.hop > 0 ? Math.round(Math.sin((1 - c.hop / 0.5) * Math.PI) * 2) : 0);
        ctx.fillStyle = c.you ? '#ffffff' : c.shade;
        ctx.fillRect(x - 1, yb - 4, 2, 3);                      // body
        ctx.fillRect(x - 1, yb - 6, 2, 2);                      // head
        if (f) ctx.fillRect(x - 1 + (c.face > 0 ? 1 : -1), yb - 1, 1, 1);  // step
        // whatever anyone carries, drawn the same — you or a stranger
        if (c.gun === 'bubble') {
          ctx.fillStyle = '#8a8a8a'; ctx.fillRect(x + (c.face > 0 ? 1 : -4), yb - 4, 4, 1);
          ctx.fillStyle = '#c8c8c8'; ctx.fillRect(x + (c.face > 0 ? 5 : -6), yb - 5, 2, 2);
        } else if (c.gun === 'fog') {
          ctx.fillStyle = '#6a6a6a'; ctx.fillRect(x + (c.face > 0 ? 1 : -5), yb - 5, 4, 2);
          ctx.fillStyle = '#9a9a9a'; ctx.fillRect(x + (c.face > 0 ? 5 : -7), yb - 4, 2, 1);
        } else if (c.gun) {
          ctx.fillStyle = '#9a9a9a'; ctx.fillRect(x + (c.face > 0 ? 1 : -6), yb - 4, 6, 1);
          ctx.fillStyle = '#565656'; ctx.fillRect(x + (c.face > 0 ? 1 : -2), yb - 3, 2, 1);
        }
        if (c.you) {
          ctx.fillStyle = '#ffffff';
          if (!c.gun) ctx.fillRect(x + (c.face > 0 ? 2 : -3), yb - 4, 1, 1); // heading wedge
          if (((simT * 2) | 0) % 2 === 0) ctx.fillRect(x - 1, yb - 9, 2, 1);
          if (flash > 0 && c.gun) {                             // muzzle flash
            ctx.fillRect(x + (c.face > 0 ? 7 : -9), yb - 5, 2, 2);
          }
        }
      }

      // a nudge when an action is first in reach — flashes once per kind,
      // then never again this visit
      var tip = null;
      var ns = you.busy <= 0 && hugCd <= 0 ? nearestStranger(1.4) : null;
      if (ns) tip = { k: 'hug', x: ns.x, y: ns.y - 1.1, s: touch ? 'b · hug' : 'x · hug\nv · dance' };
      else if (!you.gun) {
        for (var tg = 0; tg < floorGuns.length && !tip; tg++) {
          var tfg = floorGuns[tg];
          if (Math.hypot(tfg.x - you.x, tfg.y - you.y) < 1.4)
            tip = { k: 'take', x: tfg.x, y: tfg.y - 0.9, s: (touch ? 'a' : 'c') + ' · take' };
        }
        for (var ti = 0; ti < RACKS.length && !tip; ti++) {
          var tr = RACKS[ti];
          if (!tr.taken && Math.hypot(tr.x - you.x, tr.y - you.y) < 1.8)
            tip = { k: 'take', x: tr.x + tr.side * 0.8, y: tr.y - 0.9, s: (touch ? 'a' : 'c') + ' · take' };
        }
      } else if (gunHintT > 0) {
        tip = { k: 'fire', x: you.x, y: you.y - 1.2, s: touch ? 'a · fire\na+b · drop' : 'c · fire\nz · drop' };
      }
      if (tip && !tipSeen[tip.k]) {
        tipSeen[tip.k] = true;                   // one flash, then it's yours
        tipFlashKind = tip.k; tipFlashT = 1.6;
      }
      if (tipFlashT > 0 && tip && tip.k === tipFlashKind) {
        tipEl.textContent = tip.s;
        tipEl.style.left = Math.max(9, Math.min(91, tip.x / W * 100)) + '%';
        tipEl.style.top = (tip.y / H * 100) + '%';
      }
      tipEl.style.opacity = tipFlashT > 0 ? '1' : '0';
      abRow.style.display = touch ? 'flex' : 'none';
      if (touch) {
        btnA._lab.textContent = you.gun ? 'fire' : 'take';
        btnB._lab.textContent = nearestStranger(1.4) ? 'hug' : 'dance';
      }

      // confetti — foil, not crayon: every fleck samples the same desaturated
      // diffraction field as the rest of the site, shimmering as it tumbles
      for (var pc = 0; pc < confetti.length; pc++) {
        var pp = confetti[pc];
        ctx.fillStyle = holoCss(pp.x / W, pp.y / H, simT * 2 + pp.ph, 1);
        ctx.globalAlpha = Math.min(1, (pp.life - pp.t) / 0.3);
        if (((pp.t * 16) | 0) % 2) ctx.fillRect((pp.x * S) | 0, (pp.y * S) | 0, 2, 1);
        else ctx.fillRect((pp.x * S) | 0, (pp.y * S) | 0, 1, 2);
      }
      ctx.globalAlpha = 1;

      // hearts, floating off the hugs
      for (var hh = 0; hh < hearts.length; hh++) {
        var hv = hearts[hh];
        var hxp = Math.round(hv.x * S) - 2, hyp = Math.round(hv.y * S - hv.t * 7);
        ctx.fillStyle = holoCss(hv.x / W, hv.y / H, simT, Math.max(0, 1 - hv.t / 1.2));
        for (var hq = 0; hq < HEART.length; hq++)
          ctx.fillRect(hxp + HEART[hq][0], hyp + HEART[hq][1], 1, 1);
      }

      // smoke: a checker-dithered haze — light, soft-edged, club air. Every
      // other pixel inside a squashed disc, thinning toward the rim.
      for (var f3 = 0; f3 < fogs.length; f3++) {
        var fo = fogs[f3];
        var fcx = (fo.x * S) | 0, fcy = (fo.y * S) | 0;
        var R = Math.max(2, (fo.r * S) | 0);
        var env = Math.sin(Math.min(1, fo.t / fo.life) * Math.PI);
        ctx.fillStyle = 'rgba(205,208,212,' + (0.30 * env).toFixed(3) + ')';
        var R2 = R * R;
        for (var py = -R; py <= R; py++) {
          for (var px = -R; px <= R; px++) {
            if ((px + py + fcx + fcy) & 1) continue;          // the dither
            var dd = px * px + py * py * 2;                   // squashed disc
            if (dd > R2) continue;
            if (dd > R2 * 0.45) {                             // rim thins out, stably per puff
              var hh = Math.sin(fo.seed + px * 12.9898 + py * 78.233) * 43758.5453;
              if ((hh - Math.floor(hh)) > env * 0.75) continue;
            }
            ctx.fillRect(fcx + px, fcy + py, 1, 1);
          }
        }
      }

      // bubbles: pixel rings, one film-glint pixel riding each — they pop
      // into four sparks at the end
      for (var b3 = 0; b3 < bubbles.length; b3++) {
        var bb = bubbles[b3];
        if (bb.t < 0) continue;                  // hasn't left the nozzle yet
        var bcx = Math.round(bb.x * S), bcy = Math.round(bb.y * S);
        var br = Math.max(1, Math.round(bb.r * S));
        if (bb.life - bb.t < 0.12) {                 // the pop
          ctx.fillStyle = 'rgba(220,220,220,0.9)';
          ctx.fillRect(bcx - br - 1, bcy, 1, 1); ctx.fillRect(bcx + br + 1, bcy, 1, 1);
          ctx.fillRect(bcx, bcy - br - 1, 1, 1); ctx.fillRect(bcx, bcy + br + 1, 1, 1);
          continue;
        }
        pixelRing(bcx, bcy, br, 'rgba(190,190,190,0.75)');
        var ia = bb.ph + simT * 2;
        ctx.fillStyle = holoCss(bb.ph / 6.28, 0.4, simT + bb.ph, 0.85);
        ctx.fillRect(bcx + Math.round(Math.cos(ia) * br), bcy + Math.round(Math.sin(ia) * br), 1, 1);
        if (br > 1) {                                // specular pixel
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fillRect(bcx - (br >> 1), bcy - (br >> 1) - 1, 1, 1);
        }
      }

      // holo, where it's allowed: the join "+1" and the rare glint
      for (var g = 0; g < glints.length; g++) {
        var gl = glints[g];
        ctx.fillStyle = holoCss(gl.x / W, gl.y / H, simT, (1 - gl.t / 0.7) * 0.9);
        ctx.fillRect((gl.x * S) | 0, (gl.y * S) | 0, 1, 1);
      }
      ctx.font = '7px ' + MONO; ctx.textAlign = 'center';
      for (var fl = 0; fl < floats.length; fl++) {
        var ff = floats[fl];
        ctx.fillStyle = holoCss(ff.x / W, ff.y / H, simT, 1 - ff.t);
        ctx.fillText('+1', ff.x * S, (ff.y - (reduced ? 0 : ff.t * 1.2)) * S);
      }
    }

    // the crisp layer: three records, anti-aliased, with the glint trail
    function drawRecords() {
      fctx.clearRect(0, 0, fx.width, fx.height);
      for (var u = 0; u < 3; u++) {
        var cx = (65 + u * 45 + 16) * fscale, cy = 18.5 * fscale;
        fctx.fillStyle = '#141414';
        fctx.beginPath(); fctx.arc(cx, cy, 6.5 * fscale, 0, 7); fctx.fill();      // the vinyl
        fctx.strokeStyle = '#2e2e2e'; fctx.lineWidth = Math.max(1, fscale * 0.8);
        fctx.beginPath(); fctx.arc(cx, cy, 4.5 * fscale, 0, 7); fctx.stroke();    // a groove
        fctx.fillStyle = '#6a6a6a';
        fctx.beginPath(); fctx.arc(cx, cy, 1.1 * fscale, 0, 7); fctx.fill();      // the label
        var ra = reduced ? u * 2 : simT * (1.2 + u * 0.35) + u * 2;
        for (var g2 = 0; g2 < 4; g2++) {
          var aa = ra - g2 * 0.16;
          fctx.fillStyle = 'rgba(175,175,175,' + (0.85 - g2 * 0.2) + ')';
          fctx.beginPath();
          fctx.arc(cx + Math.cos(aa) * 4.5 * fscale, cy + Math.sin(aa) * 4.5 * fscale, 0.55 * fscale, 0, 7);
          fctx.fill();
        }
      }

    }

    function frame(now) {
      if (!alive) return;
      // displays and zoom can change dpr without a resize event
      if (Math.min(devicePixelRatio || 1, 2) !== fxDpr) sizeFx();
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      step(dt);
      draw();
      drawRecords();
      tickTimer();                                   // the centiseconds race every frame
      var sec = (Date.now() / 1000) | 0;
      if (sec !== lastSec) { lastSec = sec; if (sec % 60 === 0) recalcCal(); }
      raf = requestAnimationFrame(frame);
    }

    recalcCal();
    tickTimer();
    requestAnimationFrame(function () { wrap.style.opacity = '1'; });
    raf = requestAnimationFrame(frame);

    return {
      // `root` is everything the lobby put on the page — the coordinates, the
      // window, and the countdown under it. `panel` is only the window, which
      // is the right handle for the wormhole to land on and the wrong one for
      // anybody trying to get the lobby out of the way.
      root: wrap,
      panel: panel,
      setCount: function (n) { syncCount(n, false); },
      destroy: function () {
        alive = false;
        cancelAnimationFrame(raf);
        if (es) es.close();
        removeEventListener('keydown', onKeyDown);
        removeEventListener('keyup', onKeyUp);
        removeEventListener('pointerup', onPointerUp);
        removeEventListener('resize', sizeFx);
        wrap.remove();
      },
    };
  }

  global.createWormhole = createWormhole;
  global.createLobby = createLobby;
})(window);
