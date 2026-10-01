/* Vector Cam — the tracer. Runs in a worker so the camera, the dials and the
 * page never wait on it, and so a full-resolution capture can take its time.
 *
 * Pipeline, per image:
 *   1. flatten   find a sheet of paper and square it up (homography warp)
 *   2. denoise   guided filter: noise goes, edges stay
 *   3. field     adaptive: lighting gradients are mostly subtracted out, so a
 *                shadow across the page doesn't become ink
 *   4. contours  marching squares on the continuous field, so edges land
 *                between pixels instead of on the pixel grid
 *   5. fit       corners found first; each run between corners is fitted with
 *                least-squares cubic Béziers (Schneider), so corners stay
 *                sharp, curves stay smooth, and the node count stays low
 * Color mode clusters in OKLab (perceptual), cleans the region map with a
 * majority filter, and traces each stacked layer as a smoothed field.
 *
 * Messages in:  {type:'still', w, h, buf}          keep this image for retraces
 *               {type:'trace', id, s, quad}         trace the kept image
 *               {type:'frame', id, w, h, buf, s}    trace one live frame
 * Shapes can also come out as centre lines (thinning + stroke fitting) for pen
 * drawings; near-circles, near-ellipses and squared-off polygons can snap to
 * exact geometry; small images can be traced at 2× and reported at 1×; and
 * refine strokes (erase / keep, painted by the person) are applied before the
 * outline is found.
 *
 * Message out:  {id, kind, W, H, body, paths, nodes, autoThr, ms, anchors,
 *                preview?, quad?, palette?, k?, strokeW?}  or {id, kind, error} */
'use strict';

const REF = 900;          // slider values are tuned at this size; others scale
let still = null;
let liveQuad = null, liveMiss = 0, prevC = null, liveK = 0, liveFrame = 0;
let OS = 1;               // output scale: 0.5 while tracing a 2× upscale

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'still') { still = { w:m.w, h:m.h, data:new Uint8ClampedArray(m.buf) }; prevC = null; return; }
    const img = m.type === 'frame' ? { w:m.w, h:m.h, data:new Uint8ClampedArray(m.buf) } : still;
    if (!img) { postMessage({ id:m.id, kind:m.type, error:'no image to trace yet' }); return; }
    const r = trace(img, m.s, m.type === 'frame', m.quad || null);
    r.id = m.id; r.kind = m.type;
    const tr = [r.anchors.buffer];
    if (r.preview) tr.push(r.preview.buffer);
    postMessage(r, tr);
  } catch (err) {
    postMessage({ id:m.id, kind:m.type, error:(err && err.message) + ' ' + String((err && err.stack) || '').split('\n').slice(0, 2).join(' ') });
  }
};

/* ------------------------------------------------------------------ main */
function trace(img, S, live, manualQuad) {
  const t0 = performance.now();
  let { w, h, data } = img, quad = null, preview = null;

  if (S.flatten) {
    quad = manualQuad || detectQuad(data, w, h);
    if (live && !manualQuad) quad = smoothQuad(quad);
    if (quad) { const o = warp(data, w, h, quad); data = o.data; w = o.w; h = o.h; preview = data; }
  } else liveQuad = null;

  const W0 = w, H0 = h;
  // fine detail: trace small images at twice the size, report at the original
  OS = 1;
  if (S.fine && !live && Math.max(w, h) <= 1800) { const u = upscale(data, w, h); data = u.data; w = u.w; h = u.h; OS = 0.5; }
  const edits = S.strokes && S.strokes.length ? rasterStrokes(S.strokes, w, h) : null;

  const sc = Math.max(w, h) / REF;
  const anchors = S.anchors ? [] : null;
  let body = '', paths = 0, nodes = 0, autoThr = 0, palette = null, k = 0, strokeW = 0;

  if (S.mode === 'shapes') {
    const n = w * h;
    let L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3] / 255;
      L[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) * a + 255 * (1 - a);
    }
    if (S.denoise > 0) {
      const sig = noiseSigma(L, w, h), kk = S.denoise / 3;
      const r = Math.max(1, Math.round((1 + S.denoise / 4 + sig / 12) * Math.max(sc, 0.4)));
      L = guided(L, w, h, r, (kk * Math.max(6, 3 * sig)) ** 2);
    }
    if (S.adaptive) L = flattenLighting(L, w, h);
    autoThr = otsu(L);
    const t = (S.auto ? autoThr : S.thr) + 0.5;   // otsu splits at "<= t"; the field is strict
    const sf = new Float32Array(n);
    if (S.invert) for (let i = 0; i < n; i++) sf[i] = L[i] - t;
    else for (let i = 0; i < n; i++) sf[i] = t - L[i];
    if (edits) for (let i = 0; i < n; i++) if (edits[i]) sf[i] = edits[i] > 0 ? 80 : -80;
    if (S.style === 'line') {
      const r = lineTrace(sf, w, h, S, sc, anchors);
      body = r.body; paths = r.d ? 1 : 0; nodes = r.nodes; strokeW = r.strokeW * OS;
    } else {
      // a hard step (crisp logo, screenshot) leaves no sub-pixel information;
      // a 3×3 average turns it into a ramp so the edge lands where it really is
      const r = fitLoops(contours(boxBlur(sf, w, h, 1), w, h), S, sc, anchors);
      if (r.d) { body = '<path fill="' + S.fill + '" fill-rule="evenodd" d="' + r.d + '"/>'; paths = 1; }
      nodes = r.nodes;
    }
  } else {
    const res = colorLayers(data, w, h, S, sc, live, anchors, edits);
    body = res.body; paths = res.paths; nodes = res.nodes; palette = res.palette; k = res.k;
  }

  const an = new Float32Array(anchors ? anchors.length : 0);
  if (anchors) for (let i = 0; i < anchors.length; i++) an[i] = anchors[i] * OS;
  OS = 1;
  return { W:W0, H:H0, body, paths, nodes, autoThr, ms:performance.now() - t0, anchors:an, preview, quad, palette, k, strokeW };
}

// bilinear 2× enlargement, so thin strokes and small text get more contour to work with
function upscale(d, w, h) {
  const W2 = w * 2, H2 = h * 2, out = new Uint8ClampedArray(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) {
    const sy = Math.max(0, Math.min(h - 1.001, (y + 0.5) / 2 - 0.5)), y0 = sy | 0, fy = sy - y0;
    for (let x = 0; x < W2; x++) {
      const sx = Math.max(0, Math.min(w - 1.001, (x + 0.5) / 2 - 0.5)), x0 = sx | 0, fx = sx - x0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4, o = (y * W2 + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = (d[i00 + c] * (1 - fx) + d[i10 + c] * fx) * (1 - fy) + (d[i01 + c] * (1 - fx) + d[i11 + c] * fx) * fy;
    }
  }
  return { data:out, w:W2, h:H2 };
}

// refine strokes, painted in normalised coordinates: +1 keep as ink, -1 erase
function rasterStrokes(strokes, w, h) {
  const m = new Int8Array(w * h), D = Math.max(w, h);
  for (const st of strokes) {
    const v = st.m === 'add' ? 1 : -1, r = Math.max(1, st.r * D), r2 = r * r;
    const P = st.pts.map(p => [p[0] * w, p[1] * h]);
    const stamp = (cx, cy) => {
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) m[y * w + x] = v;
    };
    if (P.length === 1) stamp(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) {
      const [ax, ay] = P[i - 1], [bx, by] = P[i], L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / (r * 0.4)));
      for (let k = 0; k <= steps; k++) stamp(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps);
    }
  }
  return m;
}

/* ------------------------------------------------------------- filtering */
// separable box filter with running sums, row-major in both passes so it
// stays in cache; edges average over what exists
function boxBlur(src, w, h, r, out) {
  const n = w * h, tmp = new Float32Array(n);
  out = out || new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let sum = 0, a = 0, b = -1;
    for (let x = 0; x < w; x++) {
      const na = x - r > 0 ? x - r : 0, nb = x + r < w - 1 ? x + r : w - 1;
      while (b < nb) sum += src[o + (++b)];
      while (a < na) sum -= src[o + (a++)];
      tmp[o + x] = sum / (b - a + 1);
    }
  }
  const cs = new Float64Array(w);
  let a = 0, b = -1;
  for (let y = 0; y < h; y++) {
    const na = y - r > 0 ? y - r : 0, nb = y + r < h - 1 ? y + r : h - 1;
    while (b < nb) { b++; const o = b * w; for (let x = 0; x < w; x++) cs[x] += tmp[o + x]; }
    while (a < na) { const o = a * w; for (let x = 0; x < w; x++) cs[x] -= tmp[o + x]; a++; }
    const inv = 1 / (b - a + 1), o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = cs[x] * inv;
  }
  return out;
}

// sensor noise estimate: median absolute difference from the 4-neighbour mean
function noiseSigma(L, w, h) {
  const v = [], step = Math.max(1, Math.round(Math.sqrt(w * h / 20000)));
  for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
    const i = y * w + x;
    v.push(Math.abs(L[i] - (L[i - 1] + L[i + 1] + L[i - w] + L[i + w]) / 4));
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1] * 1.4826 / 1.118;
}
// He et al. guided filter, self-guided: flattens noise, keeps strong edges
function guided(I, w, h, r, eps) {
  const n = w * h;
  const mI = boxBlur(I, w, h, r);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const mII = boxBlur(II, w, h, r);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i], a = v / (v + eps);
    II[i] = a; mII[i] = mI[i] - a * mI[i];
  }
  const ma = boxBlur(II, w, h, r, mI);
  const mb = boxBlur(mII, w, h, r, II);
  const q = mII;
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

function otsu(l) {
  const hist = new Float64Array(256), N = l.length;
  for (let i = 0; i < N; i++) { const v = l[i]; hist[v <= 0 ? 0 : v >= 255 ? 255 : v | 0]++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  // between-class variance per split; a clean two-tone image has a flat top,
  // so take the middle of the best range, not its first step
  const V = new Float64Array(256);
  let sB = 0, wB = 0, best = -1;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sB += i * hist[i];
    const m1 = sB / wB, m2 = (sum - sB) / wF;
    V[i] = wB * wF * (m1 - m2) ** 2;
    if (V[i] > best) best = V[i];
  }
  if (best <= 0) return 128;
  let lo = -1, hi = -1;
  for (let i = 0; i < 256; i++) if (V[i] >= best * 0.999) { if (lo < 0) lo = i; hi = i; }
  return Math.round((lo + hi) / 2);
}

/* Uneven light (a shadow across the page, a lamp on one side) is a slow
 * gradient over the paper. Fit a smooth cubic surface to the paper pixels
 * only — ink never pulls on it, so solid shapes stay solid — then divide it
 * out, so the page reads as evenly lit before thresholding. */
function flattenLighting(L, w, h) {
  const n = w * h, t0 = otsu(L);
  const step = Math.max(1, Math.round(Math.sqrt(n / 6000)));
  const basis = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  let coef = null, cut = t0;
  for (let pass = 0; pass < 3; pass++) {
    const A = Array.from({ length:10 }, () => new Float64Array(10)), b = new Float64Array(10);
    let cnt = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = y * w + x, v = L[i];
      const ref = coef ? evalPoly(coef, basis(x / w - 0.5, y / h - 0.5)) * 0.82 : cut;
      if (v <= ref) continue;
      const f = basis(x / w - 0.5, y / h - 0.5);
      for (let r = 0; r < 10; r++) { b[r] += f[r] * v; for (let c = r; c < 10; c++) A[r][c] += f[r] * f[c]; }
      cnt++;
    }
    if (cnt < 60) return L;
    for (let r = 0; r < 10; r++) { for (let c = 0; c < r; c++) A[r][c] = A[c][r]; A[r][r] += 1e-6 * cnt; }
    coef = solve(A, b);
    if (!coef) return L;
  }
  const out = new Float32Array(n), c = coef;
  for (let y = 0; y < h; y++) {
    const v = y / h - 0.5, v2 = v * v;
    // the cubic collapsed to a polynomial in u for this row
    const A0 = c[0] + c[2] * v + c[5] * v2 + c[9] * v2 * v, A1 = c[1] + c[4] * v + c[8] * v2, A2 = c[3] + c[7] * v, A3 = c[6];
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const u = x / w - 0.5, bg = A0 + u * (A1 + u * (A2 + u * A3));
      const q = L[o + x] / (bg > 30 ? bg : 30) * 235;
      out[o + x] = q < 255 ? q : 255;
    }
  }
  return out;
}
function evalPoly(c, f) { let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * f[i]; return s; }
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => Array.from(r).concat(b[i]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/* ------------------------------------------------- contours (sub-pixel)
 * Marching squares over pixel centres. Ink is s > 0; outside the image counts
 * as paper, so every contour closes. Each segment runs with ink on the same
 * side, so the loops come out consistently wound. Saddles are resolved by the
 * cell's centre value. */
function contours(s, w, h) {
  const GW = w + 2, GH = h + 2;
  const pos = new Uint8Array(GW * GH);
  for (let y = 0; y < h; y++) {
    const o = (y + 1) * GW + 1, so = y * w;
    for (let x = 0; x < w; x++) pos[o + x] = s[so + x] > 0 ? 1 : 0;
  }
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : s[y * w + x];
  const idx = new Map(), next = [], px = [], py = [];
  const hId = (x, y) => 2 * ((y + 1) * GW + (x + 1));
  const vId = (x, y) => 2 * ((y + 1) * GW + (x + 1)) + 1;
  const point = (e, x, y, horiz) => {
    const a = val(x, y), b = horiz ? val(x + 1, y) : val(x, y + 1), t = a / (a - b);
    return horiz ? [x + t + 0.5, y + 0.5] : [x + 0.5, y + t + 0.5];
  };
  const add = (p, pe, q) => {
    if (idx.has(p)) return;
    idx.set(p, next.length); next.push(q);
    const pt = point(p, pe[0], pe[1], pe[2]);
    px.push(Math.min(w, Math.max(0, pt[0]))); py.push(Math.min(h, Math.max(0, pt[1])));
  };
  const cr = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let y = -1; y < h; y++) {
    const r0 = (y + 1) * GW, r1 = (y + 2) * GW;
    for (let x = -1; x < w; x++) {
      const tl = pos[r0 + x + 1], tr = pos[r0 + x + 2], br = pos[r1 + x + 2], bl = pos[r1 + x + 1];
      const c = tl | tr << 1 | br << 2 | bl << 3;
      if (c === 0 || c === 15) continue;
      // clockwise: top (tl→tr), right (tr→br), bottom (br→bl), left (bl→tl)
      let k = 0;
      if (tl !== tr) { const q = cr[k++]; q[0] = hId(x, y);     q[1] = tr ? 1 : -1; q[2] = x;     q[3] = y;     q.h = true;  q.ex = x; q.ey = y; }
      if (tr !== br) { const q = cr[k++]; q[0] = vId(x + 1, y); q[1] = br ? 1 : -1; q.h = false; q.ex = x + 1; q.ey = y; }
      if (br !== bl) { const q = cr[k++]; q[0] = hId(x, y + 1); q[1] = bl ? 1 : -1; q.h = true;  q.ex = x; q.ey = y + 1; }
      if (bl !== tl) { const q = cr[k++]; q[0] = vId(x, y);     q[1] = tl ? 1 : -1; q.h = false; q.ex = x; q.ey = y; }
      if (k === 2) {
        const a = cr[0][1] > 0 ? cr[0] : cr[1], b = a === cr[0] ? cr[1] : cr[0];
        add(a[0], [a.ex, a.ey, a.h], b[0]);
      } else {
        const centre = val(x, y) + val(x + 1, y) + val(x + 1, y + 1) + val(x, y + 1) > 0;
        for (let i = 0; i < 4; i++) {
          if (cr[i][1] < 0) continue;
          const b = cr[(i + (centre ? 3 : 1)) % 4];
          add(cr[i][0], [cr[i].ex, cr[i].ey, cr[i].h], b[0]);
        }
      }
    }
  }
  const loops = [], used = new Uint8Array(next.length);
  for (const i0 of idx.values()) {
    if (used[i0]) continue;
    const xs = [], ys = [];
    let i = i0, guard = 0;
    while (i !== undefined && !used[i] && guard++ < 8e6) {
      used[i] = 1; xs.push(px[i]); ys.push(py[i]);
      i = idx.get(next[i]);
    }
    if (xs.length >= 3) loops.push([xs, ys]);
  }
  return loops;
}

/* ------------------------------------------------------------ curve fit */
function area(xs, ys) {
  let a = 0;
  for (let i = 0, n = xs.length, j = n - 1; i < n; j = i++) a += xs[j] * ys[i] - xs[i] * ys[j];
  return Math.abs(a / 2);
}
const fm = v => String(Math.round(v * OS * 10) / 10);

function fitParams(S, sc) {
  const s = Math.max(sc, 0.35);
  return {
    s,
    minA: Math.max(0.5, S.speck * sc * sc),
    tol: Math.max(0.12, (11 - S.detail) * 0.2 * s),
    sigma: S.smooth * 0.55 * s,
    // corners: 10 = anything sharper than 25° is a corner, 1 = only near-right angles
    cornerRad: (20 + (10 - S.corner) * 7) * Math.PI / 180,
    win: Math.max(5, Math.round(6 * s)),
    snap: S.snap | 0,
  };
}
function emit(beziers, closed, anchors) {
  let d = 'M' + fm(beziers[0][0][0]) + ' ' + fm(beziers[0][0][1]);
  for (const b of beziers) {
    d += 'C' + fm(b[1][0]) + ' ' + fm(b[1][1]) + ' ' + fm(b[2][0]) + ' ' + fm(b[2][1]) + ' ' + fm(b[3][0]) + ' ' + fm(b[3][1]);
    if (anchors && anchors.length < 12000) anchors.push(b[0][0], b[0][1]);
  }
  if (!closed && anchors && anchors.length < 12000) { const b = beziers[beziers.length - 1]; anchors.push(b[3][0], b[3][1]); }
  return d + (closed ? 'Z' : '');
}
function emitPoly(P, closed, anchors) {
  let d = 'M' + fm(P[0][0]) + ' ' + fm(P[0][1]);
  for (let i = 1; i < P.length; i++) d += 'L' + fm(P[i][0]) + ' ' + fm(P[i][1]);
  if (anchors) for (const p of P) if (anchors.length < 12000) anchors.push(p[0], p[1]);
  return d + (closed ? 'Z' : '');
}

function fitLoops(loops, S, sc, anchors) {
  const prm = fitParams(S, sc);
  let d = '', nodes = 0;
  for (const [xs, ys] of loops) {
    if (area(xs, ys) < prm.minA) continue;
    const r = fitClosed(xs, ys, S, prm, anchors);
    if (r) { d += r.d; nodes += r.nodes; }
  }
  return { d, nodes };
}

function fitClosed(xs, ys, S, prm, anchors) {
  const { s, tol, sigma, cornerRad, win } = prm, n = xs.length;
  if (!S.curves || n < 8) {
    const [sx, sy] = smoothCyclic(xs, ys, sigma);
    const keep = simplify(sx, sy, tol * 1.5);
    if (keep.length < 3) return null;
    return { d:emitPoly(keep.map(i => [sx[i], sy[i]]), true, anchors), nodes:keep.length };
  }
  // shape snapping: a closed outline that is nearly an ellipse becomes one
  if (prm.snap) {
    const E = ellipseSnap(xs, ys, prm.snap, s);
    if (E) return { d:emit(ellipseBeziers(E), true, anchors), nodes:4 };
  }
  const corners = n >= 4 * win + 4 && S.corner > 0 ? findCorners(xs, ys, win, cornerRad) : [];
  const beziers = [];
  if (!corners.length) {
    const [sx, sy] = smoothCyclic(xs, ys, sigma);
    const P = sx.map((x, i) => [x, sy[i]]);
    const h2 = n >> 1;
    const t0 = tangentAt(P, 0), th = tangentAt(P, h2);
    fitCubic(P.slice(0, h2 + 1), t0, neg(th), tol, beziers);
    fitCubic(P.slice(h2).concat([P[0]]), th, neg(t0), tol, beziers);
  } else {
    // snap each corner to where its two edges actually meet; the traced
    // outline cuts every corner slightly, the drawing doesn't
    const cx = corners.map(i => xs[i]), cy = corners.map(i => ys[i]);
    const rr = 2 * Math.max(1, s);
    for (let c = 0; c < corners.length; c++) {
      const i = corners[c], prev = corners[(c - 1 + corners.length) % corners.length], nxt = corners[(c + 1) % corners.length];
      const gapIn = (i - prev + n) % n || n, gapOut = (nxt - i + n) % n || n;
      const m = Math.min(4 * win + 4, Math.floor(gapIn / 2), Math.floor(gapOut / 2));
      if (m < 3) continue;
      const inc = [], outp = [];
      for (let k = m; k >= 2; k--) inc.push([xs[(i - k + n) % n], ys[(i - k + n) % n]]);
      for (let k = 2; k <= m; k++) outp.push([xs[(i + k) % n], ys[(i + k) % n]]);
      const X = intersect(lineFit(inc), lineFit(outp));
      if (X && Math.hypot(X[0] - xs[i], X[1] - ys[i]) < 3 * win + 2) { cx[c] = X[0]; cy[c] = X[1]; }
    }
    const arcs = [];
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c], b = corners[(c + 1) % corners.length];
      const A = [cx[c], cy[c]], Bp = [cx[(c + 1) % corners.length], cy[(c + 1) % corners.length]];
      const arc = [A];
      for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
        if (Math.hypot(xs[i] - A[0], ys[i] - A[1]) < rr || Math.hypot(xs[i] - Bp[0], ys[i] - Bp[1]) < rr) continue;
        arc.push([xs[i], ys[i]]);
        if (arc.length > n + 1) break;
      }
      arc.push(Bp);
      arcs.push(arc);
    }
    // shape snapping: an outline made only of straight edges gets its edges
    // squared to each other and to the page, corners re-found from the lines
    if (prm.snap && arcs.length >= 3) {
      const poly = polySnap(arcs, prm.snap, s, tol);
      if (poly) return { d:emitPoly(poly, true, anchors), nodes:poly.length };
    }
    for (const arc of arcs) {
      const P = smoothOpen(arc, sigma);
      if (P.length < 2) continue;
      fitCubic(P, endTangent(P, false), endTangent(P, true), tol, beziers);
    }
  }
  if (!beziers.length) return null;
  return { d:emit(beziers, true, anchors), nodes:beziers.length };
}

/* ---------------------------------------------------------------- snapping */
// least-squares ellipse through the outline (centroid + principal axes, then
// the axis lengths solved exactly); accepted when every point is close enough
function ellipseSnap(xs, ys, level, s) {
  const n = xs.length;
  if (n < 16) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), sn = Math.sin(th);
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const U = new Float64Array(n), V = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my, u = dx * c + dy * sn, v = -dx * sn + dy * c;
    U[i] = u; V[i] = v;
    const u2 = u * u, v2 = v * v;
    a11 += u2 * u2; a12 += u2 * v2; a22 += v2 * v2; b1 += u2; b2 += v2;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  const A = (b1 * a22 - b2 * a12) / det, B = (a11 * b2 - a12 * b1) / det;
  if (!(A > 0 && B > 0)) return null;
  const ra = 1 / Math.sqrt(A), rb = 1 / Math.sqrt(B);
  if (Math.min(ra, rb) < 3 * s || Math.min(ra, rb) / Math.max(ra, rb) < 0.12) return null;
  const allow = (level >= 2 ? 0.05 : 0.022) * Math.sqrt(ra * rb) + (level >= 2 ? 1.2 : 0.6) * s;
  for (let i = 0; i < n; i++) {
    const rho = Math.sqrt(U[i] * U[i] * A + V[i] * V[i] * B);
    if (!rho) return null;
    const dist = Math.abs(rho - 1) * Math.hypot(U[i], V[i]) / rho;
    if (dist > allow) return null;
  }
  return { cx:mx, cy:my, a:ra, b:rb, th };
}
function ellipseBeziers(E) {
  const k = 0.5522847498, c = Math.cos(E.th), s = Math.sin(E.th);
  const T = (u, v) => [E.cx + u * c - v * s, E.cy + u * s + v * c];
  const a = E.a, b = E.b;
  return [
    [T(a, 0), T(a, k * b), T(k * a, b), T(0, b)],
    [T(0, b), T(-k * a, b), T(-a, k * b), T(-a, 0)],
    [T(-a, 0), T(-a, -k * b), T(-k * a, -b), T(0, -b)],
    [T(0, -b), T(k * a, -b), T(a, -k * b), T(a, 0)],
  ];
}
// every edge straight? then align edges to a shared right-angle grid (and to
// the page axes when that grid is nearly level) and rebuild the corners
function polySnap(arcs, level, s, tol) {
  const lines = [];
  for (const arc of arcs) {
    const A = arc[0], B = arc[arc.length - 1], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    if (L < 3 * s) return null;
    const allow = Math.max(tol * 2, (level >= 2 ? 0.035 : 0.015) * L + (level >= 2 ? 1.5 : 0.8) * s);
    for (const p of arc) if (Math.abs((p[0] - A[0]) * dy - (p[1] - A[1]) * dx) / L > allow) return null;
    lines.push(lineFit(arc.length >= 3 ? arc : [A, B, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]]));
  }
  const angTol = (level >= 2 ? 8 : 4) * Math.PI / 180;
  // dominant right-angle grid: mean of 4θ
  let sx = 0, sy = 0;
  for (const l of lines) { const t = Math.atan2(l[1][1], l[1][0]); sx += Math.cos(4 * t); sy += Math.sin(4 * t); }
  let g = Math.atan2(sy, sx) / 4;
  if (Math.abs(g) < angTol) g = 0;
  const snapped = lines.map(l => {
    const t = Math.atan2(l[1][1], l[1][0]);
    let best = null;
    for (let k = -4; k <= 4; k++) { const cand = g + k * Math.PI / 2; const dd = Math.abs(t - cand); if (dd < angTol && (!best || dd < best[1])) best = [cand, dd]; }
    return best ? [l[0], [Math.cos(best[0]), Math.sin(best[0])], true] : [l[0], l[1], true];
  });
  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const X = intersectAny(snapped[(i - 1 + snapped.length) % snapped.length], snapped[i]);
    const ref = arcs[i][0];
    if (!X || Math.hypot(X[0] - ref[0], X[1] - ref[1]) > 6 * s + 0.05 * Math.hypot(arcs[i][arcs[i].length - 1][0] - ref[0], arcs[i][arcs[i].length - 1][1] - ref[1])) return null;
    out.push(X);
  }
  return out;
}
function intersectAny(a, b) {
  const [p, d] = a, [q, e] = b, den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 0.05) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/* -------------------------------------------------------- line mode
 * Pen and marker drawings: thin the ink to a one-pixel skeleton, walk it into
 * strokes between ends and junctions, drop the short spurs thinning leaves,
 * then fit each stroke with Béziers. Width is the measured median stroke
 * width unless set. */
function lineTrace(sf, w, h, S, sc, anchors) {
  const n = w * h, ink = new Uint8Array(n), f = boxBlur(sf, w, h, 1);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; ink[i] = f[i] > 0 ? 1 : 0; }
  const dt = chamfer(ink, w, h);
  // a region far thicker than any pen stroke (a dark table, a filled block)
  // isn't a line: leave it out instead of thinning it for seconds
  const maxHalf = 3 * Math.max(6, 0.035 * Math.max(w, h));
  const solid = dropThick(ink, dt, w, h, maxHalf);
  const sk = thin(ink, w, h);
  let strokeW;
  if (S.lineW > 0) strokeW = S.lineW / OS;
  else {
    const v = [];
    for (let i = 0; i < n; i++) if (sk[i]) v.push(dt[i]);
    v.sort((a, b) => a - b);
    strokeW = Math.max(1, v.length ? 2 * v[v.length >> 1] / 3 - 1 : 2);
  }
  const prm = fitParams(S, sc);
  const sigma = prm.sigma + 0.8 * prm.s;          // skeletons are jaggy: always smooth a little
  const minLen = Math.max(3, Math.sqrt(prm.minA) * 1.5);
  const spur = Math.max(4, strokeW * 1.3);
  let d = '', nodes = 0;
  for (const p of skeletonPolys(sk, w, h)) {
    const len = polyLen(p.pts);
    if (len < minLen) continue;
    if (!p.closed && (p.endA !== p.endB) && len < spur) continue;    // a spur: one loose end, one at a junction
    if (p.closed) {
      const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]);
      const r = fitClosed(xs, ys, S, prm, anchors);
      if (r) { d += r.d; nodes += r.nodes; }
      continue;
    }
    const r = fitOpen(p.pts, S, prm, sigma, anchors);
    if (r) { d += r.d; nodes += r.nodes; }
  }
  let body = d ? '<path fill="none" stroke="' + S.fill + '" stroke-width="' + fm(strokeW) + '" stroke-linecap="round" stroke-linejoin="round" d="' + d + '"/>' : '';
  // solid areas stay solid: traced as filled shapes in the same drawing
  if (solid) {
    const f2 = new Float32Array(n);
    for (let i = 0; i < n; i++) f2[i] = solid[i] ? 1 : 0;
    const g = boxBlur(f2, w, h, 1);
    for (let i = 0; i < n; i++) g[i] -= 0.5;
    const r = fitLoops(contours(g, w, h), S, sc, anchors);
    if (r.d) { body = '<path fill="' + S.fill + '" fill-rule="evenodd" d="' + r.d + '"/>' + body; nodes += r.nodes; d = d || r.d; }
  }
  return { body, d, nodes, strokeW };
}
function fitOpen(P0, S, prm, sigma, anchors) {
  const { s, tol, cornerRad, win } = prm;
  let P = P0;
  if (prm.snap) {   // a nearly straight stroke becomes a line, squared to the page when close
    const A = P[0], B = P[P.length - 1], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    if (L > 4 * s) {
      const allow = (prm.snap >= 2 ? 0.03 : 0.012) * L + (prm.snap >= 2 ? 1.5 : 0.8) * s;
      if (P.every(p => Math.abs((p[0] - A[0]) * dy - (p[1] - A[1]) * dx) / L <= allow)) {
        const ln = lineFit(P), t = Math.atan2(ln[1][1], ln[1][0]), angTol = (prm.snap >= 2 ? 8 : 4) * Math.PI / 180;
        let a = t; for (let k = -2; k <= 2; k++) if (Math.abs(t - k * Math.PI / 2) < angTol) a = k * Math.PI / 2;
        const ux = Math.cos(a), uy = Math.sin(a), c = ln[0];
        const proj = p => (p[0] - c[0]) * ux + (p[1] - c[1]) * uy;
        const e0 = [c[0] + ux * proj(A), c[1] + uy * proj(A)], e1 = [c[0] + ux * proj(B), c[1] + uy * proj(B)];
        return { d:emitPoly([e0, e1], false, anchors), nodes:2 };
      }
    }
  }
  const n = P.length;
  let cuts = [0];
  if (S.curves && S.corner > 0 && n > 2 * win + 2) cuts = cuts.concat(findCornersOpen(P, win, cornerRad));
  cuts.push(n - 1);
  const beziers = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const seg = P.slice(cuts[k], cuts[k + 1] + 1);
    const Q = smoothOpen(seg, sigma);
    if (Q.length < 2) continue;
    if (!S.curves) {
      const keep = simplify(Q.map(q => q[0]), Q.map(q => q[1]), tol * 1.5);
      for (let i = 0; i < keep.length - 1; i++) { const a = Q[keep[i]], b = Q[keep[i + 1]]; beziers.push([a, a, b, b]); }
      continue;
    }
    fitCubic(Q, endTangent(Q, false), endTangent(Q, true), tol, beziers);
  }
  if (!beziers.length) return null;
  return { d:emit(beziers, false, anchors), nodes:beziers.length + 1 };
}
function findCornersOpen(P, win, thresh) {
  const n = P.length, turn = new Float32Array(n), out = [];
  for (let i = win; i < n - win; i++) {
    const ux = P[i][0] - P[i - win][0], uy = P[i][1] - P[i - win][1], vx = P[i + win][0] - P[i][0], vy = P[i + win][1] - P[i][1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    turn[i] = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
  }
  const sup = Math.round(win * 1.5);
  for (let i = win; i < n - win; i++) {
    if (turn[i] < thresh) continue;
    let ok = true;
    for (let j = Math.max(0, i - sup); j <= Math.min(n - 1, i + sup) && ok; j++) if (j !== i && (turn[j] > turn[i] || (turn[j] === turn[i] && j < i))) ok = false;
    if (ok) out.push(i);
  }
  return out;
}
function polyLen(P) { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L; }
// chamfer (3-4) distance to the nearest paper pixel, in thirds of a pixel
function chamfer(ink, w, h) {
  const n = w * h, d = new Float32Array(n), BIG = 1e9;
  for (let i = 0; i < n; i++) d[i] = ink[i] ? BIG : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    v = Math.min(v, x > 0 ? d[i - 1] + 3 : 3, y > 0 ? d[i - w] + 3 : 3, x > 0 && y > 0 ? d[i - w - 1] + 4 : 4, x < w - 1 && y > 0 ? d[i - w + 1] + 4 : 4);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    v = Math.min(v, x < w - 1 ? d[i + 1] + 3 : 3, y < h - 1 ? d[i + w] + 3 : 3, x < w - 1 && y < h - 1 ? d[i + w + 1] + 4 : 4, x > 0 && y < h - 1 ? d[i + w - 1] + 4 : 4);
    d[i] = v;
  }
  return d;
}
function dropThick(ink, dt, w, h, maxDt) {
  const n = w * h, lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let solid = null;
  for (let i = 0; i < n; i++) {
    if (!ink[i] || lab[i] >= 0) continue;
    let sp = 0, top = 0, members = [];
    stack[sp++] = i; lab[i] = i;
    while (sp) {
      const p = stack[--sp]; members.push(p); if (dt[p] > top) top = dt[p];
      const x = p % w;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) if (q >= 0 && q < n && ink[q] && lab[q] < 0) { lab[q] = i; stack[sp++] = q; }
    }
    if (top > maxDt) { if (!solid) solid = new Uint8Array(n); for (const p of members) { ink[p] = 0; solid[p] = 1; } }
  }
  return solid;
}
// Zhang–Suen thinning, iterating only over pixels that are still ink
function thin(ink, w, h) {
  const a = ink.slice();
  let list = [];
  for (let i = 0; i < a.length; i++) if (a[i]) list.push(i);
  let changed = true, guard = 0;
  while (changed && guard++ < 400) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (const i of list) {
        if (!a[i]) continue;
        const p2 = a[i - w], p3 = a[i - w + 1], p4 = a[i + 1], p5 = a[i + w + 1], p6 = a[i + w], p7 = a[i + w - 1], p8 = a[i - 1], p9 = a[i - w - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (A !== 1) continue;
        if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        del.push(i);
      }
      if (del.length) { changed = true; for (const i of del) a[i] = 0; }
    }
    if (changed) list = list.filter(i => a[i]);
  }
  return a;
}
// walk the skeleton into strokes: between ends and junctions, plus closed loops
function skeletonPolys(sk, w, h) {
  const n = w * h, ORTH = [-w, 1, w, -1], DIAG = [-w + 1, w + 1, w - 1, -w - 1];
  const around = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1];
  const cross = i => { let c = 0; for (let k = 0; k < 8; k++) if (!sk[i + around[k]] && sk[i + around[(k + 1) % 8]]) c++; return c; };
  const kind = new Uint8Array(n);      // 0 none, 1 end, 2 path, 3 junction
  for (let i = 0; i < n; i++) {
    if (!sk[i]) continue;
    const c = cross(i);
    kind[i] = c === 1 ? 1 : c === 2 ? 2 : c === 0 ? 1 : 3;
  }
  const vis = new Uint8Array(n), out = [];
  const P = i => [(i % w) + 0.5, ((i / w) | 0) + 0.5];
  // next step along a stroke: an unvisited path pixel (straight neighbours
  // first), else the end or junction pixel the stroke runs into
  const nextOf = (cur, prev) => {
    let node = -1;
    for (const o of ORTH) {
      const q = cur + o;
      if (!sk[q] || q === prev) continue;
      if (kind[q] === 2 && !vis[q]) return q;
      if (kind[q] !== 2 && node < 0) node = q;
    }
    for (const o of DIAG) {
      const q = cur + o;
      if (!sk[q] || q === prev) continue;
      let cutsCorner = false;
      for (const o2 of ORTH) if (q + o2 === prev) cutsCorner = true;
      if (cutsCorner) continue;
      if (kind[q] === 2 && !vis[q]) return q;
      if (kind[q] !== 2 && node < 0) node = q;
    }
    return node;
  };
  for (let s0 = 0; s0 < n; s0++) {
    if (!sk[s0] || kind[s0] === 2) continue;
    for (const o of ORTH.concat(DIAG)) {
      const j = s0 + o;
      if (!sk[j] || vis[j] || kind[j] !== 2) continue;
      const pts = [P(s0), P(j)];
      vis[j] = 1;
      let prev = s0, cur = j, guard = 0;
      while (kind[cur] === 2 && guard++ < n) {
        const q = nextOf(cur, prev);
        if (q < 0) break;
        pts.push(P(q));
        if (kind[q] === 2) vis[q] = 1;
        prev = cur; cur = q;
      }
      out.push({ pts, closed:false, endA:kind[s0] === 1, endB:kind[cur] === 1 });
    }
  }
  for (let s0 = 0; s0 < n; s0++) {         // what is left are clean loops
    if (!sk[s0] || vis[s0] || kind[s0] !== 2) continue;
    const pts = [P(s0)];
    vis[s0] = 1;
    let prev = -1, cur = s0, guard = 0;
    while (guard++ < n) {
      let q = -1;
      for (const o of ORTH.concat(DIAG)) { const c = cur + o; if (sk[c] && !vis[c] && c !== prev) { q = c; break; } }
      if (q < 0) break;
      vis[q] = 1; pts.push(P(q)); prev = cur; cur = q;
    }
    if (pts.length > 3) out.push({ pts, closed:true, endA:false, endB:false });
  }
  return out;
}

function findCorners(xs, ys, win, thresh) {
  const n = xs.length, turn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - win + n) % n, b = (i + win) % n;
    const ux = xs[i] - xs[a], uy = ys[i] - ys[a], vx = xs[b] - xs[i], vy = ys[b] - ys[i];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cos = (ux * vx + uy * vy) / (lu * lv);
    turn[i] = Math.acos(Math.max(-1, Math.min(1, cos)));
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < thresh) continue;
    let isMax = true;
    const sup = Math.round(win * 1.5);    // one corner, one node: no doubles a pixel apart
    for (let j = -sup; j <= sup && isMax; j++) {
      if (!j) continue;
      const k = (i + j + n) % n;
      if (turn[k] > turn[i] || (turn[k] === turn[i] && j < 0)) isMax = false;
    }
    if (isMax) out.push(i);
  }
  return out;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5)), k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  return { r, k: k.map(v => v / sum) };
}
function smoothCyclic(xs, ys, sigma) {
  if (sigma < 0.3) return [xs, ys];
  const n = xs.length, { r, k } = gaussKernel(sigma), ox = new Array(n), oy = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let j = -r; j <= r; j++) { const t = ((i + j) % n + n) % n, wgt = k[j + r]; sx += xs[t] * wgt; sy += ys[t] * wgt; }
    ox[i] = sx; oy[i] = sy;
  }
  return [ox, oy];
}
function smoothOpen(P, sigma) {
  if (sigma < 0.3 || P.length < 5) return P;
  const n = P.length, { r, k } = gaussKernel(sigma), out = new Array(n);
  out[0] = P[0]; out[n - 1] = P[n - 1];
  for (let i = 1; i < n - 1; i++) {
    const rr = Math.min(r, i, n - 1 - i);     // shrink the window near the corners so they don't move
    let sx = 0, sy = 0, ws = 0;
    for (let j = -rr; j <= rr; j++) { const wgt = k[j + r]; sx += P[i + j][0] * wgt; sy += P[i + j][1] * wgt; ws += wgt; }
    out[i] = [sx / ws, sy / ws];
  }
  return out;
}

function simplify(xs, ys, tol) {
  const n = xs.length; if (n < 5) return xs.map((_, i) => i);
  let f = 0, md = -1;
  for (let i = 1; i < n; i++) { const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2; if (d > md) { md = d; f = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[f] = 1;
  const t2 = tol * tol, st = [[0, f], [f, n]];
  while (st.length) {
    const [a, b] = st.pop(); if (b - a < 2) continue;
    const bi = b % n, ax = xs[a], ay = ys[a], dx = xs[bi] - ax, dy = ys[bi] - ay, L = dx * dx + dy * dy;
    let mx = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const qx = xs[i] - ax, qy = ys[i] - ay;
      let dd;
      if (L === 0) dd = qx * qx + qy * qy;
      else { let t = (qx * dx + qy * dy) / L; t = t < 0 ? 0 : t > 1 ? 1 : t; const ex = qx - t * dx, ey = qy - t * dy; dd = ex * ex + ey * ey; }
      if (dd > mx) { mx = dd; mi = i; }
    }
    if (mx > t2) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/* Schneider, "An Algorithm for Automatically Fitting Digitized Curves" */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const neg = a => [-a[0], -a[1]];
const unit = a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
// least-squares line through points: [centroid, direction]
function lineFit(P) {
  let mx = 0, my = 0;
  for (const p of P) { mx += p[0]; my += p[1]; }
  mx /= P.length; my /= P.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of P) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // a line only counts if the points really are on one
  const along = Math.max(sxx, syy), across = Math.min(sxx, syy);
  return [[mx, my], [Math.cos(ang), Math.sin(ang)], across / (along + 1e-9) < 0.05];
}
function intersect(a, b) {
  if (!a[2] || !b[2]) return null;
  const [p, d] = a, [q, e] = b, den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 0.2) return null;                    // nearly parallel: no real corner to snap to
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}
// direction of the first few points, by least squares, so one stray point at a
// corner doesn't skew the whole curve leaving it
function endTangent(P, atEnd) {
  const n = P.length, m = Math.max(2, Math.min(10, Math.floor(n / 3)));
  const o = atEnd ? n - 1 : 0, dir = atEnd ? -1 : 1;
  let mx = 0, my = 0;
  for (let i = 0; i < m; i++) { mx += P[o + dir * i][0]; my += P[o + dir * i][1]; }
  mx /= m; my /= m;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < m; i++) { const dx = P[o + dir * i][0] - mx, dy = P[o + dir * i][1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let t = [Math.cos(ang), Math.sin(ang)];
  const along = sub(P[o + dir * (m - 1)], P[o]);
  if (dot(t, along) < 0) t = neg(t);
  return dot(along, along) > 1e-9 ? t : unit(along);
}
function tangentAt(P, i) { const n = P.length, k = Math.min(3, n >> 2 || 1); return unit(sub(P[(i + k) % n], P[(i - k + n) % n])); }

function fitCubic(P, t1, t2, tol, out, depth = 0) {
  const n = P.length;
  if (n < 2) return;
  const err = tol * tol;
  if (n === 2 || depth > 24) {
    const dist = Math.hypot(P[n - 1][0] - P[0][0], P[n - 1][1] - P[0][1]) / 3;
    out.push([P[0], addv(P[0], mul(t1, dist)), addv(P[n - 1], mul(t2, dist)), P[n - 1]]);
    return;
  }
  // a run that is straight within tolerance is one straight segment
  // (allowing the half-pixel stair a slightly tilted, un-antialiased edge leaves)
  const p0 = P[0], p3 = P[n - 1], cx = p3[0] - p0[0], cy = p3[1] - p0[1], cl = Math.hypot(cx, cy);
  const errLine = Math.max(err, cl > 20 ? 0.85 * 0.85 : 0);
  if (cl > 1e-6) {
    let mx = 0;
    for (let i = 1; i < n - 1 && mx <= errLine; i++) { const dd = ((P[i][0] - p0[0]) * cy - (P[i][1] - p0[1]) * cx) / cl; mx = Math.max(mx, dd * dd); }
    if (mx <= errLine) { out.push([p0, [p0[0] + cx / 3, p0[1] + cy / 3], [p0[0] + 2 * cx / 3, p0[1] + 2 * cy / 3], p3]); return; }
  }
  let u = chordParam(P);
  let bez = genBezier(P, u, t1, t2);
  let [maxE, split] = maxError(P, bez, u);
  if (maxE < err) { out.push(bez); return; }
  if (maxE < err * 4) {
    for (let it = 0; it < 4; it++) {
      u = reparam(P, bez, u);
      bez = genBezier(P, u, t1, t2);
      [maxE, split] = maxError(P, bez, u);
      if (maxE < err) { out.push(bez); return; }
    }
  }
  const tc = unit(sub(P[split - 1], P[split + 1]));
  fitCubic(P.slice(0, split + 1), t1, tc, tol, out, depth + 1);
  fitCubic(P.slice(split), neg(tc), t2, tol, out, depth + 1);
}
function chordParam(P) {
  const u = [0];
  for (let i = 1; i < P.length; i++) u.push(u[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = u[u.length - 1] || 1;
  return u.map(v => v / L);
}
function genBezier(P, u, t1, t2) {
  const p0 = P[0], p3 = P[P.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < P.length; i++) {
    const t = u[i], mt = 1 - t, b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t;
    const a0 = mul(t1, b1), a1 = mul(t2, b2);
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    const tmp = sub(P[i], addv(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a0, tmp); x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det ? (x0 * c11 - x1 * c01) / det : 0, ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  const seg = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]), eps = 1e-6 * seg;
  if (al < eps || ar < eps || al > seg * 3 || ar > seg * 3) { al = ar = seg / 3; }
  return [p0, addv(p0, mul(t1, al)), addv(p3, mul(t2, ar)), p3];
}
function bez(b, t) {
  const mt = 1 - t;
  return [mt * mt * mt * b[0][0] + 3 * t * mt * mt * b[1][0] + 3 * t * t * mt * b[2][0] + t * t * t * b[3][0],
          mt * mt * mt * b[0][1] + 3 * t * mt * mt * b[1][1] + 3 * t * t * mt * b[2][1] + t * t * t * b[3][1]];
}
function maxError(P, b, u) {
  let mx = 0, split = P.length >> 1;
  for (let i = 1; i < P.length - 1; i++) {
    const q = bez(b, u[i]), dd = (q[0] - P[i][0]) ** 2 + (q[1] - P[i][1]) ** 2;
    if (dd >= mx) { mx = dd; split = i; }
  }
  return [mx, split];
}
function reparam(P, b, u) {
  const d1 = [mul(sub(b[1], b[0]), 3), mul(sub(b[2], b[1]), 3), mul(sub(b[3], b[2]), 3)];
  const d2 = [mul(sub(d1[1], d1[0]), 2), mul(sub(d1[2], d1[1]), 2)];
  return u.map((t, i) => {
    const q = bez(b, t), mt = 1 - t;
    const q1 = [mt * mt * d1[0][0] + 2 * t * mt * d1[1][0] + t * t * d1[2][0], mt * mt * d1[0][1] + 2 * t * mt * d1[1][1] + t * t * d1[2][1]];
    const q2 = [mt * d2[0][0] + t * d2[1][0], mt * d2[0][1] + t * d2[1][1]];
    const diff = sub(q, P[i]), num = dot(diff, q1), den = dot(q1, q1) + dot(diff, q2);
    if (!den) return t;
    const nt = t - num / den;
    return nt < 0 ? 0 : nt > 1 ? 1 : nt;
  });
}

/* ---------------------------------------------------------------- color */
const LIN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) { const c = i / 4095; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const lin = v => LIN[Math.max(0, Math.min(4095, Math.round(v * 16.0588)))];   // v in 0..255
function toLab(r, g, b, out, o) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}
function labHex(c) {
  const l_ = c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2];
  const m_ = c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2];
  const s_ = c[0] - 0.0894841775 * c[1] - 1.2914855480 * c[2];
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
               -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
               -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return '#' + rgb.map(v => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
}

function colorLayers(data, w, h, S, sc, live, anchors, edits) {
  const n = w * h;
  // light pre-smoothing of the colour itself
  let R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    R[i] = data[j] * a + 255 * (1 - a); G[i] = data[j + 1] * a + 255 * (1 - a); B[i] = data[j + 2] * a + 255 * (1 - a);
  }
  if (S.denoise > 0) {
    const r = Math.max(1, Math.round((S.denoise / 4) * Math.max(sc, 0.4)));
    R = boxBlur(R, w, h, r); G = boxBlur(G, w, h, r); B = boxBlur(B, w, h, r);
  }
  // sample → OKLab → k-means
  const step = Math.max(1, Math.floor(n / (live ? 8000 : 24000)));
  const samp = [];
  for (let i = 0; i < n; i += step) samp.push(i);
  const sl = new Float32Array(samp.length * 3);
  samp.forEach((p, q) => toLab(R[p], G[p], B[p], sl, q * 3));
  // how many colours: as set, or the elbow of the error curve (live frames
  // re-decide only now and then, so the palette doesn't flicker)
  let k = S.ncol;
  if (S.autoColors) {
    if (live && liveK && (liveFrame++ % 15)) k = liveK;
    else { k = pickK(sl, Math.max(2, Math.min(10, S.ncol))); if (live) liveK = k; }
  }
  let C = (live && prevC && prevC.length === k) ? prevC.map(c => c.slice()) : seedCenters(sl, k);
  C = kmeans(sl, C, live && prevC && prevC.length === k ? 3 : 12);
  prevC = C;
  // light to dark, so darker layers sit on top of lighter supersets
  const order = C.map((c, i) => [i, c[0]]).sort((a, b) => b[1] - a[1]).map(a => a[0]);
  const rank = new Uint8Array(k); order.forEach((ci, r) => rank[ci] = r);
  // palette edits from the person: dropped colours fold into the nearest kept
  // one; recoloured ones keep their region and change only the fill
  const pal = S.palK === k && S.pal ? S.pal : {};
  const remap = new Uint8Array(k);
  for (let r = 0; r < k; r++) {
    remap[r] = r;
    if (!(pal[r] && pal[r].drop)) continue;
    let best = -1, bd = Infinity;
    for (let q = 0; q < k; q++) {
      if (q === r || (pal[q] && pal[q].drop)) continue;
      const a = C[order[r]], b = C[order[q]], dd = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (dd < bd) { bd = dd; best = q; }
    }
    if (best >= 0) remap[r] = best;
  }
  // every pixel's palette slot, looked up once per 6-bit colour bucket:
  // a photo has millions of pixels but only thousands of distinct colours
  let lab = new Uint8Array(n);
  const cache = new Int8Array(1 << 18).fill(-1), tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const key = ((R[i] >> 2) << 12) | ((G[i] >> 2) << 6) | (B[i] >> 2);
    let v = cache[key];
    if (v < 0) { toLab(((R[i] >> 2) << 2) + 2, ((G[i] >> 2) << 2) + 2, ((B[i] >> 2) << 2) + 2, tmp, 0); v = cache[key] = remap[rank[nearest(C, tmp[0], tmp[1], tmp[2])]]; }
    lab[i] = v;
  }
  R = G = B = null;
  if (edits) for (let i = 0; i < n; i++) if (edits[i]) lab[i] = edits[i] > 0 ? darkestKept(k, pal) : 0;
  // majority filter: kills speckle and the jagged seams between regions
  const passes = live ? 1 : 1 + (S.denoise >= 5 ? 1 : 0) + (sc > 1.6 ? 1 : 0);
  for (let p = 0; p < passes; p++) lab = modeFilter(lab, w, h, k);

  const colors = [], palette = [];
  for (let r = 0; r < k; r++) {
    const base = labHex(C[order[r]]);
    colors.push(pal[r] && pal[r].hex ? pal[r].hex : base);
    palette.push({ r, hex:colors[r], base, drop:!!(pal[r] && pal[r].drop) });
  }
  let body = '', paths = 0, nodes = 0;
  const m = new Float32Array(n);
  const traceMask = (test, r) => {
    let any = false;
    for (let i = 0; i < n; i++) { const v = test(lab[i]) ? 1 : 0; m[i] = v; if (v) any = true; }
    if (!any) return;
    const f = boxBlur(m, w, h, 1);
    for (let i = 0; i < n; i++) f[i] -= 0.5;
    const res = fitLoops(contours(f, w, h), S, sc, anchors);
    if (res.d) { body += '<path fill="' + colors[r] + '" fill-rule="evenodd" d="' + res.d + '"/>'; paths++; nodes += res.nodes; }
  };
  if (S.layering === 'cut') {
    // cut out: every colour is its own shape, nothing hidden underneath
    for (let r = S.keepBg ? 0 : 1; r < k; r++) if (remap[r] === r) traceMask(v => v === r, r);
  } else {
    // stacked: lighter layers run under darker ones, so no hairline gaps
    if (S.keepBg) { body += '<rect width="' + fm(w) + '" height="' + fm(h) + '" fill="' + colors[0] + '"/>'; paths++; }
    for (let r = 1; r < k; r++) if (remap[r] === r) traceMask(v => v >= r, r);
  }
  return { body, paths, nodes, palette, k };
}
function darkestKept(k, pal) { for (let r = k - 1; r > 0; r--) if (!(pal[r] && pal[r].drop)) return r; return 0; }
function kmeans(sl, C, iters) {
  const ns = sl.length / 3;
  for (let it = 0; it < iters; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let q = 0; q < ns; q++) {
      const c = nearest(C, sl[q * 3], sl[q * 3 + 1], sl[q * 3 + 2]), a = acc[c];
      a[0] += sl[q * 3]; a[1] += sl[q * 3 + 1]; a[2] += sl[q * 3 + 2]; a[3]++;
    }
    C = C.map((c, j) => acc[j][3] ? [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]] : c);
  }
  return C;
}
// the fewest colours after which adding one stops helping much
function pickK(sl, kmax) {
  const ns = sl.length / 3, step = Math.max(1, Math.floor(ns / 4000)), sub = [];
  for (let q = 0; q < ns; q += step) sub.push(sl[q * 3], sl[q * 3 + 1], sl[q * 3 + 2]);
  const S = new Float32Array(sub);
  // error for k colours, and the share held by the smallest one: a colour that
  // only exists along the soft edges between two others isn't a real colour
  const fit = k => {
    const C = kmeans(S, seedCenters(S, k), 8), cnt = new Float64Array(k);
    let e = 0;
    for (let q = 0; q < S.length; q += 3) { const j = nearest(C, S[q], S[q + 1], S[q + 2]), c = C[j]; cnt[j]++; e += (c[0] - S[q]) ** 2 + (c[1] - S[q + 1]) ** 2 + (c[2] - S[q + 2]) ** 2; }
    return [e, Math.min(...cnt) / (S.length / 3)];
  };
  let [prev] = fit(2);
  if (prev / (S.length / 3) < 2e-4) return 2;          // practically two-tone already
  for (let k = 3; k <= kmax; k++) {
    const [e, minShare] = fit(k);
    if ((prev - e) / prev < 0.2 || minShare < 0.015 || e / (S.length / 3) < 1.2e-4) return k - 1;
    prev = e;
  }
  return kmax;
}
function nearest(C, a, b, c) {
  let bi = 0, bd = 1e12;
  for (let j = 0; j < C.length; j++) { const q = C[j], d = (q[0] - a) ** 2 + (q[1] - b) ** 2 + (q[2] - c) ** 2; if (d < bd) { bd = d; bi = j; } }
  return bi;
}
// k-means++ with a fixed seed, so the same photo always gives the same palette
function seedCenters(sl, k) {
  const n = sl.length / 3;
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const C = [];
  const first = Math.floor(rnd() * n);
  C.push([sl[first * 3], sl[first * 3 + 1], sl[first * 3 + 2]]);
  const D = new Float64Array(n).fill(Infinity);
  while (C.length < k) {
    const c = C[C.length - 1];
    let sum = 0;
    for (let q = 0; q < n; q++) {
      const d = (sl[q * 3] - c[0]) ** 2 + (sl[q * 3 + 1] - c[1]) ** 2 + (sl[q * 3 + 2] - c[2]) ** 2;
      if (d < D[q]) D[q] = d;
      sum += D[q];
    }
    if (!sum) { C.push(c.slice()); continue; }
    let t = rnd() * sum, q = 0;
    for (; q < n - 1; q++) { t -= D[q]; if (t <= 0) break; }
    C.push([sl[q * 3], sl[q * 3 + 1], sl[q * 3 + 2]]);
  }
  return C;
}
function modeFilter(lab, w, h, k) {
  const out = new Uint8Array(lab.length), cnt = new Uint8Array(k);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, cur = lab[i];
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      // fast path: the 4-neighbourhood already agrees (most of any image)
      if (lab[y0 * w + x] === cur && lab[y1 * w + x] === cur && lab[y * w + x0] === cur && lab[y * w + x1] === cur) { out[i] = cur; continue; }
      cnt.fill(0);
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) cnt[lab[yy * w + xx]]++;
      let best = cur, bc = cnt[cur];
      for (let j = 0; j < k; j++) if (cnt[j] > bc) { bc = cnt[j]; best = j; }
      out[i] = best;
    }
  }
  return out;
}

/* ------------------------------------------------------- perspective
 * The page is the largest bright region; its corners are the extremes of
 * x+y and x−y. The quad comes back normalised (0..1) so the page can draw it
 * and let a person drag it. */
function detectQuad(d, w, h) {
  const k = Math.min(1, 256 / Math.max(w, h)), sw = Math.max(16, Math.round(w * k)), sh = Math.max(16, Math.round(h * k));
  const L = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const j = (Math.min(h - 1, Math.floor((y + 0.5) / k)) * w + Math.min(w - 1, Math.floor((x + 0.5) / k))) * 4;
    L[y * sw + x] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
  }
  const Bl = boxBlur(L, sw, sh, 2), t = otsu(Bl), N = sw * sh;
  const lab = new Int32Array(N).fill(-1);
  let best = -1, bestN = 0, cur = 0;
  const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (lab[i] >= 0 || Bl[i] <= t) continue;
    let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = cur;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % sw, y = (p / sw) | 0;
      if (x > 0 && lab[p - 1] < 0 && Bl[p - 1] > t) { lab[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < sw - 1 && lab[p + 1] < 0 && Bl[p + 1] > t) { lab[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && lab[p - sw] < 0 && Bl[p - sw] > t) { lab[p - sw] = cur; stack[sp++] = p - sw; }
      if (y < sh - 1 && lab[p + sw] < 0 && Bl[p + sw] > t) { lab[p + sw] = cur; stack[sp++] = p + sw; }
    }
    if (cnt > bestN) { bestN = cnt; best = cur; }
    cur++;
  }
  if (best < 0 || bestN < 0.12 * N || bestN > 0.97 * N) return null;
  let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let i = 0; i < N; i++) {
    if (lab[i] !== best) continue;
    const x = i % sw, y = (i / sw) | 0, s = x + y, df = x - y;
    if (s < tl[2]) tl = [x, y, s];
    if (s > br[2]) br = [x, y, s];
    if (df > tr[2]) tr = [x, y, df];
    if (df < bl[2]) bl = [x, y, df];
  }
  let q = [tl, tr, br, bl].map(p => [(p[0] + 0.5) / sw, (p[1] + 0.5) / sh]);
  q = refineQuad(d, w, h, q) || q;
  // reject slivers and twisted quads
  let qa = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; qa += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(qa / 2) < 0.1) return null;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return null;
  }
  return q;
}
// The coarse corners come from a 256px map, so each can be several pixels
// off. Re-find every page edge at full resolution (strongest brightness step
// along its normal, at 40 points), fit a line to each, and take the corners
// where the lines meet.
function refineQuad(d, w, h, q) {
  const P = q.map(p => [p[0] * w, p[1] * h]);
  const lum = (x, y) => { const xi = Math.max(0, Math.min(w - 1, x | 0)), yi = Math.max(0, Math.min(h - 1, y | 0)), j = (yi * w + xi) * 4; return 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]; };
  const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  const reach = Math.max(6, Math.round(Math.max(w, h) * 0.02));
  const lines = [];
  for (let e = 0; e < 4; e++) {
    const A = P[e], B = P[(e + 1) % 4], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    if (L < 20) return null;
    let nx = -dy / L, ny = dx / L;
    // point the normal outward, away from the page centre
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const t = 0.12 + 0.76 * i / 39, bx = A[0] + dx * t, by = A[1] + dy * t;
      let best = 0, bo = 0;
      for (let o = -reach; o <= reach; o++) {
        const g = lum(bx + nx * (o - 1.5), by + ny * (o - 1.5)) - lum(bx + nx * (o + 1.5), by + ny * (o + 1.5));   // paper inside, darker outside
        if (g > best) { best = g; bo = o; }
      }
      if (best > 12) pts.push([bx + nx * bo, by + ny * bo]);
    }
    if (pts.length < 12) return null;
    let ln = lineFit(pts);
    // one pass of outlier rejection, then refit
    const dist = p => Math.abs((p[0] - ln[0][0]) * ln[1][1] - (p[1] - ln[0][1]) * ln[1][0]);
    const keep = pts.filter(p => dist(p) < 2.5);
    if (keep.length >= 10) ln = lineFit(keep);
    lines.push([ln[0], ln[1], true]);
  }
  const out = [];
  for (let c = 0; c < 4; c++) {
    const X = intersect(lines[(c + 3) % 4], lines[c]);
    if (!X || Math.hypot(X[0] - P[c][0], X[1] - P[c][1]) > reach * 3) return null;
    out.push([X[0] / w, X[1] / h]);
  }
  return out;
}
function smoothQuad(q) {
  if (!q) { if (++liveMiss > 8) liveQuad = null; return liveQuad; }
  liveMiss = 0;
  if (!liveQuad) { liveQuad = q; return q; }
  liveQuad = liveQuad.map((p, i) => [p[0] + (q[i][0] - p[0]) * 0.35, p[1] + (q[i][1] - p[1]) * 0.35]);
  return liveQuad;
}
function homography(src, dst) {     // maps src points to dst points
  const A = [], bb = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); bb.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); bb.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [bb[c], bb[p]] = [bb[p], bb[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      bb[r] -= f * bb[c];
    }
  }
  return bb.map((v, i) => v / (A[i][i] || 1e-12));
}
// width/height of the real rectangle, assuming a centred lens and square
// pixels (Zhang & He, whiteboard rectification)
function pageVecs(P, w, h) {
  const cx = w / 2, cy = h / 2;
  const m = i => [P[i][0] - cx, P[i][1] - cy, 1];
  const m1 = m(0), m2 = m(1), m4 = m(2), m3 = m(3);          // TL, TR, BR, BL
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot3(c14, m3) / dot3(cross(m2, m4), m3);
  const k3 = dot3(c14, m2) / dot3(cross(m3, m4), m2);
  return [[k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]], [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]]];
}
function focal2(P, w, h) {
  const [n2, n3] = pageVecs(P, w, h);
  const den = n2[2] * n3[2];
  return Math.abs(den) > 1e-9 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / den : NaN;
}
function pageAspect(P, w, h) {
  // the corners pin down the lens only when the page is tilted about both
  // axes; check the estimate survives a pixel of corner error before
  // trusting it, else assume a typical phone lens (about 65° across)
  const D = Math.max(w, h), plaus = f2 => f2 > 0 && (v => v > 15 && v < 110)(2 * Math.atan(D / 2 / Math.sqrt(f2)) * 180 / Math.PI);
  let f2 = focal2(P, w, h);
  if (plaus(f2)) {
    const jit = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
    for (let c = 0; c < 4 && f2; c++) for (const [jx, jy] of jit) {
      const Q = P.map((p, i) => i === c ? [p[0] + jx * 1.5, p[1] + jy * 1.5] : p);
      const g = focal2(Q, w, h);
      if (!plaus(g) || Math.abs(Math.sqrt(g) / Math.sqrt(f2) - 1) > 0.15) { f2 = NaN; break; }
    }
  } else f2 = NaN;
  if (!(f2 > 0)) f2 = (0.78 * D) ** 2;
  const [n2, n3] = pageVecs(P, w, h);
  const a2 = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
  const a3 = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
  const r = Math.sqrt(a2 / a3);
  return isFinite(r) && r > 0.2 && r < 5 ? r : null;
}
function warp(d, w, h, q) {
  const P = q.map(p => [p[0] * w, p[1] * h]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), oh = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
  // foreshortening hides the page's real shape; recover it from the
  // perspective (Zhang & He, whiteboard rectification), else keep edge lengths
  const ar = pageAspect(P, w, h);
  if (ar) { const avgW = (dist(P[0], P[1]) + dist(P[3], P[2])) / 2, avgH = (dist(P[0], P[3]) + dist(P[1], P[2])) / 2;
    if (avgW / ar >= avgH) { ow = avgW; oh = avgW / ar; } else { oh = avgH; ow = avgH * ar; } }
  const k = Math.min(1, Math.max(w, h) / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * k)); oh = Math.max(8, Math.round(oh * k));
  const Hm = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], P);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const v = y + 0.5;
    for (let x = 0; x < ow; x++) {
      const u = x + 0.5, den = Hm[6] * u + Hm[7] * v + 1;
      let sx = (Hm[0] * u + Hm[1] * v + Hm[2]) / den - 0.5, sy = (Hm[3] * u + Hm[4] * v + Hm[5]) / den - 0.5;
      sx = Math.max(0, Math.min(w - 1.001, sx)); sy = Math.max(0, Math.min(h - 1.001, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4, o = (y * ow + x) * 4;
      for (let c = 0; c < 4; c++)
        out[o + c] = (d[i00 + c] * (1 - fx) + d[i10 + c] * fx) * (1 - fy) + (d[i01 + c] * (1 - fx) + d[i11 + c] * fx) * fy;
    }
  }
  return { data:out, w:ow, h:oh };
}
