/* Soft routing.
 *
 * No navigation between the gate and the rooms, or between the rooms, is a
 * document load — so the canvas is never torn down and the mesh never
 * restarts. Framework routers swap DOM for a living; this one deliberately
 * does not touch anything outside <main>.
 *
 * The gate passes a `shell` ({ demote, restore }) and hosts the rooms inside
 * its own <main>. A room loaded directly passes null: it is a standalone page
 * with its own backdrop, and its back arrow is a real navigation home.
 *
 * Anything unexpected falls through to a normal load. */

import { INTERIOR, labelFor, setNav } from './chrome.js';

const main = () => document.querySelector('main');
const roomOpen = () => { const m = main(); return !!m && !m.hidden; };

let busy = false;

async function swap(path, push) {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(path, { headers: { accept: 'text/html' } });
    if (!res.ok) { location.href = path; return; }
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const next = doc.querySelector('main');
    const cur = main();
    if (!next || !cur) { location.href = path; return; }

    cur.innerHTML = next.innerHTML;
    cur.hidden = false;
    document.title = doc.title;
    if (push) history.pushState({ ency: 1 }, '', path);
    setNav(labelFor(path));
    window.scrollTo(0, 0);
    // a room's own JS wires itself off this; innerHTML replaced every node
    document.dispatchEvent(new CustomEvent('room:enter'));
  } catch {
    location.href = path;
  } finally {
    busy = false;
  }
}

export function initRouter(shell = null) {
  const enter = (path, push) => {
    // demote on the way in only; room-to-room leaves the mesh alone
    if (shell && !roomOpen()) shell.demote();
    return swap(path, push);
  };

  const leave = push => {
    document.dispatchEvent(new CustomEvent('room:leave'));
    const m = main();
    if (m) { m.hidden = true; m.innerHTML = ''; }
    if (shell) shell.restore();
    setNav(null);
    document.title = 'ency';
    if (push) history.pushState({ ency: 1 }, '', '/');
    window.scrollTo(0, 0);
  };

  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 ||
        e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.target) return;
    const href = a.getAttribute('href');

    if (INTERIOR.has(href)) {
      e.preventDefault();
      if (href !== location.pathname) enter(href, true);
      return;
    }
    // on the shell the back arrow closes the room; on a standalone room there
    // is no gate underneath, so let the browser navigate for real
    if (href === '/' && shell && roomOpen()) {
      e.preventDefault();
      leave(true);
    }
  });

  window.addEventListener('popstate', () => {
    const path = location.pathname;
    if (INTERIOR.has(path)) enter(path, false);
    else if (shell) leave(false);
    else location.reload();
  });
}
