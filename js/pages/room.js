/* Entry point for a room loaded directly (/tools, /music) — no gate
 * underneath, so it brings its own backdrop and its back arrow is a real
 * navigation home. */

import { mountChrome } from '../chrome.js';
import { initRouter } from '../router.js';
import { initTilt } from '../tilt.js';
import { mountBackdrop } from '../backdrop.js';
import { mountAB } from '../ab.js';
import { mountRail } from '../rail.js';

mountChrome(document.body.dataset.room || null);
initRouter(null);
initTilt();
mountBackdrop(document.getElementById('cv'), document.getElementById('bg'));
mountAB();
mountRail();
