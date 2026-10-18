// SPDX-License-Identifier: MIT
// A stand-in for a Worker that runs the Worker code on the calling thread, for tests and debugging.
// It has the Worker methods Usb6003 uses: postMessage, addEventListener, removeEventListener, terminate.
import { attachWorker } from "./worker.js";

export function createInlineWorker() {
  const listeners = new Set();
  let ended = false;
  const scope = { onmessage: null, postMessage: (data) => { if (!ended) setTimeout(() => listeners.forEach((fn) => fn({ data })), 0); } };
  attachWorker(scope);
  return {
    postMessage: (data) => { if (!ended) setTimeout(() => scope.onmessage({ data }), 0); },
    addEventListener: (type, fn) => { if (type === "message") listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === "message") listeners.delete(fn); },
    terminate: () => { ended = true; listeners.clear(); },
  };
}
