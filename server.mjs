// ency — zero-dependency server.
//
//   /            public page: the mesh + the gate; joined visitors land in the lobby
//   /studio      the same mesh plus its dials; needs a session cookie
//   /api/*       preset read/write, gate/join, lobby stream, unlock
//
// State lives in files under DATA_DIR (a Railway volume in production):
// emails.jsonl and phones.jsonl are append-only, preset.json is the published
// mesh settings. That's deliberately the smallest thing that works — see
// README for when to outgrow it.
//
// Phone numbers are collected now, texted later: no SMS provider is wired in
// yet, so nothing here sends anything. The lobby stream only ever fans out a
// COUNT — the numbers themselves never leave /api/phones (studio-authed).

import http from 'node:http';
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const PORT = process.env.PORT || 4720;
import { MUSIC_SECTIONS, TOOLS, SERVICES, CRATES, AB } from './content/site.mjs';
import { renderGrid, renderSections, renderServices, renderCrates, renderAB } from './content/render.mjs';
import { PORTFOLIO } from './content/portfolio.mjs';
import { renderPortfolio } from './content/portfolio-render.mjs';
import { head, robotsTxt, sitemapXml } from './content/seo.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const EMAILS = path.join(DATA_DIR, 'emails.jsonl');
const PHONES = path.join(DATA_DIR, 'phones.jsonl');
const PRESET = path.join(DATA_DIR, 'preset.json');
const HISTORY = path.join(DATA_DIR, 'preset-history.jsonl');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// the fan gate, not the studio one — no default: unset means closed, so a
// missing env var can never put the gate back on a public word. Set the env
// var to rotate it without a deploy
const GATE_PASSWORD = process.env.GATE_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = 7 * 24 * 3600 * 1000;

if (!ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD unset — /studio is closed');
if (!GATE_PASSWORD) console.warn('⚠ GATE_PASSWORD unset — the fan gate is closed');
if (!process.env.SESSION_SECRET) console.warn('⚠ SESSION_SECRET unset — sessions drop on restart');

// ------------------------------------------------------------------ storage

const seen = new Set();        // lowercased emails, for dedupe without re-reading
const phoneSeen = new Set();   // normalized E.164 numbers, same idea

async function initStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    for (const line of readFileSync(EMAILS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).email); } catch { /* skip a torn line */ }
    }
  } catch { /* first run */ }
  try {
    for (const line of readFileSync(PHONES, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { phoneSeen.add(JSON.parse(line).phone); } catch { /* skip a torn line */ }
    }
  } catch { /* first run */ }
  console.log(`◈ ${seen.size} subscriber(s), ${phoneSeen.size} number(s) loaded from ${DATA_DIR}`);
}

async function readPreset() {
  try { return JSON.parse(await readFile(PRESET, 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------ sessions

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('base64url');
}

function issueSession() {
  const exp = Date.now() + SESSION_TTL;
  return `${exp}.${sign(exp)}`;
}

function validSession(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot), mac = token.slice(dot + 1);
  const want = sign(exp);
  // compare fixed-length digests so a mismatch can't be timed
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}

function secretOk(supplied, against) {
  if (!against || typeof supplied !== 'string') return false;
  // hash both sides first: equal-length inputs, so timingSafeEqual can't throw
  // and length itself doesn't leak
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(against).digest();
  return crypto.timingSafeEqual(a, b);
}

const passwordOk = supplied => secretOk(supplied, ADMIN_PASSWORD);
const gateOk = supplied => secretOk(supplied, GATE_PASSWORD);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const authed = req => validSession(cookies(req).ency_s);

function setCookie(res, req, value, maxAge) {
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie',
    `ency_s=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (https ? '; Secure' : ''));
}

// ------------------------------------------------------------------ limits

const buckets = new Map();

// Deliberately in-memory: it resets on redeploy, which is fine because the
// password is the real control. Keeps the dependency count at zero.
function rateLimit(ip, key, max, windowMs) {
  const id = `${key}:${ip}`, now = Date.now();
  const b = buckets.get(id);
  if (!b || now > b.reset) { buckets.set(id, { n: 1, reset: now + windowMs }); return true; }
  if (b.n >= max) return false;
  b.n++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60_000).unref();

// The proxy appends the hop it saw on the right; the leftmost value is
// whatever the client claims. Keying limits on the claim would let a spoofed
// header reset them, so trust the hop the proxy actually added.
const clientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';

// ------------------------------------------------------------------ helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Streams, and honours Range. Safari will not play media from a server that
// answers 200-with-the-whole-file: it asks for a byte range and expects a 206
// with Accept-Ranges, and refuses the element outright when it does not get
// one. Chrome is forgiving here, which is exactly why this hid for so long.
// Streaming also stops a 100MB read landing in memory per request.
async function serveFile(res, name, req) {
  const abs = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });

  let st;
  try {
    st = await stat(abs);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: 'not found' });
  }

  const type = MIME[path.extname(abs)] || 'application/octet-stream';
  const range = req && req.headers && req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());

  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : st.size - 1;
    } else {
      // bytes=-N is the LAST n bytes, not "up to n" — this is the form a player
      // uses to find the moov atom at the end of an mp4, so getting it wrong
      // means the file never becomes playable
      start = Math.max(0, st.size - Number(m[2]));
      end = st.size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    if (end >= st.size) end = st.size - 1;

    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    return createReadStream(abs, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  createReadStream(abs).pipe(res);
}

// A page with content interpolated into it. The markup ships complete however
// it is asked for — by a browser, by the router's fetch, or by a crawler — so
// there is no second code path that renders cards on the client.
async function servePage(res, name, subs, headers = {}) {
  try {
    let html = await readFile(path.join(ROOT, name), 'utf8');
    for (const [key, value] of Object.entries(subs)) {
      html = html.replace(`<!--{{${key}}}-->`, value);
    }
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-cache',
      ...headers,
    });
    res.end(html);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// E.164-ish: strip formatting, 7–15 digits; a bare US 10-digit gets +1
function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  let s = raw.replace(/[\s().\-]/g, '');
  if (/^\d{10}$/.test(s)) s = '+1' + s;
  else if (/^\d{11,15}$/.test(s)) s = '+' + s;
  if (!/^\+\d{7,15}$/.test(s)) return null;
  return s;
}

// ------------------------------------------------------------------ lobby stream
//
// One SSE channel that fans out the signup count — only ever the count, so it
// can stay public without exposing a single number. In-memory like the rate
// limiter: a redeploy drops connections and EventSource reconnects on its own.

const lobbyClients = new Set();

function lobbyBroadcast() {
  const msg = `data: ${JSON.stringify({ count: phoneSeen.size })}\n\n`;
  for (const c of lobbyClients) c.write(msg);
}

// comment-only heartbeat so proxies don't reap quiet connections
setInterval(() => { for (const c of lobbyClients) c.write(': hb\n\n'); }, 25_000).unref();

// ------------------------------------------------------------------ security headers
//
// Set on every response before routing, so no path can forget them. The CSP
// is same-origin; /studio and /lab still carry an inline <script>, so those
// two get a relaxed script-src until the code moves into files.
const CSP_BASE = "default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function securityHeaders(res, p) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const scriptSrc = (p === '/studio' || p === '/studio.html' || p === '/lab')
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self'";
  res.setHeader('Content-Security-Policy', `${CSP_BASE}; style-src 'self' 'unsafe-inline'; ${scriptSrc}`);
}

// ------------------------------------------------------------------ routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = clientIp(req);
  securityHeaders(res, p);

  try {
    // Railway health check: minimal, no state
    if (p === '/healthz') return json(res, 200, { ok: true });

    // ---- pages
    if (p === '/' || p === '/index.html')
      return servePage(res, 'index.html', { head: head('/') });

    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
                           'Cache-Control': 'public, max-age=3600' });
      return res.end(robotsTxt());
    }

    if (p === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8',
                           'Cache-Control': 'public, max-age=3600' });
      return res.end(sitemapXml());
    }

    if (p === '/lab') return serveFile(res, 'lab.html', req);   // mesh v2 prototype, unlisted

    if (p === '/tools' || p === '/tools.html')
      return servePage(res, 'tools.html', { head: head('/tools'), tools: renderGrid(TOOLS) });

    if (p === '/music' || p === '/music.html')
      return servePage(res, 'music.html', { head: head('/music'), music: renderSections(MUSIC_SECTIONS) });

    if (p === '/services' || p === '/services.html')
      return servePage(res, 'services.html',
        { head: head('/services'), services: renderServices(SERVICES), ab: renderAB(AB) });

    if (p === '/crates' || p === '/crates.html')
      return servePage(res, 'crates.html', { head: head('/crates'), crates: renderCrates(CRATES) });
    if (p === '/cuts' || p === '/cuts.html') { res.writeHead(301, { Location: '/crates' }); return res.end(); }

    // Unlisted: reachable only by its own path, never linked from the site.
    // The header is what actually keeps it out of search — deliberately NOT
    // robots.txt, since a Disallow line would publish the path it protects.
    if (p === PORTFOLIO.path)
      return servePage(res, 'portfolio.html',
        { portfolio: renderPortfolio(PORTFOLIO) },
        { 'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex' });

    if (p === '/studio' || p === '/studio.html') {
      if (!authed(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return serveFile(res, 'studio.html', req);
    }

    // ---- public API
    if (p === '/api/preset' && req.method === 'GET') {
      return json(res, 200, { preset: await readPreset() });
    }

    if (p === '/api/subscribe' && req.method === 'POST') {
      if (!rateLimit(ip, 'sub', 5, 60_000)) return json(res, 429, { error: 'slow down' });
      let email;
      try { email = JSON.parse(await readBody(req)).email; } catch { return json(res, 400, { error: 'bad request' }); }
      if (typeof email !== 'string') return json(res, 400, { error: 'bad request' });
      email = email.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return json(res, 400, { error: "that doesn't look like an email" });
      if (seen.has(email)) return json(res, 200, { ok: true, already: true });
      // write first, then remember: adding to the set before the append would
      // make a failed write look saved for the life of this process
      // never logged, only written
      await appendFile(EMAILS, JSON.stringify({ email, ts: new Date().toISOString() }) + '\n');
      seen.add(email);
      return json(res, 200, { ok: true });
    }

    // gate check on its own, so the field can flip to the phone step only
    // after the word is right — /api/join re-checks it regardless
    if (p === '/api/gate' && req.method === 'POST') {
      if (!rateLimit(ip, 'gate', 15, 10 * 60_000)) return json(res, 429, { error: 'too many attempts' });
      let password;
      try { password = JSON.parse(await readBody(req)).password; } catch { return json(res, 400, { error: 'bad request' }); }
      if (!gateOk(password)) return json(res, 401, { error: 'no' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/join' && req.method === 'POST') {
      if (!rateLimit(ip, 'join', 6, 60_000)) return json(res, 429, { error: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad request' }); }
      if (!gateOk(body.password)) return json(res, 401, { error: 'no' });
      const phone = normalizePhone(body.phone);
      if (!phone) return json(res, 400, { error: "that doesn't look like a phone number" });
      if (phoneSeen.has(phone)) return json(res, 200, { ok: true, already: true, count: phoneSeen.size });
      // write first, then remember, same reason as /api/subscribe
      // never logged, only written
      await appendFile(PHONES, JSON.stringify({ phone, ts: new Date().toISOString() }) + '\n');
      phoneSeen.add(phone);
      lobbyBroadcast();
      return json(res, 200, { ok: true, count: phoneSeen.size });
    }

    if (p === '/api/lobby/stream' && req.method === 'GET') {
      if (lobbyClients.size >= 200) return json(res, 503, { error: 'lobby full' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ count: phoneSeen.size })}\n\n`);
      lobbyClients.add(res);
      req.on('close', () => lobbyClients.delete(res));
      return;
    }

    if (p === '/api/unlock' && req.method === 'POST') {
      if (!rateLimit(ip, 'unlock', 8, 15 * 60_000)) return json(res, 429, { error: 'too many attempts' });
      let password;
      try { password = JSON.parse(await readBody(req)).password; } catch { return json(res, 400, { error: 'bad request' }); }
      if (!passwordOk(password)) return json(res, 401, { error: 'nope' });
      setCookie(res, req, issueSession(), SESSION_TTL / 1000);
      return json(res, 200, { ok: true });
    }

    // ---- gated API
    if (p === '/api/preset' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      let preset;
      try { preset = JSON.parse(await readBody(req)).preset; } catch { return json(res, 400, { error: 'bad request' }); }
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return json(res, 400, { error: 'bad preset' });
      // Keep the outgoing preset before overwriting it. Publishing used to be
      // destructive — one bad write and the previous look was unrecoverable.
      const prev = await readPreset();
      if (prev) await appendFile(HISTORY, JSON.stringify({ ts: new Date().toISOString(), preset: prev }) + '\n');
      await writeFile(PRESET, JSON.stringify(preset, null, 2));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/preset/history' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      let rows = [];
      try {
        rows = (await readFile(HISTORY, 'utf8')).split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* nothing replaced yet */ }
      return json(res, 200, { history: rows.slice(-30).reverse() });   // newest first
    }

    if (p === '/api/subscribers' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      let rows = [];
      try {
        rows = (await readFile(EMAILS, 'utf8')).split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* none yet */ }
      return json(res, 200, { count: rows.length, subscribers: rows });
    }

    if (p === '/api/phones' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      let rows = [];
      try {
        rows = (await readFile(PHONES, 'utf8')).split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* none yet */ }
      return json(res, 200, { count: rows.length, phones: rows });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      setCookie(res, req, '', 0);
      return json(res, 200, { ok: true });
    }

    // ---- static: the root (favicons, mark) plus js/ and styles/, one level
    // deep. Directory segments cannot contain a dot, so there is no climbing
    // out; content/ is server-only and the data dir is not on the list.
    if (/^\/(?:(?:js|styles|media)\/(?:[\w-]+\/)?)?[\w.-]+\.(js|css|svg|png|ico|json|mp3|mp4|jpg|jpeg|webp)$/.test(p)) {
      return serveFile(res, p.slice(1), req);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('request failed:', err.message);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

await initStore();
server.listen(PORT, () => console.log(`◈ ency on http://localhost:${PORT}`));
