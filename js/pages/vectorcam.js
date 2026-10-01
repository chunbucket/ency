/* Vector Cam — /tools/vectorcam.
 *
 * Live camera in, SVG out, all on the device. Each frame is traced along pixel
 * edges into loops, smoothed, simplified (Douglas-Peucker) and fitted with
 * Catmull-Rom curves; Color mode posterizes with k-means and stacks the layers
 * light to dark so they never leave gaps. The shutter re-traces the frozen
 * frame at full resolution.
 *
 * Two surfaces drive one settings object (S): the desktop dial card, and a
 * full-screen camera layer built for phones, where a drag across the picture
 * scrubs the active setting and a ruler dial sits above the shutter.
 *
 * This page is the one place the site's Permissions-Policy lets the camera in
 * (camera=(self), set per-path in server.mjs). */

import { mountChrome } from '../chrome.js';
mountChrome('tools');

// any failure shows on screen, so a phone without dev tools can still report it
window.addEventListener('error', e => toast('Error: ' + (e.message || 'unknown')));
window.addEventListener('unhandledrejection', e => toast('Error: ' + ((e.reason && (e.reason.message || e.reason.name)) || 'unknown')));

const $ = id => document.getElementById(id);
const S = { mode:'shapes', view:'vector', thr:128, auto:true, invert:false, fill:'#111111',
  ncol:5, keepBg:true, detail:7, smooth:2, speck:20, curves:true, anchors:false, res:900 };
// settings survive a reload and every switch between controls: one object,
// written to this browser's storage on each change
const SAVED = ['mode', 'view', 'thr', 'auto', 'invert', 'fill', 'ncol', 'keepBg', 'detail', 'smooth', 'speck', 'curves', 'anchors', 'res'];
try { const o = JSON.parse(localStorage.getItem('vc-settings') || '{}'); for (const k of SAVED) if (k in o && typeof o[k] === typeof S[k]) S[k] = o[k]; } catch (e) {}
let saveT = 0;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => { try { const o = {}; for (const k of SAVED) o[k] = S[k]; localStorage.setItem('vc-settings', JSON.stringify(o)); } catch (e) {} }, 250); }
const LIVE_RES = 420;      // trace size while the viewfinder is running
const REF = 900;           // slider values are tuned for this size; other sizes scale to match

let src = null, W = 0, H = 0, rgb = null, lum = null, autoThr = 128, lastSvg = '', prevC = null;
let live = false, stream = null, facing = 'environment', raf = 0, lastTick = 0, gap = 50, fpsT = [];
const photo = $('photo'), pctx = photo.getContext('2d', { willReadFrequently:true }), vid = $('vid');

const dims = s => [s.videoWidth || s.naturalWidth || s.width, s.videoHeight || s.naturalHeight || s.height];

/* ---------- image prep ---------- */
function prep(maxDim) {
  const [sw, sh] = dims(src);
  const k = Math.min(1, maxDim / Math.max(sw, sh));
  const nw = Math.max(8, Math.round(sw * k)), nh = Math.max(8, Math.round(sh * k));
  const resized = nw !== W || nh !== H;
  W = nw; H = nh;
  if (resized) { photo.width = W; photo.height = H; }
  pctx.save();
  if (src === vid && facing === 'user') { pctx.translate(W, 0); pctx.scale(-1, 1); }
  pctx.drawImage(src, 0, 0, W, H);
  pctx.restore();
  const d = pctx.getImageData(0, 0, W, H).data;
  const n = W * H, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = d[i*4+3] / 255; r[i] = d[i*4]*a + 255*(1-a); g[i] = d[i*4+1]*a + 255*(1-a); b[i] = d[i*4+2]*a + 255*(1-a); }
  rgb = [blur(r), blur(g), blur(b)];
  lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126*rgb[0][i] + 0.7152*rgb[1][i] + 0.0722*rgb[2][i];
  autoThr = otsu(lum);
  if (resized) layoutStage(sw, sh);
}
function layoutStage(sw, sh) {
  const st = $('stage');
  st.style.aspectRatio = W + ' / ' + H;
  st.style.setProperty('--ar', (W / H).toFixed(4));
  const rx = $('rulerX').children, ry = $('rulerY').children;
  rx[1].textContent = Math.round(sw / 2); rx[2].textContent = sw + ' px';
  ry[1].textContent = sh + ' px';
  fitStage();
}
function blur(a) {
  const o = new Float32Array(a.length), t = new Float32Array(a.length);
  for (let y = 0; y < H; y++) { const row = y*W; for (let x = 0; x < W; x++) {
    const i = row + x; let s = a[i], c = 1;
    if (x > 0) { s += a[i-1]; c++; } if (x < W-1) { s += a[i+1]; c++; } t[i] = s / c; } }
  for (let y = 0; y < H; y++) { const row = y*W; for (let x = 0; x < W; x++) {
    const i = row + x; let s = t[i], c = 1;
    if (y > 0) { s += t[i-W]; c++; } if (y < H-1) { s += t[i+W]; c++; } o[i] = s / c; } }
  return o;
}
function otsu(l) {
  const h = new Float64Array(256), N = l.length; let sum = 0;
  for (let i = 0; i < N; i++) h[Math.min(255, l[i] | 0)]++;
  for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = -1, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += h[i]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += i * h[i]; const m1 = sB / wB, m2 = (sum - sB) / wF, v = wB * wF * (m1 - m2) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/* ---------- tracing: pixel-edge contours → smoothed, simplified loops ---------- */
function traceMask(m) {
  const VW = W + 1, V = VW * (H + 1);
  const oA = new Int8Array(V).fill(-1), oB = new Int8Array(V).fill(-1);
  const add = (v, d) => { if (oA[v] < 0) oA[v] = d; else oB[v] = d; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y*W + x; if (!m[i]) continue;
    if (y === 0 || !m[i-W]) add(y*VW + x, 0);
    if (x === W-1 || !m[i+1]) add(y*VW + x + 1, 1);
    if (y === H-1 || !m[i+W]) add((y+1)*VW + x + 1, 2);
    if (x === 0 || !m[i-1]) add((y+1)*VW + x, 3);
  }
  const dv = [1, VW, -1, -VW], loops = [];
  for (let s = 0; s < V; s++) {
    while (oA[s] >= 0) {
      const xs = [], ys = []; let v = s, d = -1, guard = 0;
      do {
        let nd;
        if (oB[v] >= 0) {
          const pref = d < 0 ? oA[v] : (d + 1) & 3;
          if (oB[v] === pref) { nd = oB[v]; oB[v] = -1; }
          else { nd = oA[v]; oA[v] = oB[v]; oB[v] = -1; }
        } else { nd = oA[v]; oA[v] = -1; }
        if (nd < 0) break;
        xs.push(v % VW); ys.push((v / VW) | 0);
        v += dv[nd]; d = nd;
      } while (v !== s && ++guard < 4e6);
      if (xs.length >= 4) loops.push([xs, ys]);
    }
  }
  return loops;
}
function area(xs, ys) { let a = 0; for (let i = 0, n = xs.length, j = n-1; i < n; j = i++) a += xs[j]*ys[i] - xs[i]*ys[j]; return Math.abs(a / 2); }
function smoothLoop(xs, ys, k) {
  if (!k) return [xs, ys];
  const n = xs.length, ox = new Array(n), oy = new Array(n), w = 2*k + 1;
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let j = -k; j <= k; j++) { const t = (i + j + n) % n; sx += xs[t]; sy += ys[t]; }
    ox[i] = sx / w; oy[i] = sy / w;
  }
  return [ox, oy];
}
function simplify(xs, ys, tol) {
  const n = xs.length; if (n < 5) return xs.map((_, i) => i);
  let f = 0, md = -1;
  for (let i = 1; i < n; i++) { const d = (xs[i]-xs[0])**2 + (ys[i]-ys[0])**2; if (d > md) { md = d; f = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[f] = 1;
  const t2 = tol * tol, st = [[0, f], [f, n]];
  while (st.length) {
    const [a, b] = st.pop(); if (b - a < 2) continue;
    const bi = b % n, ax = xs[a], ay = ys[a], bx = xs[bi], by = ys[bi], dx = bx-ax, dy = by-ay, L = dx*dx + dy*dy;
    let mx = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      let px = xs[i]-ax, py = ys[i]-ay, d;
      if (L === 0) d = px*px + py*py;
      else { let t = (px*dx + py*dy) / L; t = t < 0 ? 0 : t > 1 ? 1 : t; const qx = px - t*dx, qy = py - t*dy; d = qx*qx + qy*qy; }
      if (d > mx) { mx = d; mi = i; }
    }
    if (mx > t2) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
const fm = v => String(Math.round(v * 10) / 10);
function loopsToPath(loops, anchorsOut) {
  const sc = Math.max(W, H) / REF;                      // keep the look consistent across sizes
  const tol = Math.max(0.25, (11 - S.detail) * 0.32 * Math.max(sc, 0.5));
  const minA = Math.max(1, S.speck * sc * sc);
  const k = S.smooth ? Math.max(1, Math.round(S.smooth * Math.max(sc, 0.5))) : 0;
  let d = '', nodes = 0;
  for (const [x0, y0] of loops) {
    if (area(x0, y0) < minA) continue;
    const [xs, ys] = smoothLoop(x0, y0, k);
    const idx = simplify(xs, ys, tol); if (idx.length < 3) continue;
    const P = idx.map(i => [xs[i], ys[i]]), n = P.length;
    nodes += n;
    if (anchorsOut && anchorsOut.length < 6000) for (const p of P) anchorsOut.push(p);
    d += 'M' + fm(P[0][0]) + ' ' + fm(P[0][1]);
    if (S.curves && n > 3) {
      for (let i = 0; i < n; i++) {
        const p0 = P[(i-1+n)%n], p1 = P[i], p2 = P[(i+1)%n], p3 = P[(i+2)%n];
        d += 'C' + fm(p1[0] + (p2[0]-p0[0])/6) + ' ' + fm(p1[1] + (p2[1]-p0[1])/6) + ' ' +
             fm(p2[0] - (p3[0]-p1[0])/6) + ' ' + fm(p2[1] - (p3[1]-p1[1])/6) + ' ' + fm(p2[0]) + ' ' + fm(p2[1]);
      }
    } else for (let i = 1; i < n; i++) d += 'L' + fm(P[i][0]) + ' ' + fm(P[i][1]);
    d += 'Z';
  }
  return { d, nodes };
}

/* ---------- color quantization ---------- */
function kmeans(k, warm) {
  const n = W * H, step = Math.max(1, Math.floor(n / (warm ? 12000 : 25000))), sample = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  let C;
  if (warm && prevC && prevC.length === k) C = prevC.map(c => c.slice());
  else {
    const sorted = sample.slice().sort((a, b) => lum[a] - lum[b]);
    C = []; for (let c = 0; c < k; c++) { const i = sorted[Math.floor((c + 0.5) / k * sorted.length)]; C.push([rgb[0][i], rgb[1][i], rgb[2][i]]); }
  }
  for (let it = 0, iters = warm ? 3 : 10; it < iters; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const i of sample) { const c = nearest(C, rgb[0][i], rgb[1][i], rgb[2][i]); const a = acc[c]; a[0] += rgb[0][i]; a[1] += rgb[1][i]; a[2] += rgb[2][i]; a[3]++; }
    C = C.map((c, j) => acc[j][3] ? [acc[j][0]/acc[j][3], acc[j][1]/acc[j][3], acc[j][2]/acc[j][3]] : c);
  }
  prevC = C;
  return C;
}
function nearest(C, r, g, b) { let bi = 0, bd = 1e12; for (let j = 0; j < C.length; j++) { const c = C[j], d = (c[0]-r)**2 + (c[1]-g)**2 + (c[2]-b)**2; if (d < bd) { bd = d; bi = j; } } return bi; }
const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/* ---------- trace + render ---------- */
function run() {
  if (!src) return 0;
  const t0 = performance.now(), n = W * H, anchors = S.anchors ? [] : null;
  let body = '', paths = 0, nodes = 0;
  if (S.mode === 'shapes') {
    const t = S.auto ? autoThr : S.thr;
    if (S.auto && S.thr !== t) { S.thr = t; $('thr').value = t; if (camOpen && active === 'thr') updateDial(); }
    $('thrVal').textContent = t;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (lum[i] <= t) !== S.invert ? 1 : 0;
    const r = loopsToPath(traceMask(m), anchors);
    if (r.d) { body = '<path fill="' + S.fill + '" fill-rule="evenodd" d="' + r.d + '"/>'; paths = 1; }
    nodes = r.nodes;
  } else {
    const C = kmeans(S.ncol, live);
    const order = C.map((c, i) => [i, 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]]).sort((a, b) => b[1] - a[1]).map(a => a[0]);
    const rank = new Uint8Array(C.length); order.forEach((ci, r) => rank[ci] = r);
    const lab = new Uint8Array(n);
    for (let i = 0; i < n; i++) lab[i] = rank[nearest(C, rgb[0][i], rgb[1][i], rgb[2][i])];
    if (S.keepBg) { body += '<rect width="' + W + '" height="' + H + '" fill="' + hex(C[order[0]]) + '"/>'; paths++; }
    const m = new Uint8Array(n);
    for (let r = 1; r < C.length; r++) {
      for (let i = 0; i < n; i++) m[i] = lab[i] >= r ? 1 : 0;
      const res = loopsToPath(traceMask(m), anchors);
      if (res.d) { body += '<path fill="' + hex(C[order[r]]) + '" fill-rule="evenodd" d="' + res.d + '"/>'; paths++; nodes += res.nodes; }
    }
  }
  lastSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + body + '</svg>';
  const out = $('out');
  out.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  let anchorSvg = '';
  if (anchors && anchors.length) {
    const rr = Math.max(W, H) / 260;
    anchorSvg = '<g fill="#e8e8e8" stroke="#000" stroke-width="' + fm(rr/3) + '">' + anchors.map(p => '<circle cx="' + fm(p[0]) + '" cy="' + fm(p[1]) + '" r="' + fm(rr) + '"/>').join('') + '</g>';
  }
  out.innerHTML = body + anchorSvg;
  if (!$('code').hidden && !live) $('code').value = lastSvg;
  const ms = performance.now() - t0;
  let fps = 0;
  if (live) { const now = performance.now(); fpsT.push(now); while (fpsT.length && now - fpsT[0] > 1000) fpsT.shift(); fps = fpsT.length; }
  const kb = new Blob([lastSvg]).size / 1024, pl = paths + ' ' + (paths === 1 ? 'path' : 'paths');
  $('readout').innerHTML = (live ? '<span>live preview <b>' + W + ' × ' + H + '</b></span>' : '<span><b>' + W + ' × ' + H + '</b> px traced</span>') +
    '<span><b>' + paths + '</b> ' + (paths === 1 ? 'path' : 'paths') + '</span><span><b>' + nodes.toLocaleString() + '</b> nodes</span>' +
    (live ? '' : '<span><b>' + kb.toFixed(1) + '</b> KB</span>') + '<span>' + Math.round(ms) + ' ms</span>' + (live ? '<span><b>' + fps + '</b> fps</span>' : '');
  if (camOpen && !peek) $('camRead').textContent = (live ? 'live · ' : W + '×' + H + ' · ') + pl + ' · ' + nodes.toLocaleString() + ' nodes' + (live ? ' · ' + fps + ' fps' : ' · ' + kb.toFixed(1) + ' KB');
  applyView();
  return ms;
}
let timer = 0;
function schedule() { if (live) return; clearTimeout(timer); timer = setTimeout(run, 30); }   // the live loop picks changes up on its own

let peek = false;
function applyView() {
  const out = $('out'), v = peek ? 'photo' : S.view;
  photo.hidden = v === 'vector';
  out.style.display = v === 'photo' ? 'none' : 'block';
  out.style.opacity = v === 'overlay' ? '0.75' : '1';
  // dark shapes on a dark viewfinder vanish: back them with paper. Preview only;
  // the exported SVG stays transparent.
  const c = S.fill.replace('#', ''), fl = parseInt(c.slice(0, 2), 16) * .3 + parseInt(c.slice(2, 4), 16) * .59 + parseInt(c.slice(4, 6), 16) * .11;
  $('stage').style.background = v === 'vector' && (S.mode === 'shapes' ? fl < 110 : !S.keepBg) ? '#d4d4d4' : 'transparent';
}

/* ---------- settings: one setter for every control surface ---------- */
const PARAMS = {
  thr:    { label:'threshold', min:1, max:254, step:1, px:5,  fmt: v => v },
  ncol:   { label:'colors',    min:2, max:10,  step:1, px:40, fmt: v => v },
  detail: { label:'detail',    min:1, max:10,  step:1, px:40, fmt: v => v + ' / 10' },
  smooth: { label:'smoothing', min:0, max:6,   step:1, px:48, fmt: v => v ? v : 'off' },
  speck:  { label:'specks',    min:0, max:300, step:5, px:2,  fmt: v => v ? '< ' + v + ' px²' : 'off' },
};
const TOGGLES = { invert:'invert', keepBg:'background', curves:'curves', anchors:'anchors' };
const CHIPS = {
  shapes: ['thr', 'fill', 'detail', 'smooth', 'speck', 'invert', 'curves', 'anchors'],
  color:  ['ncol', 'detail', 'smooth', 'speck', 'keepBg', 'curves', 'anchors'],
};
let active = 'thr';
try { const a = localStorage.getItem('vc-active'); if (a) active = a; } catch (e) {}

function setParam(k, v) {
  if (PARAMS[k]) {
    const p = PARAMS[k];
    v = Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
    if (v === S[k] && !(k === 'thr' && S.auto)) return false;
  } else if (S[k] === v) return false;
  S[k] = v;
  if (k === 'thr') S.auto = false;
  if (k === 'ncol') prevC = null;
  syncInline(); if (camOpen) { updateDial(); syncChips(); }
  schedule();
  return true;
}
function setMode(m) {
  if (S.mode === m) return;
  S.mode = m; prevC = null;
  if (!CHIPS[m].includes(active)) active = m === 'shapes' ? 'thr' : 'ncol';
  syncInline(); if (camOpen) { buildChips(); select(active); }
  schedule();
}
function setView(v) { S.view = v; syncInline(); $('camViewLbl').textContent = { vector:'vec', overlay:'mix', photo:'img' }[v]; applyView(); }
function setAuto(on) { S.auto = on; syncInline(); if (camOpen) updateDial(); schedule(); }

/* the desktop dial card mirrors S; it never holds state of its own */
function syncInline() {
  persist();
  for (const k of ['thr', 'ncol', 'detail', 'smooth', 'speck']) { $(k).value = S[k]; const v = $(k + 'Val'); if (v) v.textContent = k === 'detail' ? S[k] + ' / 10' : PARAMS[k].fmt(S[k]); }
  for (const k of ['invert', 'keepBg', 'curves', 'anchors']) $(k).checked = S[k];
  $('autoBtn').setAttribute('aria-pressed', S.auto);
  for (const [id, key] of [['modeSeg', 'mode'], ['viewSeg', 'view'], ['resSeg', 'res']])
    for (const b of $(id).children) b.setAttribute('aria-pressed', String(b.dataset.v) === String(S[key]));
  for (const b of $('camMode').children) b.setAttribute('aria-pressed', b.dataset.v === S.mode);
  $('shapesGroup').hidden = S.mode !== 'shapes'; $('colorGroup').hidden = S.mode !== 'color';
  for (const sw of $('swatches').querySelectorAll('.sw')) sw.setAttribute('aria-pressed', sw.dataset.c.toLowerCase() === S.fill.toLowerCase());
  for (const sw of $('fillRow').querySelectorAll('.csw')) sw.setAttribute('aria-pressed', sw.dataset.c.toLowerCase() === S.fill.toLowerCase());
}

/* ---------- desktop dial card ---------- */
function seg(id, fn) { $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); }); }
seg('modeSeg', setMode);
seg('viewSeg', setView);
seg('resSeg', v => { S.res = +v; syncInline(); if (!live && src) { W = H = 0; prep(S.res); schedule(); } });
for (const k of ['thr', 'ncol', 'detail', 'smooth', 'speck']) $(k).addEventListener('input', e => setParam(k, +e.target.value));
$('autoBtn').addEventListener('click', () => setAuto(!S.auto));
for (const k of ['invert', 'keepBg', 'curves', 'anchors']) $(k).addEventListener('change', e => setParam(k, e.target.checked));
$('swatches').addEventListener('click', e => { const b = e.target.closest('.sw'); if (b) setParam('fill', b.dataset.c); });
$('customColor').addEventListener('input', e => { e.target.parentElement.style.background = e.target.value; setParam('fill', e.target.value); });

/* ---------- the full-screen camera ---------- */
const coarse = matchMedia('(pointer: coarse)').matches;
const cam = $('cam'), camView = $('camView'), stage = $('stage');
let camOpen = false, lastStill = null, wakeLock = null, resumeLive = false;

function fitStage() {
  if (!camOpen || !W) return;
  const r = camView.getBoundingClientRect(), s = Math.min(r.width / W, r.height / H);
  stage.style.width = Math.floor(W * s) + 'px'; stage.style.height = Math.floor(H * s) + 'px';
}
new ResizeObserver(() => { fitStage(); if (camOpen) updateDial(); }).observe(camView);

function openCam(state) {
  if (!camOpen) {
    camOpen = true; cam.hidden = false; peek = false;
    document.documentElement.classList.add('cam-open');
    camView.appendChild(stage);
    if (coarse && document.documentElement.requestFullscreen && !document.fullscreenElement)
      document.documentElement.requestFullscreen({ navigationUI:'hide' }).catch(() => {});
    history.pushState({ vc:'cam' }, '');     // the phone's back gesture closes the camera
    buildChips(); select(active); setView(S.view);
    showHint();
  }
  cam.dataset.state = state;
  cam.classList.remove('bare');
  fitStage(); updateDial();
}
function closeCam(fromHistory) {
  if (!camOpen) return;
  const wasLive = live;
  stopLive(true); releaseWake();
  camOpen = false; cam.hidden = true; peek = false; $('camWait').hidden = true;
  document.documentElement.classList.remove('cam-open');
  $('mat').appendChild(stage); stage.style.width = stage.style.height = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromHistory && history.state && history.state.vc) history.back();
  if (wasLive || src === vid) { src = lastStill || sample(); W = H = 0; prep(S.res); run(); }
  $('chip').hidden = !(src && src.isSample);
}
window.addEventListener('popstate', () => { if (camOpen) closeCam(true); });
$('camClose').addEventListener('click', () => closeCam(false));
stage.addEventListener('click', () => { if (!camOpen && src) openCam('review'); });

let hintT = 0;
function showHint() {
  let seen = false; try { seen = localStorage.getItem('vc-hint') === '3'; } catch (e) {}
  if (seen) return;
  const h = $('camHint'); h.classList.add('show'); clearTimeout(hintT);
  hintT = setTimeout(() => h.classList.remove('show'), 3200);
  try { localStorage.setItem('vc-hint', String(+(localStorage.getItem('vc-hint') || 0) + 1)); } catch (e) {}
}
async function wake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; } }
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }

/* chips + dial */
function buildChips() {
  $('chips').innerHTML = CHIPS[S.mode].map(k => TOGGLES[k]
    ? '<button type="button" class="tog" data-k="' + k + '" aria-pressed="' + S[k] + '">' + TOGGLES[k] + '</button>'
    : '<button type="button" data-k="' + k + '">' + (k === 'fill' ? 'fill' : PARAMS[k].label) + '</button>').join('');
  syncChips();
}
function syncChips() {
  for (const b of $('chips').children) {
    const k = b.dataset.k;
    if (TOGGLES[k]) b.setAttribute('aria-pressed', S[k]); else b.classList.toggle('on', k === active);
  }
}
function select(k) {
  if (!CHIPS[S.mode].includes(k) || TOGGLES[k]) k = S.mode === 'shapes' ? 'thr' : 'ncol';
  active = k; syncChips();
  try { localStorage.setItem('vc-active', k); } catch (e) {}
  const isFill = k === 'fill';
  $('dial').hidden = isFill; $('fillRow').hidden = !isFill;
  updateDial();
  const b = $('chips').querySelector('[data-k="' + k + '"]');
  if (b) b.scrollIntoView({ inline:'center', block:'nearest', behavior:'smooth' });
}
function adjustable() { return CHIPS[S.mode].filter(k => !TOGGLES[k]); }
function updateDial() {
  if (active === 'fill') { $('dialName').textContent = 'fill'; $('dialNum').textContent = ''; $('dialAuto').hidden = true; return; }
  const p = PARAMS[active], dial = $('dial'), t = $('dialTicks'), v = S[active];
  t.style.width = ((p.max - p.min) * p.px + 2) + 'px';
  t.style.setProperty('--minor', (p.step * p.px) + 'px');
  t.style.setProperty('--major', (p.step * p.px * 5) + 'px');
  t.style.transform = 'translateX(' + (dial.clientWidth / 2 - 1 - (v - p.min) * p.px) + 'px)';
  $('dialName').textContent = p.label;
  $('dialNum').textContent = p.fmt(v);
  $('dialAuto').hidden = active !== 'thr';
  $('dialAuto').setAttribute('aria-pressed', S.auto);
  dial.setAttribute('aria-label', p.label); dial.setAttribute('aria-valuenow', v);
  dial.setAttribute('aria-valuemin', p.min); dial.setAttribute('aria-valuemax', p.max);
}
let buzzT = 0;
function buzz() { const now = performance.now(); if (now - buzzT > 40) { buzzT = now; try { navigator.vibrate?.(4); } catch (e) {} } }

$('chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.k;
  if (TOGGLES[k]) { setParam(k, !S[k]); buzz(); } else select(k);
});
$('fillRow').addEventListener('click', e => { const b = e.target.closest('.csw'); if (b) { setParam('fill', b.dataset.c); buzz(); } });
$('dialAuto').addEventListener('click', () => setAuto(!S.auto));
$('camMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
$('camViewBtn').addEventListener('click', () => setView({ vector:'overlay', overlay:'photo', photo:'vector' }[S.view]));

/* the ruler: drag it like a lens ring; a flick keeps it turning */
let dd = null, flingRaf = 0;
const dial = $('dial');
dial.addEventListener('pointerdown', e => {
  if (!PARAMS[active]) return;
  cancelAnimationFrame(flingRaf);
  dial.setPointerCapture(e.pointerId);
  dd = { x:e.clientX, v:S[active], last:e.clientX, t:performance.now(), vel:0 };
});
dial.addEventListener('pointermove', e => {
  if (!dd) return;
  const now = performance.now(), dt = Math.max(1, now - dd.t);
  dd.vel = 0.7 * dd.vel + 0.3 * ((e.clientX - dd.last) / dt); dd.last = e.clientX; dd.t = now;
  dd.f = dd.v - (e.clientX - dd.x) / PARAMS[active].px;
  if (setParam(active, dd.f)) buzz();
});
const dialEnd = () => {
  if (!dd) return;
  let vel = dd.vel, f = dd.f ?? S[active]; const k = active; dd = null;
  if (Math.abs(vel) < 0.25) return;
  const step = () => {
    vel *= 0.93; if (Math.abs(vel) < 0.03 || k !== active) return;
    f -= vel * 16 / PARAMS[k].px; setParam(k, f); flingRaf = requestAnimationFrame(step);
  };
  flingRaf = requestAnimationFrame(step);
};
dial.addEventListener('pointerup', dialEnd); dial.addEventListener('pointercancel', dialEnd);
dial.addEventListener('wheel', e => { if (!PARAMS[active]) return; e.preventDefault(); const p = PARAMS[active]; setParam(active, S[active] + Math.sign(e.deltaX || e.deltaY) * p.step); }, { passive:false });

/* the picture itself: ↔ scrubs the active setting, ↕ switches setting,
   hold shows the photo underneath, tap hides the controls */
let g = null;
camView.addEventListener('pointerdown', e => {
  if (g) return;
  camView.setPointerCapture(e.pointerId);
  g = { id:e.pointerId, x:e.clientX, y:e.clientY, v:S[active], mode:null,
        hold:setTimeout(() => { if (g && !g.mode) { g.mode = 'peek'; peek = true; applyView(); $('camRead').textContent = 'photo'; buzz(); } }, 300) };
});
camView.addEventListener('pointermove', e => {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.mode && Math.hypot(dx, dy) > 12) {
    clearTimeout(g.hold);
    g.mode = Math.abs(dx) > Math.abs(dy) ? (PARAMS[active] ? 'adjust' : 'none') : 'switch';
    if (g.mode === 'adjust') { cam.classList.remove('bare'); g.x = e.clientX; g.v = S[active]; }
  }
  if (g.mode === 'adjust') {
    const p = PARAMS[active], span = p.max - p.min;
    if (setParam(active, g.v + (e.clientX - g.x) / (camView.clientWidth * 0.85) * span)) buzz();
  }
});
const viewEnd = e => {
  if (!g || e.pointerId !== g.id) return;
  clearTimeout(g.hold);
  const dy = e.clientY - g.y;
  if (g.mode === 'peek') { peek = false; applyView(); run(); }
  else if (g.mode === 'switch' && Math.abs(dy) > 40) {
    const list = adjustable(), i = list.indexOf(active);
    cam.classList.remove('bare');
    select(list[(i + (dy < 0 ? 1 : -1) + list.length) % list.length]); buzz();
  } else if (!g.mode && e.type === 'pointerup') cam.classList.toggle('bare');
  g = null;
};
camView.addEventListener('pointerup', viewEnd); camView.addEventListener('pointercancel', viewEnd);

document.addEventListener('keydown', e => {
  if (!camOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCam(false); }
  else if ((e.code === 'Space' || e.key === 'Enter') && live && !e.target.closest?.('button,input')) { e.preventDefault(); capture(); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && PARAMS[active]) { e.preventDefault(); setParam(active, S[active] + (e.key === 'ArrowRight' ? 1 : -1) * PARAMS[active].step); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const l = adjustable(), i = l.indexOf(active); select(l[(i + (e.key === 'ArrowUp' ? 1 : -1) + l.length) % l.length]); }
});

/* ---------- camera stream ---------- */
async function openStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ audio:false,
    video:{ facingMode:{ ideal:facing }, width:{ ideal:1920 }, height:{ ideal:1080 } } });
  vid.srcObject = stream;
  await vid.play();
  if (!vid.videoWidth) await new Promise(r => vid.addEventListener('loadedmetadata', r, { once:true }));
}
async function startLive() {
  if (!window.isSecureContext) { toast('Live camera needs an https:// address (or localhost).'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('This browser doesn’t support the live camera. Choose an image instead.'); return; }
  if (src && src !== vid) lastStill = src;
  openCam('live');                 // open first, inside the tap, so full screen is allowed
  if (!live) { $('camWait').hidden = false; $('camWait').textContent = 'starting camera…'; }
  try {
    if (!stream || !stream.active) await openStream();
  } catch (e) {
    closeCam(false);
    toast(e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser’s site settings, then try again.'
      : e.name === 'NotFoundError' ? 'No camera found on this device.' : 'Couldn’t start the camera (' + e.name + ').');
    return;
  }
  if (!camOpen) return;
  live = true; prevC = null; fpsT = []; src = vid; W = H = 0; frames = 0;
  cam.dataset.state = 'live'; wake();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  setTimeout(() => {                 // camera granted but no picture arriving
    if (live && !frames) { $('camWait').textContent = 'the camera opened but no picture is arriving. close and try again, or choose an image.'; vid.play().catch(() => {}); }
  }, 4000);
}
let frames = 0;
function tick(now) {
  if (!live) return;
  if (vid.readyState >= 2 && vid.videoWidth && now - lastTick >= gap) {
    lastTick = now;
    try {
      prep(Math.min(LIVE_RES, S.res));
      const ms = run();
      gap = Math.max(33, ms * 1.15);    // never let tracing starve the UI
      if (!frames++) $('camWait').hidden = true;
    } catch (e) { stopLive(true); $('camWait').hidden = false; $('camWait').textContent = 'tracing stopped: ' + e.message; return; }
  }
  raf = requestAnimationFrame(tick);
}
function stopLive(release) {
  live = false; cancelAnimationFrame(raf);
  if (release && stream) { stream.getTracks().forEach(t => t.stop()); stream = null; vid.srcObject = null; }
}
function capture() {
  if (!live || !vid.videoWidth) return;
  $('camWait').hidden = true;
  const c = document.createElement('canvas'); c.width = vid.videoWidth; c.height = vid.videoHeight;
  const x = c.getContext('2d');
  if (facing === 'user') { x.translate(c.width, 0); x.scale(-1, 1); }
  x.drawImage(vid, 0, 0);
  stopLive(false);
  const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  try { navigator.vibrate?.(12); } catch (e) {}
  src = c; lastStill = c; W = H = 0; prevC = null;
  prep(S.res); run();
  cam.dataset.state = 'review'; fitStage();
}
$('startBtn').addEventListener('click', startLive);
$('shutter').addEventListener('click', capture);
$('camRetake').addEventListener('click', startLive);
$('flipBtn').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try { await openStream(); W = H = 0; } catch (e) { toast('Couldn’t switch cameras on this device.'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && live) { resumeLive = true; stopLive(true); releaseWake(); }
  else if (!document.hidden && resumeLive) { resumeLive = false; if (camOpen) startLive(); }
});

/* ---------- files ---------- */
function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('That file isn’t an image. Try a JPG, PNG, or HEIC photo.'); return; }
  // read as a data: URL — the site CSP allows data: images, not blob:
  const reader = new FileReader(), img = new Image();
  reader.onload = () => { img.src = reader.result; };
  reader.onerror = () => toast('Couldn’t read that file.');
  img.onload = () => {
    stopLive(true);
    src = img; lastStill = img; W = H = 0; prevC = null; $('chip').hidden = true;
    S.auto = true; syncInline();
    prep(S.res); run();
    if (camOpen || coarse) openCam('review');
  };
  img.onerror = () => toast('This browser can’t open that image format. Try a JPG or PNG.');
  reader.readAsDataURL(file);
}
$('fileIn').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
const mat = $('mat');
mat.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drop'); });
mat.addEventListener('dragleave', () => stage.classList.remove('drop'));
mat.addEventListener('drop', e => { e.preventDefault(); stage.classList.remove('drop'); loadFile(e.dataTransfer.files[0]); });
window.addEventListener('paste', e => { const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/')); if (it) loadFile(it.getAsFile()); });

/* ---------- export ---------- */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
function currentSvg() { if (live) capture(); return lastSvg; }
function stamp() { const d = new Date(), p = v => String(v).padStart(2, '0'); return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function download(svg, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type:'image/svg+xml' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('SVG saved');
}
// phones get the share sheet (Save to Files, AirDrop, Drive…); everything else downloads
async function save() {
  const svg = currentSvg(), name = 'ency-vectorcam-' + stamp() + '.svg';
  if (coarse && navigator.canShare) {
    try {
      const file = new File([svg], name, { type:'image/svg+xml' });
      if (navigator.canShare({ files:[file] })) { await navigator.share({ files:[file] }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(svg, name);
}
function copySvg() {
  const svg = currentSvg();
  const fallback = () => { if (camOpen) { toast('Copy isn’t available here. Use save instead.'); return; } showCode(true); const c = $('code'); c.focus(); c.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} toast(ok ? 'SVG copied' : 'Code selected. Copy it from the box below.'); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(svg).then(() => toast('SVG copied'), fallback);
  else fallback();
}
$('dlBtn').addEventListener('click', save);
$('camSave').addEventListener('click', save);
$('copyBtn').addEventListener('click', copySvg);
$('camCopy').addEventListener('click', copySvg);
function showCode(open) { const c = $('code'); c.hidden = !open; $('codeBtn').textContent = open ? 'hide code' : 'show code'; $('codeBtn').setAttribute('aria-expanded', open); if (open) c.value = lastSvg; }
$('codeBtn').addEventListener('click', () => showCode($('code').hidden));

/* ---------- sample photo shown before the camera starts ---------- */
function sample() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 640; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 900, 640); g.addColorStop(0, '#ece6d8'); g.addColorStop(1, '#d6cfbe'); x.fillStyle = g; x.fillRect(0, 0, 900, 640);
  x.fillStyle = '#e2672b'; x.beginPath(); x.arc(640, 190, 82, 0, Math.PI * 2); x.fill();
  for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; x.save(); x.translate(640, 190); x.rotate(a); x.beginPath(); x.moveTo(100, -9); x.lineTo(150, 0); x.lineTo(100, 9); x.fill(); x.restore(); }
  x.fillStyle = '#3f8a7d'; x.beginPath(); x.moveTo(0, 470); x.lineTo(170, 270); x.lineTo(280, 380); x.lineTo(410, 230); x.lineTo(600, 450); x.lineTo(900, 330); x.lineTo(900, 640); x.lineTo(0, 640); x.fill();
  x.fillStyle = '#1f4249'; x.beginPath(); x.moveTo(0, 560); x.bezierCurveTo(200, 430, 330, 520, 480, 470); x.bezierCurveTo(640, 420, 760, 520, 900, 470); x.lineTo(900, 640); x.lineTo(0, 640); x.fill();
  x.save(); x.translate(450, 610); x.rotate(-0.025); x.fillStyle = '#141414'; x.font = '900 128px Impact, "Arial Black", sans-serif'; x.textAlign = 'center'; x.fillText('FIELD NOTES', 0, 0); x.restore();
  x.strokeStyle = '#141414'; x.lineWidth = 7; x.lineCap = 'round';
  x.beginPath(); x.moveTo(90, 120); x.quadraticCurveTo(140, 70, 190, 120); x.quadraticCurveTo(240, 70, 290, 120); x.stroke();
  const v = x.createRadialGradient(450, 320, 200, 450, 320, 620); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(40,30,10,.28)'); x.fillStyle = v; x.fillRect(0, 0, 900, 640);
  const im = x.getImageData(0, 0, 900, 640), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const nz = (Math.random() - 0.5) * 26; d[i] += nz; d[i+1] += nz; d[i+2] += nz; }
  x.putImageData(im, 0, 0);
  c.isSample = true;
  return c;
}
src = sample(); prep(S.res); syncInline(); run();
$('chip').hidden = false;
