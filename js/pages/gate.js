/* Entry point for the gate — which is also the shell the rooms open inside. */

import { mountChrome } from '../chrome.js';
import { initRouter } from '../router.js';
import { initTilt } from '../tilt.js';
import { createGate } from '../gate.js';
import { mountAB } from '../ab.js';

const shell = createGate();   // synchronous; its own boot continues in the background
mountChrome(null);
initRouter(shell);
initTilt();
mountAB();
