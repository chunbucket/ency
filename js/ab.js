/* The A/B — two renders of the same forty-five seconds, switched underneath
 * the playhead.
 *
 * Web Audio rather than two <audio> elements, on purpose. Two media elements
 * drift apart within seconds, and a switch that costs even 80 ms of silence
 * stops being a comparison: the ear loses the thing it was holding. Both
 * buffers are started against one AudioContext clock and the switch is a
 * ~12 ms gain crossfade, so the only variable that changes is the master.
 *
 * The files are level-matched at encode time (see the note the page prints).
 * That is not a nicety — the master is 19 dB louder as rendered, and louder
 * always wins a blind test. An A/B that does not match levels is a volume
 * test wearing a lab coat.
 */

import { register, solo } from './solo.js';

const XFADE = 0.012;

export function initAB(root = document) {
  const el = root.querySelector?.('.ab');
  if (!el || el.dataset.wired) return null;
  el.dataset.wired = '1';

  const srcs   = [el.dataset.a, el.dataset.b];
  const playBt = el.querySelector('.ab-play');
  const bar    = el.querySelector('.ab-bar');
  const fill   = el.querySelector('.ab-fill');
  const clock  = el.querySelector('.ab-time');
  const sides  = [...el.querySelectorAll('.ab-side')];
  const status = el.querySelector('.ab-status');

  let ctx, buffers = null, nodes = null;
  let side = 0, playing = false, offset = 0, startedAt = 0, raf = 0;
  const dur = () => (buffers ? buffers[0].duration : 0);

  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const now = () => (playing ? Math.min(offset + (ctx.currentTime - startedAt), dur()) : offset);

  function paint() {
    const t = now(), d = dur() || 1;
    fill.style.transform = `scaleX(${t / d})`;
    clock.textContent = `${fmt(t)} / ${fmt(d)}`;
    if (playing) raf = requestAnimationFrame(paint);
  }

  async function load() {
    if (buffers) return buffers;
    status.textContent = 'loading';
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const bufs = await Promise.all(srcs.map(async s => {
      const r = await fetch(s);
      if (!r.ok) throw new Error(s);
      return ctx.decodeAudioData(await r.arrayBuffer());
    }));
    buffers = bufs;
    status.textContent = '';
    return buffers;
  }

  function stopNodes() {
    if (!nodes) return;
    for (const n of nodes) { try { n.src.stop(); } catch {} n.src.disconnect(); n.gain.disconnect(); }
    nodes = null;
  }

  function start(at) {
    stopNodes();
    nodes = buffers.map((buf, i) => {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buf;
      gain.gain.value = i === side ? 1 : 0;
      src.connect(gain).connect(ctx.destination);
      src.start(0, at);
      return { src, gain };
    });
    // one end callback is enough — the two buffers are the same length
    nodes[0].src.onended = () => { if (playing && now() >= dur() - 0.05) reset(); };
    startedAt = ctx.currentTime;
    offset = at;
  }

  function reset() {
    stopNodes(); playing = false; offset = 0;
    el.classList.remove('on'); playBt.setAttribute('aria-label', 'Play');
    cancelAnimationFrame(raf); paint();
  }

  async function play() {
    try { await load(); } catch { status.textContent = 'could not load the audio'; return; }
    if (ctx.state === 'suspended') await ctx.resume();
    solo(me);
    if (offset >= dur() - 0.05) offset = 0;
    start(offset);
    playing = true;
    el.classList.add('on'); playBt.setAttribute('aria-label', 'Pause');
    paint();
  }

  function pause() {
    if (!playing) return;
    const t = now();
    stopNodes(); playing = false; offset = t;
    el.classList.remove('on'); playBt.setAttribute('aria-label', 'Play');
    cancelAnimationFrame(raf); paint();
  }

  const toggle = () => (playing ? pause() : play());

  function pick(i) {
    if (i === side) return;
    side = i;
    sides.forEach((b, n) => {
      b.classList.toggle('on', n === i);
      b.setAttribute('aria-checked', String(n === i));
    });
    if (!nodes) return;
    const t = ctx.currentTime;
    nodes.forEach((n, k) => {
      n.gain.gain.cancelScheduledValues(t);
      n.gain.gain.setValueAtTime(n.gain.gain.value, t);
      n.gain.gain.linearRampToValueAtTime(k === i ? 1 : 0, t + XFADE);
    });
  }

  function seek(clientX) {
    if (!buffers) return;
    const r = bar.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur();
    if (playing) start(t); else { offset = t; }
    paint();
  }

  playBt.addEventListener('click', toggle);
  sides.forEach((b, i) => b.addEventListener('click', () => pick(i)));
  bar.addEventListener('pointerdown', e => { bar.setPointerCapture(e.pointerId); seek(e.clientX); });
  bar.addEventListener('pointermove', e => { if (bar.hasPointerCapture?.(e.pointerId)) seek(e.clientX); });

  el.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); pick(0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pick(1); }
  });

  const me = { pause };
  const unregister = register(me);
  paint();

  return () => { stopNodes(); cancelAnimationFrame(raf); unregister(); };
}

/** Wire the deck now, and again after every soft navigation — the router
 *  replaces <main>'s innerHTML, so the nodes initAB held are gone. */
export function mountAB() {
  let teardown = initAB();
  document.addEventListener('room:enter', () => { teardown?.(); teardown = initAB(); });
  document.addEventListener('room:leave', () => { teardown?.(); teardown = null; });
}
