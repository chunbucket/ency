/* Vector Cam — /tools/vectorcam.
 *
 * Camera or image in, SVG out, all on the device. The tracing itself lives in
 * vectorcam-worker.js (sub-pixel contours, Bézier fitting with corners,
 * adaptive lighting, denoise, perspective flatten, OKLab colour); this file is
 * the camera, the controls, and the plumbing between them.
 *
 * Two surfaces drive one settings object (S): the desktop dial card, and a
 * full-screen camera layer built for phones, where a drag across the picture
 * scrubs the active setting and a ruler dial sits above the shutter.
 *
 * This page is the one place the site's Permissions-Policy lets the camera in
 * (camera=(self), set per-path in server.mjs). */

import { mountChrome } from '../chrome.js';
mountChrome('tools');

// any failure stays on screen with its line number, so a phone without dev
// tools can still report exactly what broke
function fatal(msg) {
  let b = document.getElementById('vcErr');
  if (!b) { b = document.createElement('pre'); b.id = 'vcErr'; b.className = 'vc-err'; b.addEventListener('click', () => b.remove()); document.body.appendChild(b); b.textContent = 'vector cam hit an error (tap to dismiss):\n'; }
  b.textContent += msg + '\n';
}
window.addEventListener('error', e => fatal((e.message || 'unknown') + '  @' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno));
window.addEventListener('unhandledrejection', e => fatal('async: ' + ((e.reason && (e.reason.message || e.reason.name)) || 'unknown')));

const $ = id => document.getElementById(id);

/* ---------- settings ---------- */
const S = { mode:'shapes', view:'vector', thr:128, auto:true, invert:false, adaptive:true, fill:'#111111',
  ncol:5, keepBg:true, detail:7, smooth:2, corner:5, speck:20, denoise:3, flatten:false, curves:true, anchors:false, res:2000,
  // tracing extras
  style:'fill', lineW:0, snap:0, fine:false, autoColors:false, layering:'stack',
  // export, refine, library, app
  format:'svg', size:'fit', paper:'auto', pngScale:2, brush:0.035, history:true, historyMax:30, autoCam:true };
// settings that change only the file or the app, never the trace
const NO_TRACE = new Set(['view', 'format', 'size', 'paper', 'pngScale', 'brush', 'history', 'historyMax', 'autoCam']);
const RES = [1200, 2000, 2800];
// settings survive a reload and every switch between controls: one object,
// written to this browser's storage on each change
const SAVED = Object.keys(S);
try { const o = JSON.parse(localStorage.getItem('vc-settings') || '{}'); for (const k of SAVED) if (k in o && typeof o[k] === typeof S[k]) S[k] = o[k]; } catch (e) {}
if (!RES.includes(S.res)) S.res = 2000;
let saveT = 0;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => { try { const o = {}; for (const k of SAVED) o[k] = S[k]; localStorage.setItem('vc-settings', JSON.stringify(o)); } catch (e) {} }, 250); }
// per image, not saved as preferences: refine strokes, palette edits
let strokes = [], redoStack = [], pal = {}, palK = 0, lastPalette = null, lastK = 0, lastStrokeW = 0;
const traceSettings = forLive => {
  const o = {}; for (const k of SAVED) o[k] = S[k];
  o.strokes = forLive ? [] : strokes; o.pal = forLive ? {} : pal; o.palK = forLive ? 0 : palK;
  return o;
};
function resetImageEdits() { strokes = []; redoStack = []; pal = {}; palK = 0; selPal = -1; }

const LIVE_RES = 420;      // frame size traced while the viewfinder runs
const coarse = matchMedia('(pointer: coarse)').matches;

let W = 0, H = 0, lastSvg = '', lastBody = '', lastQuad = null, manualQuad = null;
let live = false, stream = null, facing = 'environment', raf = 0, fpsT = [], frames = 0, capturing = false;
let still = null, stillIsSample = false, currentId = 0, selPal = -1;
const photo = $('photo'), pctx = photo.getContext('2d'), vid = $('vid'), stage = $('stage');
const fc = document.createElement('canvas'), fctx = fc.getContext('2d', { willReadFrequently:true });

/* ---------- the tracer, off the main thread ---------- */
const worker = new Worker('/js/pages/vectorcam-worker.js?v=7');
let busy = false, queued = null, jobSeq = 0;
worker.onerror = e => { busy = false; fatal('tracer: ' + (e.message || 'could not load')); };
worker.onmessage = e => {
  busy = false;
  const r = e.data;
  if (r.error) fatal('tracer: ' + r.error); else show(r);
  pump();
};
function post(msg, transfer) { busy = true; worker.postMessage(msg, transfer || []); }
function pump() { if (busy || !queued) return; const q = queued; queued = null; q(); }

function dims(src) { return [src.videoWidth || src.naturalWidth || src.width, src.videoHeight || src.naturalHeight || src.height]; }

// hand the still image to the worker once; re-traces then only send settings
function sendStill() {
  if (!still) return;
  const [sw, sh] = dims(still), k = Math.min(1, S.res / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently:true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.drawImage(still, 0, 0, w, h);
  const im = x.getImageData(0, 0, w, h);
  worker.postMessage({ type:'still', w, h, buf:im.data.buffer }, [im.data.buffer]);
}
let traceT = 0;
function requestTrace() {
  if (live || !still) return;
  clearTimeout(traceT);
  traceT = setTimeout(() => {
    queued = () => post({ type:'trace', id:++jobSeq, s:traceSettings(), quad:manualQuad });
    if (camOpen) $('camRead').innerHTML = '<span class="busy-dot"></span>tracing…';
    pump();
  }, 30);
}
function sendFrame() {
  const vw = vid.videoWidth, vh = vid.videoHeight, k = Math.min(1, LIVE_RES / Math.max(vw, vh));
  const w = Math.max(8, Math.round(vw * k)), h = Math.max(8, Math.round(vh * k));
  if (fc.width !== w || fc.height !== h) { fc.width = w; fc.height = h; }
  fctx.save();
  if (facing === 'user') { fctx.translate(w, 0); fctx.scale(-1, 1); }
  fctx.drawImage(vid, 0, 0, w, h);
  fctx.restore();
  const im = fctx.getImageData(0, 0, w, h);
  post({ type:'frame', id:++jobSeq, w, h, buf:im.data.buffer, s:traceSettings(true) }, [im.data.buffer]);
}

/* ---------- showing a result ---------- */
function show(r) {
  if (r.kind === 'frame' && !live) return;    // a live frame that finished after the shutter
  if (r.kind === 'trace' && live) return;
  if (cam.dataset.state === 'crop') return;
  const resized = r.W !== W || r.H !== H;
  W = r.W; H = r.H;
  if (resized) { photo.width = W; photo.height = H; layoutStage(); }
  if (r.preview) pctx.putImageData(new ImageData(r.preview, W, H), 0, 0);
  else if (r.kind === 'frame') pctx.drawImage(fc, 0, 0, W, H);
  else if (still) { pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, W, H); pctx.drawImage(still, 0, 0, W, H); }
  lastQuad = r.quad || null;
  lastStrokeW = r.strokeW || 0;
  if (r.palette) {
    if (r.k !== lastK && r.kind === 'trace' && palK && palK !== r.k) { pal = {}; palK = 0; selPal = -1; }   // a new palette: old edits don't apply
    lastK = r.k; lastPalette = r.palette;
    if (camOpen && active === 'palette') renderPalette();
  }
  if (S.auto && S.mode === 'shapes' && S.thr !== r.autoThr) { S.thr = r.autoThr; $('thr').value = S.thr; $('thrVal').textContent = S.thr; if (camOpen && active === 'thr') updateDial(); }
  lastBody = r.body;
  lastSvg = buildSvg();
  const out = $('out');
  out.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  let anchorSvg = '';
  if (r.anchors && r.anchors.length) {
    const rr = Math.max(W, H) / 260, a = r.anchors;
    let g = '';
    for (let i = 0; i < a.length; i += 2) g += '<circle cx="' + fm(a[i]) + '" cy="' + fm(a[i + 1]) + '" r="' + fm(rr) + '"/>';
    anchorSvg = '<g fill="#e8e8e8" stroke="#000" stroke-width="' + fm(rr / 3) + '">' + g + '</g>';
  }
  out.innerHTML = r.body + anchorSvg;
  if (!$('code').hidden && !live) $('code').value = lastSvg;

  let fps = 0;
  if (live) { const now = performance.now(); fpsT.push(now); while (fpsT.length && now - fpsT[0] > 1000) fpsT.shift(); fps = fpsT.length; if (!frames++) $('camWait').hidden = true; }
  const kb = lastSvg.length / 1024, pl = r.paths + ' ' + (r.paths === 1 ? 'path' : 'paths');
  $('readout').innerHTML = (live ? '<span>live preview <b>' + W + ' × ' + H + '</b></span>' : '<span><b>' + W + ' × ' + H + '</b> px traced</span>') +
    '<span><b>' + r.paths + '</b> ' + (r.paths === 1 ? 'path' : 'paths') + '</span><span><b>' + r.nodes.toLocaleString() + '</b> nodes</span>' +
    (live ? '' : '<span><b>' + kb.toFixed(1) + '</b> KB</span>') + '<span>' + Math.round(r.ms) + ' ms</span>' + (live ? '<span><b>' + fps + '</b> fps</span>' : '') +
    (r.k ? '<span><b>' + r.k + '</b> colors</span>' : '') + (r.strokeW ? '<span>lines <b>' + fm(r.strokeW) + '</b> px</span>' : '') +
    (r.quad ? '<span>page flattened</span>' : '');
  if (camOpen && !peek) $('camRead').textContent = (live ? 'live · ' : W + '×' + H + ' · ') + pl + ' · ' + r.nodes.toLocaleString() + ' nodes' + (live ? ' · ' + fps + ' fps' : ' · ' + kb.toFixed(1) + ' KB') + (r.k ? ' · ' + r.k + ' colors' : '') + (r.quad ? ' · flat' : '');
  applyView();
  if (r.kind === 'trace' && !stillIsSample) queueHistory();
}
const fm = v => String(Math.round(v * 10) / 10);

function layoutStage() {
  stage.style.aspectRatio = W + ' / ' + H;
  stage.style.setProperty('--ar', (W / H).toFixed(4));
  const rx = $('rulerX').children, ry = $('rulerY').children;
  rx[1].textContent = Math.round(W / 2); rx[2].textContent = W + ' px';
  ry[1].textContent = H + ' px';
  fitStage();
}

let peek = false;
function applyView() {
  const out = $('out'), v = peek ? 'photo' : S.view;
  photo.hidden = v === 'vector';
  out.style.display = v === 'photo' ? 'none' : 'block';
  out.style.opacity = v === 'overlay' ? '0.75' : '1';
  // dark shapes on a dark viewfinder vanish: back them with paper. Preview
  // only; the exported SVG stays transparent.
  const c = S.fill.replace('#', ''), fl = parseInt(c.slice(0, 2), 16) * .3 + parseInt(c.slice(2, 4), 16) * .59 + parseInt(c.slice(4, 6), 16) * .11;
  stage.style.background = v === 'vector' && (S.mode === 'shapes' ? fl < 110 : !S.keepBg) ? '#d4d4d4' : 'transparent';
}

/* ---------- one setter for every control surface ---------- */
const PARAMS = {
  thr:     { label:'threshold', min:1, max:254, step:1, px:5,  fmt: v => v },
  ncol:    { label:'colors',    min:2, max:10,  step:1, px:40, fmt: v => v },
  detail:  { label:'detail',    min:1, max:10,  step:1, px:40, fmt: v => v + ' / 10' },
  smooth:  { label:'smoothing', min:0, max:6,   step:1, px:48, fmt: v => v ? v : 'off' },
  corner:  { label:'corners',   min:0, max:10,  step:1, px:40, fmt: v => v ? v + ' / 10' : 'all round' },
  speck:   { label:'specks',    min:0, max:300, step:5, px:2,  fmt: v => v ? '< ' + v + ' px²' : 'off' },
  denoise: { label:'denoise',   min:0, max:10,  step:1, px:40, fmt: v => v ? v + ' / 10' : 'off' },
};
// on/off chips; some stand for a richer setting (center lines = style 'line')
const TOGGLES = {
  lines:      { label:'center lines', get:() => S.style === 'line', set:v => setParam('style', v ? 'line' : 'fill') },
  snapOn:     { label:'snap shapes', get:() => S.snap > 0, set:v => setParam('snap', v ? 1 : 0) },
  autoColors: { label:'auto colors' },
  adaptive:   { label:'even light' },
  invert:     { label:'invert' },
  keepBg:     { label:'background' },
  flatten:    { label:'flatten page' },
  curves:     { label:'curves' },
  anchors:    { label:'anchors' },
};
const tget = k => TOGGLES[k].get ? TOGGLES[k].get() : S[k];
const tset = (k, v) => TOGGLES[k].set ? TOGGLES[k].set(v) : setParam(k, v);
const CHIPS = {
  shapes: ['thr', 'fill', 'detail', 'corner', 'smooth', 'speck', 'denoise', 'lines', 'snapOn', 'adaptive', 'invert', 'flatten', 'curves', 'anchors'],
  color:  ['ncol', 'palette', 'detail', 'corner', 'smooth', 'speck', 'denoise', 'autoColors', 'snapOn', 'keepBg', 'flatten', 'curves', 'anchors'],
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
  if (k === 'ncol' || k === 'autoColors') { pal = {}; palK = 0; selPal = -1; }
  if (NO_TRACE.has(k)) { syncInline(); if (!live && lastBody) { lastSvg = buildSvg(); if (!$('code').hidden) $('code').value = lastSvg; } return true; }
  if (k === 'flatten') { manualQuad = null; strokes = []; redoStack = []; if (camOpen) buildChips(); }
  syncInline(); if (camOpen) { updateDial(); syncChips(); }
  requestTrace();
  return true;
}
function setMode(m) {
  if (S.mode === m) return;
  S.mode = m;
  if (!CHIPS[m].includes(active)) active = m === 'shapes' ? 'thr' : 'ncol';
  syncInline(); if (camOpen) { buildChips(); select(active); }
  requestTrace();
}
function setView(v) { S.view = v; syncInline(); $('camViewLbl').textContent = { vector:'vec', overlay:'mix', photo:'img' }[v]; applyView(); }
function setAuto(on) { S.auto = on; syncInline(); if (camOpen) updateDial(); requestTrace(); }
function setRes(v) { S.res = v; syncInline(); if (!live && still) { sendStill(); requestTrace(); } }

/* the desktop dial card mirrors S; it never holds state of its own */
const SLIDERS = ['thr', 'ncol', 'detail', 'smooth', 'corner', 'speck', 'denoise'];
const CHECKS = ['invert', 'adaptive', 'keepBg', 'flatten', 'curves', 'anchors'];
function syncInline() {
  persist();
  if ($('dlBtn')) updateSaveLabels();
  for (const k of SLIDERS) { $(k).value = S[k]; const v = $(k + 'Val'); if (v) v.textContent = PARAMS[k].fmt(S[k]); }
  for (const k of CHECKS) $(k).checked = S[k];
  $('autoBtn').setAttribute('aria-pressed', S.auto);
  for (const [id, key] of [['modeSeg', 'mode'], ['viewSeg', 'view'], ['resSeg', 'res']])
    for (const b of $(id).children) b.setAttribute('aria-pressed', String(b.dataset.v) === String(S[key]));
  for (const b of $('camMode').children) b.setAttribute('aria-pressed', b.dataset.v === S.mode);
  $('shapesGroup').hidden = S.mode !== 'shapes'; $('colorGroup').hidden = S.mode !== 'color';
  for (const sw of $('swatches').querySelectorAll('.sw')) sw.setAttribute('aria-pressed', sw.dataset.c.toLowerCase() === S.fill.toLowerCase());
  for (const sw of $('fillRow').querySelectorAll('.csw')) sw.setAttribute('aria-pressed', sw.dataset.c.toLowerCase() === S.fill.toLowerCase());
}

function seg(id, fn) { $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); }); }
seg('modeSeg', setMode);
seg('viewSeg', setView);
seg('resSeg', v => setRes(+v));
for (const k of SLIDERS) $(k).addEventListener('input', e => setParam(k, +e.target.value));
$('autoBtn').addEventListener('click', () => setAuto(!S.auto));
for (const k of CHECKS) $(k).addEventListener('change', e => setParam(k, e.target.checked));
$('swatches').addEventListener('click', e => { const b = e.target.closest('.sw'); if (b) setParam('fill', b.dataset.c); });
$('customColor').addEventListener('input', e => { e.target.parentElement.style.background = e.target.value; setParam('fill', e.target.value); });

/* ---------- the full-screen camera ---------- */
const cam = $('cam'), camView = $('camView');
let camOpen = false, wakeLock = null, resumeLive = false, cropW = 0, cropH = 0;

function fitStage() {
  if (!camOpen) return;
  const w = cam.dataset.state === 'crop' ? cropW : W, h = cam.dataset.state === 'crop' ? cropH : H;
  if (!w) return;
  const r = camView.getBoundingClientRect(), s = Math.min(r.width / w, r.height / h);
  stage.style.width = Math.floor(w * s) + 'px'; stage.style.height = Math.floor(h * s) + 'px';
}
new ResizeObserver(() => { fitStage(); if (camOpen) updateDial(); if (cam.dataset.state === 'refine') { sizeBrushCv(); drawBrush(); } }).observe(camView);

function openCam(state) {
  if (!camOpen) {
    camOpen = true; cam.hidden = false; peek = false;
    document.documentElement.classList.add('cam-open');
    camView.appendChild(stage);
    if (coarse && document.documentElement.requestFullscreen && !document.fullscreenElement)
      document.documentElement.requestFullscreen({ navigationUI:'hide' }).catch(() => {});
    history.pushState({ vc:'cam' }, '');     // the phone's back gesture closes the camera
    setView(S.view);
    showHint();
  }
  setCamState(state);
}
function setCamState(state) {
  cam.dataset.state = state;
  cam.classList.remove('bare');
  buildChips(); select(active);
  fitStage();
}
function closeCam(fromHistory) {
  if (!camOpen) return;
  if (cam.dataset.state === 'crop') leaveCrop(false);
  if (cam.dataset.state === 'refine') leaveRefine();
  const wasLive = live;
  stopLive(true); releaseWake();
  camOpen = false; cam.hidden = true; peek = false; $('camWait').hidden = true;
  document.documentElement.classList.remove('cam-open');
  $('mat').appendChild(stage); stage.style.width = stage.style.height = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromHistory && history.state && history.state.vc) history.back();
  if (wasLive || !still) { if (!still) useSample(); else { W = H = 0; sendStill(); requestTrace(); } }
  $('chip').hidden = !stillIsSample;
}
window.addEventListener('popstate', () => { if (camOpen) closeCam(true); });
$('camClose').addEventListener('click', () => closeCam(false));
stage.addEventListener('click', () => { if (!camOpen && still) openCam('review'); });

let hintT = 0;
function showHint() {
  let seen = false; try { seen = +(localStorage.getItem('vc-hint') || 0) >= 3; } catch (e) {}
  if (seen) return;
  const h = $('camHint'); h.classList.add('show'); clearTimeout(hintT);
  hintT = setTimeout(() => h.classList.remove('show'), 3400);
  try { localStorage.setItem('vc-hint', String(+(localStorage.getItem('vc-hint') || 0) + 1)); } catch (e) {}
}
async function wake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; } }
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }

/* chips + dial */
function buildChips() {
  const list = CHIPS[S.mode].map(k => TOGGLES[k]
    ? '<button type="button" class="tog" data-k="' + k + '" aria-pressed="' + tget(k) + '">' + TOGGLES[k].label + '</button>'
    : '<button type="button" data-k="' + k + '">' + (k === 'fill' ? 'fill' : k === 'palette' ? 'palette' : PARAMS[k].label) + '</button>');
  // a captured photo gets the refine brush, and a corner editor when flattened
  if (cam.dataset.state === 'review' && still) {
    list.splice(1, 0, '<button type="button" class="act" data-k="refine">refine</button>');
    if (S.flatten) list.splice(CHIPS[S.mode].indexOf('flatten') + 2, 0, '<button type="button" class="act" data-k="crop">adjust corners</button>');
  }
  $('chips').innerHTML = list.join('');
  syncChips();
}
function syncChips() {
  for (const b of $('chips').children) {
    const k = b.dataset.k;
    if (TOGGLES[k]) b.setAttribute('aria-pressed', tget(k)); else b.classList.toggle('on', k === active);
  }
}
function select(k) {
  if (!CHIPS[S.mode].includes(k) || TOGGLES[k]) k = S.mode === 'shapes' ? 'thr' : 'ncol';
  active = k; syncChips();
  try { localStorage.setItem('vc-active', k); } catch (e) {}
  $('dial').hidden = k === 'fill' || k === 'palette';
  $('fillRow').hidden = k !== 'fill';
  $('palRow').hidden = k !== 'palette';
  if (k === 'palette') renderPalette();
  updateDial();
  const b = $('chips').querySelector('[data-k="' + k + '"]');
  if (b) b.scrollIntoView({ inline:'center', block:'nearest', behavior:'smooth' });
}
function adjustable() { return CHIPS[S.mode].filter(k => !TOGGLES[k]); }
function updateDial() {
  if (active === 'fill' || active === 'palette') {
    $('dialName').textContent = active === 'fill' ? 'fill' : (lastPalette ? 'palette · tap a color' : 'palette');
    $('dialNum').textContent = ''; $('dialAuto').hidden = true; return;
  }
  const p = PARAMS[active], dl = $('dial'), t = $('dialTicks'), v = S[active];
  if (!p) return;
  t.style.width = ((p.max - p.min) * p.px + 2) + 'px';
  t.style.setProperty('--minor', (p.step * p.px) + 'px');
  t.style.setProperty('--major', (p.step * p.px * 5) + 'px');
  t.style.transform = 'translateX(' + (dl.clientWidth / 2 - 1 - (v - p.min) * p.px) + 'px)';
  $('dialName').textContent = p.label;
  $('dialNum').textContent = p.fmt(v);
  $('dialAuto').hidden = active !== 'thr';
  $('dialAuto').setAttribute('aria-pressed', S.auto);
  dl.setAttribute('aria-label', p.label); dl.setAttribute('aria-valuenow', v);
  dl.setAttribute('aria-valuemin', p.min); dl.setAttribute('aria-valuemax', p.max);
}
let buzzT = 0;
function buzz() { const now = performance.now(); if (now - buzzT > 40) { buzzT = now; try { navigator.vibrate?.(4); } catch (e) {} } }

$('chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.k;
  if (k === 'crop') enterCrop();
  else if (k === 'refine') enterRefine();
  else if (TOGGLES[k]) { tset(k, !tget(k)); syncChips(); buzz(); }
  else select(k);
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
dial.addEventListener('wheel', e => { if (!PARAMS[active]) return; e.preventDefault(); setParam(active, S[active] + Math.sign(e.deltaX || e.deltaY) * PARAMS[active].step); }, { passive:false });

/* the picture itself: ↔ scrubs the active setting, ↕ switches setting,
   hold shows the photo underneath, tap hides the controls */
let g = null;
camView.addEventListener('pointerdown', e => {
  if (g || cam.dataset.state === 'crop' || cam.dataset.state === 'refine') return;
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
  if (g.mode === 'peek') { peek = false; applyView(); }
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
  if (!$('sheet').hidden) { if (e.key === 'Escape') closeSheet(); return; }
  if (e.key === 'Escape') { e.preventDefault(); if (cam.dataset.state === 'crop') leaveCrop(false); else if (cam.dataset.state === 'refine') leaveRefine(); else closeCam(false); }
  else if (cam.dataset.state === 'refine' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.code === 'Space' || e.key === 'Enter') && live && !e.target.closest?.('button,input')) { e.preventDefault(); capture(); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && PARAMS[active]) { e.preventDefault(); setParam(active, S[active] + (e.key === 'ArrowRight' ? 1 : -1) * PARAMS[active].step); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const l = adjustable(), i = l.indexOf(active); select(l[(i + (e.key === 'ArrowUp' ? 1 : -1) + l.length) % l.length]); }
});

/* ---------- corner editor for the flattened page ---------- */
let cropQ = null, cropDrag = -1;
const cropSvg = $('cropSvg');
function enterCrop() {
  if (!still) return;
  const [sw, sh] = dims(still), k = Math.min(1, 1600 / Math.max(sw, sh));
  cropW = Math.round(sw * k); cropH = Math.round(sh * k);
  cam.dataset.state = 'crop';
  photo.width = cropW; photo.height = cropH;
  pctx.drawImage(still, 0, 0, cropW, cropH);
  photo.hidden = false; $('out').style.display = 'none'; stage.style.background = 'transparent';
  stage.style.aspectRatio = cropW + ' / ' + cropH;
  cropQ = (manualQuad || lastQuad || [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]).map(p => p.slice());
  cropSvg.setAttribute('viewBox', '0 0 ' + cropW + ' ' + cropH);
  cropSvg.removeAttribute('hidden');
  drawCrop();
  fitStage();
}
function drawCrop() {
  const P = cropQ.map(p => [p[0] * cropW, p[1] * cropH]), r = Math.max(cropW, cropH) / 38;
  let s = '<path d="M0 0H' + cropW + 'V' + cropH + 'H0Z M' + P.map(p => fm(p[0]) + ' ' + fm(p[1])).join('L') + 'Z" fill="rgba(0,0,0,.5)" fill-rule="evenodd"/>';
  s += '<polygon points="' + P.map(p => fm(p[0]) + ',' + fm(p[1])).join(' ') + '" fill="none" stroke="#e8e8e8" stroke-width="' + fm(r / 6) + '"/>';
  P.forEach((p, i) => {
    s += '<circle class="h" data-i="' + i + '" cx="' + fm(p[0]) + '" cy="' + fm(p[1]) + '" r="' + fm(r * 1.8) + '" fill="rgba(0,0,0,0)"/>';
    s += '<circle cx="' + fm(p[0]) + '" cy="' + fm(p[1]) + '" r="' + fm(r * 0.6) + '" fill="#d08a8a" stroke="#fff" stroke-width="' + fm(r / 5) + '" pointer-events="none"/>';
  });
  cropSvg.innerHTML = s;
}
cropSvg.addEventListener('pointerdown', e => {
  const h = e.target.closest('.h'); if (!h) return;
  e.preventDefault(); cropDrag = +h.dataset.i; cropSvg.setPointerCapture(e.pointerId); buzz();
});
cropSvg.addEventListener('pointermove', e => {
  if (cropDrag < 0) return;
  const r = stage.getBoundingClientRect();
  cropQ[cropDrag] = [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  drawCrop();
});
const cropEnd = () => { cropDrag = -1; };
cropSvg.addEventListener('pointerup', cropEnd); cropSvg.addEventListener('pointercancel', cropEnd);
function leaveCrop(apply) {
  cropSvg.setAttribute('hidden', ''); cropSvg.innerHTML = '';
  if (apply) { manualQuad = cropQ.map(p => p.slice()); strokes = []; redoStack = []; }   // new page shape: old brush marks no longer line up
  W = H = 0;
  setCamState('review');
  requestTrace();
}
$('cropDone').addEventListener('click', () => leaveCrop(true));
$('cropAuto').addEventListener('click', () => { manualQuad = null; leaveCrop(false); });

/* ---------- camera stream ---------- */
async function openStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ audio:false,
    video:{ facingMode:{ ideal:facing }, width:{ ideal:3840 }, height:{ ideal:2160 } } });
  vid.srcObject = stream;
  await vid.play();
  if (!vid.videoWidth) await new Promise(r => vid.addEventListener('loadedmetadata', r, { once:true }));
}
async function startLive() {
  if (!window.isSecureContext) { toast('Live camera needs an https:// address (or localhost).'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('This browser doesn’t support the live camera. Choose an image instead.'); return; }
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
  if (!camOpen) { stopLive(true); return; }   // closed while the camera was still opening: let it go
  live = true; fpsT = []; frames = 0; W = H = 0;
  setCamState('live'); wake();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  setTimeout(() => {                 // camera granted but no picture arriving
    if (live && !frames) { $('camWait').textContent = 'the camera opened but no picture is arriving. close and try again, or choose an image.'; vid.play().catch(() => {}); }
  }, 5000);
}
function tick() {
  if (!live) return;
  if (!busy && vid.readyState >= 2 && vid.videoWidth) sendFrame();
  raf = requestAnimationFrame(tick);
}
function stopLive(release) {
  live = false; cancelAnimationFrame(raf);
  if (release && stream) { stream.getTracks().forEach(t => t.stop()); stream = null; vid.srcObject = null; }
}

/* full-resolution still: the camera's own photo where the browser offers it
   (Android Chrome), otherwise a burst of video frames averaged together,
   dropping any frame that moved, which cuts sensor noise roughly in half */
async function grabStill() {
  const track = stream && stream.getVideoTracks()[0];
  if (track && 'ImageCapture' in window && facing === 'environment') {
    try {
      const blob = await new ImageCapture(track).takePhoto();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    } catch (e) {}
  }
  return burst(4);
}
const nextFrame = () => new Promise(r => vid.requestVideoFrameCallback ? vid.requestVideoFrameCallback(() => r()) : setTimeout(r, 40));
async function burst(n) {
  const w = vid.videoWidth, h = vid.videoHeight, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently:true });
  const grab = () => { x.save(); if (facing === 'user') { x.translate(w, 0); x.scale(-1, 1); } x.drawImage(vid, 0, 0, w, h); x.restore(); return x.getImageData(0, 0, w, h); };
  const first = grab(), fd = first.data, acc = new Uint16Array(fd.length);
  for (let i = 0; i < fd.length; i++) acc[i] = fd[i];
  let count = 1;
  for (let f = 1; f < n; f++) {
    await Promise.race([nextFrame(), new Promise(r => setTimeout(r, 120))]);
    const d = grab().data;
    let diff = 0, m = 0;
    for (let i = 0; i < d.length; i += 4 * 997) { diff += Math.abs(d[i + 1] - fd[i + 1]); m++; }
    if (diff / m > 9) continue;                 // the phone moved: skip this one
    for (let i = 0; i < d.length; i++) acc[i] += d[i];
    count++;
  }
  if (count > 1) for (let i = 0; i < fd.length; i++) fd[i] = acc[i] / count + 0.5;
  x.putImageData(first, 0, 0);
  return c;
}
async function capture() {
  if (!live || capturing || !vid.videoWidth) return;
  capturing = true;
  const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  try { navigator.vibrate?.(12); } catch (e) {}
  live = false; cancelAnimationFrame(raf);
  $('camWait').hidden = true;
  $('camRead').innerHTML = '<span class="busy-dot"></span>capturing…';
  let c = null;
  try { c = await grabStill(); } catch (e) { c = null; }
  if (!c) {
    c = document.createElement('canvas'); c.width = vid.videoWidth; c.height = vid.videoHeight;
    const x = c.getContext('2d'); if (facing === 'user') { x.translate(c.width, 0); x.scale(-1, 1); } x.drawImage(vid, 0, 0);
  }
  still = c; stillIsSample = false; manualQuad = null; W = H = 0;
  resetImageEdits(); currentId = Date.now();
  sendStill();
  setCamState('review');
  requestTrace();
  capturing = false;
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
    still = img; stillIsSample = false; manualQuad = null; W = H = 0; $('chip').hidden = true;
    resetImageEdits(); currentId = Date.now();
    S.auto = true; syncInline();
    sendStill(); requestTrace();
    closeSheet();
    if (camOpen) setCamState('review'); else if (coarse) openCam('review');
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
function stamp() { const d = new Date(), p = v => String(v).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved ' + name.split('.').pop().toUpperCase());
}
function ready() {
  if (live) { toast('Take the photo first.'); return false; }
  if (busy || queued) { toast('Still tracing. One moment.'); return false; }
  return !!lastBody;
}

/* the size written into the file. "fit" leaves it out, so phones and
   browsers scale the drawing to the screen; design apps read the same
   dimensions from the viewBox either way */
const PAPER = { letter:[215.9, 279.4], a4:[210, 297] };
function paperMM() {
  const ar = W / H, orient = ([a, b]) => ar <= 1 ? [a, b] : [b, a];
  if (S.paper !== 'auto') { const [pw, ph] = orient(PAPER[S.paper]); return ar <= pw / ph ? [ph * ar, ph] : [pw, pw / ar]; }
  if (!lastQuad) return null;                  // only a flattened page has a known size
  for (const name of ['letter', 'a4']) {
    const [pw, ph] = orient(PAPER[name]);
    if (Math.abs(ar / (pw / ph) - 1) < 0.035) return [pw, ph];
  }
  return null;
}
function buildSvg(forRaster) {
  let size = '';
  if (forRaster || S.size === 'px') size = ' width="' + W + '" height="' + H + '"';
  else if (S.size === 'real') { const mm = paperMM(); size = mm ? ' width="' + fm(mm[0]) + 'mm" height="' + fm(mm[1]) + 'mm"' : ' width="' + W + '" height="' + H + '"'; }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '"' + size + '>' + lastBody + '</svg>';
}
function svgImage(svg) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('could not draw the SVG')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
}
async function toPng(scale, maxSide) {
  const img = await svgImage(buildSvg(true));
  const k = Math.min(scale, (maxSide || 8192) / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
// a real vector PDF: the same paths, written as PDF drawing operators
function toPdf() {
  const mm = S.size === 'real' ? paperMM() : null;
  const pw = mm ? mm[0] * 72 / 25.4 : W * 0.75, ph = mm ? mm[1] * 72 / 25.4 : H * 0.75;
  const n4 = v => (Math.round(v * 1e4) / 1e4).toString();
  const rgb = hex => { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => n4(parseInt(h.slice(i, i + 2), 16) / 255)).join(' '); };
  const ops = d => {
    const t = d.match(/[MCLZ]|-?\d*\.?\d+/g) || [];
    let o = '', i = 0;
    while (i < t.length) {
      const c = t[i++];
      if (c === 'M') { o += t[i] + ' ' + t[i + 1] + ' m\n'; i += 2; }
      else if (c === 'L') { o += t[i] + ' ' + t[i + 1] + ' l\n'; i += 2; }
      else if (c === 'C') { o += t.slice(i, i + 6).join(' ') + ' c\n'; i += 6; }
      else if (c === 'Z') o += 'h\n';
      else i++;
    }
    return o;
  };
  let cs = n4(pw / W) + ' 0 0 ' + n4(-ph / H) + ' 0 ' + n4(ph) + ' cm\n';
  const re = /<(rect|path)([^>]*)\/>/g, attr = (a, k) => { const m = a.match(new RegExp(' ' + k + '="([^"]*)"')); return m ? m[1] : null; };
  let m;
  while ((m = re.exec(lastBody))) {
    const a = m[2];
    if (m[1] === 'rect') cs += rgb(attr(a, 'fill')) + ' rg 0 0 ' + attr(a, 'width') + ' ' + attr(a, 'height') + ' re f\n';
    else if (attr(a, 'fill') !== 'none') cs += rgb(attr(a, 'fill')) + ' rg\n' + ops(attr(a, 'd')) + 'f*\n';
    else cs += rgb(attr(a, 'stroke')) + ' RG ' + attr(a, 'stroke-width') + ' w 1 J 1 j\n' + ops(attr(a, 'd')) + 'S\n';
  }
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + n4(pw) + ' ' + n4(ph) + '] /Contents 4 0 R /Resources << >> >>',
    '<< /Length ' + cs.length + ' >>\nstream\n' + cs + 'endstream'];
  let pdf = '%PDF-1.4\n', offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return new Blob([pdf], { type:'application/pdf' });
}
// phones get the share sheet (Save to Files, AirDrop, Drive…); everything else downloads
async function save() {
  if (!ready()) return;
  const ext = S.format, name = 'ency-vectorcam-' + stamp() + '.' + ext;
  let blob;
  try {
    blob = ext === 'png' ? await toPng(S.pngScale) : ext === 'pdf' ? toPdf() : new Blob([buildSvg()], { type:'image/svg+xml' });
  } catch (e) { toast('Couldn’t make the ' + ext.toUpperCase() + ': ' + e.message); return; }
  if (coarse && navigator.canShare) {
    try {
      const file = new File([blob], name, { type:blob.type });
      if (navigator.canShare({ files:[file] })) { await navigator.share({ files:[file] }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(blob, name);
}
function copySvg() {
  if (!ready()) return;
  const svg = buildSvg();
  const fallback = () => { if (camOpen) { toast('Copy isn’t available here. Use save instead.'); return; } showCode(true); const c = $('code'); c.focus(); c.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} toast(ok ? 'SVG copied' : 'Code selected. Copy it from the box below.'); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(svg).then(() => toast('SVG copied'), fallback);
  else fallback();
}
function updateSaveLabels() {
  const t = S.format.toUpperCase();
  $('dlBtn').textContent = 'download ' + t;
  $('camSave').lastChild.textContent = 'save ' + t.toLowerCase();
}
$('dlBtn').addEventListener('click', save);
$('camSave').addEventListener('click', save);
$('copyBtn').addEventListener('click', copySvg);
$('camCopy').addEventListener('click', copySvg);
function showCode(open) { const c = $('code'); c.hidden = !open; $('codeBtn').textContent = open ? 'hide code' : 'show code'; $('codeBtn').setAttribute('aria-expanded', open); if (open) c.value = lastSvg; }
$('codeBtn').addEventListener('click', () => showCode($('code').hidden));


/* ---------- palette: tap a colour to recolour or remove it ---------- */
function renderPalette() {
  const row = $('palRow');
  if (!lastPalette) { row.innerHTML = '<span class="dial-name">switch to color to see the palette</span>'; return; }
  let h = lastPalette.map(p => '<button type="button" class="psw' + (p.drop ? ' drop' : '') + (p.r === selPal ? ' sel' : '') + '" data-r="' + p.r + '" style="background:' + p.hex + '" aria-label="Color ' + (p.r + 1) + '"></button>').join('');
  if (live) h += '<span class="dial-name">edit colors after you take the photo</span>';
  else {
    const p = selPal >= 0 && lastPalette[selPal];
    if (p) h += '<button type="button" class="pact" data-a="recolor">recolor</button><button type="button" class="pact" data-a="drop">' + (p.drop ? 'bring back' : 'remove') + '</button>';
    if (Object.keys(pal).length) h += '<button type="button" class="pact" data-a="reset">reset</button>';
  }
  row.innerHTML = h;
}
$('palRow').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || live) return;
  if (b.dataset.r !== undefined) { selPal = selPal === +b.dataset.r ? -1 : +b.dataset.r; renderPalette(); buzz(); return; }
  const a = b.dataset.a;
  if (a === 'reset') { pal = {}; palK = 0; selPal = -1; }
  else if (a === 'drop') { palK = lastK; const ed = pal[selPal] || (pal[selPal] = {}); ed.drop = !ed.drop; }
  else if (a === 'recolor') { const p = lastPalette[selPal]; $('palPick').value = /^#[0-9a-f]{6}$/i.test(p.hex) ? p.hex : '#000000'; $('palPick').click(); return; }
  renderPalette(); requestTrace();
});
$('palPick').addEventListener('input', e => { if (selPal < 0) return; palK = lastK; (pal[selPal] || (pal[selPal] = {})).hex = e.target.value; requestTrace(); });

/* ---------- refine: paint to erase marks or keep ink, with undo ---------- */
const brushCv = $('brushCv'), bctx = brushCv.getContext('2d');
const BRUSHES = [0.015, 0.035, 0.07];
let tool = 'erase', painting = null;
function enterRefine() {
  if (!still || live) return;
  cam.dataset.state = 'refine'; cam.classList.remove('bare');
  brushCv.hidden = false;
  fitStage(); sizeBrushCv(); drawBrush(); updateRefineUI();
}
function leaveRefine() { brushCv.hidden = true; painting = null; setCamState('review'); }
function sizeBrushCv() {
  const r = stage.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
  brushCv.width = Math.max(1, Math.round(r.width * d)); brushCv.height = Math.max(1, Math.round(r.height * d));
}
function drawBrush() {
  const w = brushCv.width, h = brushCv.height, D = Math.max(w, h);
  bctx.clearRect(0, 0, w, h); bctx.lineCap = bctx.lineJoin = 'round';
  for (const st of painting ? strokes.concat([painting]) : strokes) {
    bctx.strokeStyle = st.m === 'add' ? 'rgba(110,190,255,.5)' : 'rgba(208,138,138,.55)';
    bctx.lineWidth = st.r * 2 * D;
    bctx.beginPath();
    st.pts.forEach((p, i) => i ? bctx.lineTo(p[0] * w, p[1] * h) : bctx.moveTo(p[0] * w, p[1] * h));
    if (st.pts.length === 1) bctx.lineTo(st.pts[0][0] * w + 0.01, st.pts[0][1] * h);
    bctx.stroke();
  }
}
function updateRefineUI() {
  $('toolBtn').textContent = tool === 'erase' ? 'erase' : 'keep';
  $('sizeBtn').textContent = ['S', 'M', 'L'][Math.max(0, BRUSHES.indexOf(S.brush))] || 'M';
  $('undoBtn').disabled = !strokes.length; $('redoBtn').disabled = !redoStack.length;
  $('undoBtn').style.opacity = strokes.length ? 1 : .35; $('redoBtn').style.opacity = redoStack.length ? 1 : .35;
  $('refineTip').textContent = tool === 'erase' ? 'paint over what to remove' : 'paint over what should stay ink';
}
const bpt = e => { const r = brushCv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
brushCv.addEventListener('pointerdown', e => {
  e.preventDefault(); brushCv.setPointerCapture(e.pointerId);
  painting = { m:tool, r:S.brush, pts:[bpt(e)] }; drawBrush();
});
brushCv.addEventListener('pointermove', e => {
  if (!painting) return;
  const p = bpt(e), q = painting.pts[painting.pts.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.003) return;
  painting.pts.push(p); drawBrush();
});
const paintEnd = () => {
  if (!painting) return;
  strokes.push({ m:painting.m, r:painting.r, pts:painting.pts.map(p => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]) });
  redoStack = []; painting = null;
  drawBrush(); updateRefineUI(); requestTrace();
};
brushCv.addEventListener('pointerup', paintEnd); brushCv.addEventListener('pointercancel', paintEnd);
function undo() { if (!strokes.length) return; redoStack.push(strokes.pop()); drawBrush(); updateRefineUI(); requestTrace(); buzz(); }
function redo() { if (!redoStack.length) return; strokes.push(redoStack.pop()); drawBrush(); updateRefineUI(); requestTrace(); buzz(); }
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('toolBtn').addEventListener('click', () => { tool = tool === 'erase' ? 'add' : 'erase'; updateRefineUI(); buzz(); });
$('sizeBtn').addEventListener('click', () => { setParam('brush', BRUSHES[(Math.max(0, BRUSHES.indexOf(S.brush)) + 1) % BRUSHES.length]); updateRefineUI(); });
$('refineDone').addEventListener('click', leaveRefine);

/* ---------- settings sheet ---------- */
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone) document.documentElement.classList.add('app');
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (sheetMode === 'settings') renderSettings(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/tools/vectorcam-sw.js', { scope:'/tools/vectorcam' }).catch(() => {});

// [group, [key, label, options, shown-when, note]]
const SETTINGS = [
  ['tracing', [
    ['style', 'trace shapes as', [['fill', 'filled shapes'], ['line', 'center lines']], null, 'Center lines turn pen and marker drawings into single strokes you can restyle.'],
    ['lineW', 'line width', [[0, 'match drawing'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']], () => S.style === 'line'],
    ['snap', 'snap to perfect shapes', [[0, 'off'], [1, 'gentle'], [2, 'strong']], null, 'Near-circles become true ellipses; straight-sided shapes square up to each other and the page.'],
    ['fine', 'fine detail', [[false, 'off'], [true, 'trace at 2×']], null, 'Small images and thin lines come out crisper. Slower.'],
  ]],
  ['color', [
    ['autoColors', 'number of colors', [[true, 'automatic'], [false, 'set with the dial']], null, 'Automatic picks how many colors the picture really has.'],
    ['layering', 'color layers', [['stack', 'stacked'], ['cut', 'cut out']], null, 'Stacked never shows gaps. Cut out gives every color its own shape, with nothing hidden underneath.'],
  ]],
  ['export', [
    ['format', 'file type', [['svg', 'SVG'], ['png', 'PNG'], ['pdf', 'PDF']]],
    ['size', 'size written in the file', [['fit', 'fit to screen'], ['px', 'pixels'], ['real', 'real size']], null, 'Fit lets phones show the whole drawing. Real size uses millimetres for a flattened Letter or A4 page.'],
    ['paper', 'page', [['auto', 'detect'], ['letter', 'letter'], ['a4', 'A4']], () => S.size === 'real'],
    ['pngScale', 'PNG resolution', [[1, '1×'], [2, '2×'], [4, '4×']], () => S.format === 'png'],
  ]],
  ['refine', [
    ['brush', 'brush size', [[0.015, 'small'], [0.035, 'medium'], [0.07, 'large']]],
  ]],
  ['library', [
    ['history', 'keep a history', [[true, 'on'], [false, 'off']], null, 'Saved only on this device.'],
    ['historyMax', 'keep the last', [[10, '10'], [30, '30'], [100, '100']], () => S.history],
  ]],
  ['app', [
    ['autoCam', 'open straight to the camera', [[true, 'on'], [false, 'off']], () => standalone],
  ]],
];
let sheetMode = null;
function openSheet(mode) { sheetMode = mode; $('sheetTitle').textContent = mode; $('sheet').hidden = false; if (mode === 'settings') renderSettings(); else renderLibrary(); }
function closeSheet() { $('sheet').hidden = true; sheetMode = null; }
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });
$('sheetClose').addEventListener('click', closeSheet);
function renderSettings() {
  let h = '';
  for (const [g, rows] of SETTINGS) {
    let inner = '';
    for (const [k, label, opts, when, note] of rows) {
      if (when && !when()) continue;
      inner += '<div class="set-row"><span>' + label + '</span><div class="opts" data-k="' + k + '">' +
        opts.map(([v, t], i) => '<button type="button" data-i="' + i + '" aria-pressed="' + (S[k] === v) + '">' + t + '</button>').join('') +
        '</div>' + (note ? '<small>' + note + '</small>' : '') + '</div>';
    }
    if (g === 'app') inner += installHtml();
    if (inner) h += '<div class="set-group"><h3>' + g + '</h3>' + inner + '</div>';
  }
  $('sheetBody').innerHTML = h;
}
function installHtml() {
  if (standalone) return '<div class="set-row"><small>Vector Cam is installed and running as an app.</small></div>';
  if (installEvt) return '<button type="button" class="sheet-btn" id="installBtn">install vector cam</button><small>Opens full screen from your home screen and works offline.</small>';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return '<div class="set-row"><span>install as an app</span><small>' + (ios
    ? 'In Safari, tap Share, then Add to Home Screen. It opens full screen with no browser bars, and works offline.'
    : 'In your browser menu choose Install app or Add to Home Screen. It opens full screen and works offline.') + '</small></div>';
}
$('sheetBody').addEventListener('click', async e => {
  const b = e.target.closest('button, [data-id]'); if (!b) return;
  const o = b.closest('.opts');
  if (o) {
    const k = o.dataset.k, row = SETTINGS.flatMap(g => g[1]).find(r => r[0] === k);
    setParam(k, row[2][+b.dataset.i][0]);
    renderSettings();
    if (camOpen) { buildChips(); select(active); if (cam.dataset.state === 'refine') updateRefineUI(); }
    return;
  }
  if (b.id === 'installBtn' && installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (err) {} installEvt = null; renderSettings(); return; }
  if (b.dataset.del) { e.stopPropagation(); await dbDel(+b.dataset.del); renderLibrary(); return; }
  if (b.dataset.clear) { await dbClear(); renderLibrary(); return; }
  if (b.dataset.id) loadItem(+b.dataset.id);
});
$('setBtn').addEventListener('click', () => openSheet('settings'));
$('camSetBtn').addEventListener('click', () => openSheet('settings'));
$('libBtn').addEventListener('click', () => openSheet('library'));
$('camLibBtn').addEventListener('click', () => openSheet('library'));

/* ---------- library: recent captures, kept on this device ---------- */
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open('vectorcam', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('captures', { keyPath:'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function dbDo(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('captures', mode), q = fn(t.objectStore('captures')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
}
const dbAll = async () => ((await dbDo('readonly', st => st.getAll())) || []).sort((a, b) => b.t - a.t);
const dbPut = item => dbDo('readwrite', st => st.put(item));
const dbDel = id => dbDo('readwrite', st => st.delete(id));
const dbClear = () => dbDo('readwrite', st => st.clear());
const dbGet = id => dbDo('readonly', st => st.get(id));
let histT = 0, srcCache = null;
function queueHistory() { if (!S.history || !currentId || stillIsSample) return; clearTimeout(histT); histT = setTimeout(saveHistory, 1200); }
async function saveHistory() {
  if (busy || queued || live || !lastBody || !currentId) return;
  try {
    const id = currentId;
    const img = await svgImage(buildSvg(true));
    const k = Math.min(1, 240 / Math.max(W, H)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
    const x = c.getContext('2d'); x.fillStyle = '#d4d4d4'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
    const thumb = c.toDataURL('image/jpeg', 0.8);
    if (!srcCache || srcCache.id !== id) {
      const [sw, sh] = dims(still), kk = Math.min(1, 1600 / Math.max(sw, sh)), sc = document.createElement('canvas');
      sc.width = Math.round(sw * kk); sc.height = Math.round(sh * kk);
      const sx = sc.getContext('2d'); sx.fillStyle = '#fff'; sx.fillRect(0, 0, sc.width, sc.height); sx.drawImage(still, 0, 0, sc.width, sc.height);
      srcCache = { id, blob:await new Promise(r => sc.toBlob(r, 'image/jpeg', 0.88)) };
    }
    if (id !== currentId) return;
    await dbPut({ id, t:Date.now(), thumb, src:srcCache.blob, settings:traceSettings(), quad:manualQuad, W, H });
    const all = await dbAll();
    for (const old of all.slice(S.historyMax)) await dbDel(old.id);
  } catch (e) { /* storage full or blocked: the library is a convenience */ }
}
async function renderLibrary() {
  let h = '<div class="set-group"><label class="sheet-btn" for="fileIn">choose from photos</label></div>';
  let items = [];
  try { items = await dbAll(); } catch (e) {}
  h += '<div class="set-group"><h3>recent' + (S.history ? '' : ' · history is off in settings') + '</h3>';
  if (!items.length) h += '<div class="lib-empty">Captures you take or open show up here.</div>';
  else {
    h += '<div class="lib-grid">' + items.map(it => '<div class="lib-item" role="button" tabindex="0" data-id="' + it.id + '"><img src="' + it.thumb + '" alt=""><span>' +
      new Date(it.t).toLocaleDateString(undefined, { month:'short', day:'numeric' }) + ' · ' + new Date(it.t).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' }) +
      '</span><button type="button" class="lib-del" data-del="' + it.id + '" aria-label="Delete">×</button></div>').join('') + '</div>';
    h += '<button type="button" class="sheet-btn ghost" data-clear="1">clear history</button>';
  }
  h += '</div>';
  if (sheetMode === 'library') $('sheetBody').innerHTML = h;
}
async function loadItem(id) {
  try {
    const it = await dbGet(id); if (!it) return;
    const bmp = await createImageBitmap(it.src);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
    stopLive(true);
    still = c; stillIsSample = false; currentId = it.id; srcCache = { id:it.id, blob:it.src };
    for (const k of SAVED) if (!NO_TRACE.has(k) && it.settings && k in it.settings && typeof it.settings[k] === typeof S[k]) S[k] = it.settings[k];
    strokes = (it.settings && it.settings.strokes) || []; redoStack = [];
    pal = (it.settings && it.settings.pal) || {}; palK = (it.settings && it.settings.palK) || 0; selPal = -1;
    manualQuad = it.quad || null; W = H = 0; $('chip').hidden = true;
    syncInline(); sendStill(); requestTrace(); closeSheet();
    if (camOpen) setCamState('review'); else if (coarse) openCam('review');
  } catch (e) { toast('Couldn’t open that capture.'); }
}

/* ---------- sample photo shown before the camera starts ---------- */
function sample() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 640; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 900, 640); g.addColorStop(0, '#ece6d8'); g.addColorStop(1, '#c9c1ae'); x.fillStyle = g; x.fillRect(0, 0, 900, 640);
  x.fillStyle = '#e2672b'; x.beginPath(); x.arc(640, 190, 82, 0, Math.PI * 2); x.fill();
  for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; x.save(); x.translate(640, 190); x.rotate(a); x.beginPath(); x.moveTo(100, -9); x.lineTo(150, 0); x.lineTo(100, 9); x.fill(); x.restore(); }
  x.fillStyle = '#3f8a7d'; x.beginPath(); x.moveTo(0, 470); x.lineTo(170, 270); x.lineTo(280, 380); x.lineTo(410, 230); x.lineTo(600, 450); x.lineTo(900, 330); x.lineTo(900, 640); x.lineTo(0, 640); x.fill();
  x.fillStyle = '#1f4249'; x.beginPath(); x.moveTo(0, 560); x.bezierCurveTo(200, 430, 330, 520, 480, 470); x.bezierCurveTo(640, 420, 760, 520, 900, 470); x.lineTo(900, 640); x.lineTo(0, 640); x.fill();
  x.save(); x.translate(450, 610); x.rotate(-0.025); x.fillStyle = '#141414'; x.font = '900 128px Impact, "Arial Black", sans-serif'; x.textAlign = 'center'; x.fillText('FIELD NOTES', 0, 0); x.restore();
  x.strokeStyle = '#141414'; x.lineWidth = 7; x.lineCap = 'round';
  x.beginPath(); x.moveTo(90, 120); x.quadraticCurveTo(140, 70, 190, 120); x.quadraticCurveTo(240, 70, 290, 120); x.stroke();
  const v = x.createRadialGradient(450, 320, 200, 450, 320, 620); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(40,30,10,.28)'); x.fillStyle = v; x.fillRect(0, 0, 900, 640);
  const im = x.getImageData(0, 0, 900, 640), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const nz = (Math.random() - 0.5) * 26; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz; }
  x.putImageData(im, 0, 0);
  return c;
}
function useSample() { still = sample(); stillIsSample = true; manualQuad = null; W = H = 0; resetImageEdits(); currentId = 0; sendStill(); requestTrace(); }

try {
  syncInline();
  useSample();
  $('chip').hidden = false;
  document.documentElement.dataset.vc = 'ready';
  if (standalone && S.autoCam) startLive();      // the installed app opens like a camera
} catch (e) { fatal('startup: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')); }
