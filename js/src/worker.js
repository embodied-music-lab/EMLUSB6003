// SPDX-License-Identifier: MIT
// The dedicated Worker that owns the card. The page runs the device chooser and passes the chosen
// device's IDs and serial number; the Worker finds it with navigator.usb.getDevices().
//
// MESSAGE INTERFACE
//
// Page to Worker. Every message may carry an `id`; the reply to it carries the same `id`. The page
// waits for each reply before sending the next command.
//
//   {type: "init", id, timing?, simulated?}
//       First message. `simulated`: an options object for SimulatedUsbDevice (see simulated.js) makes
//       the Worker use a simulated card instead of navigator.usb. `timing`: overrides for DEFAULT_TIMING (driver.js).
//       Reply: {type: "ready", id}
//   {type: "open", id, vendorId, productId, serialNumber}
//       Finds the permitted device, opens it, claims interface 0, stops anything left running, runs the
//       startup exchange and reads the card's calibration.
//       Reply: {type: "opened", id, serialHex, productName, calibration: {gain, offset}}
//   {type: "configure", id, inputs, ratePerInput}
//       Reply: {type: "configured", id, inputs, divisor, conversionRate, ratePerInput}  (the true rates)
//   {type: "start", id}
//       Reply: {type: "started", id} once the card has accepted the start sequence. Data messages follow.
//   {type: "stop", id}
//       Reply: {type: "stopped", id, interruptHex, bytesAfterStop}. Every data message for frames received
//       before the stop was sent before this reply.
//   {type: "close", id}
//       Reply: {type: "closed", id}
//   Any command that fails is answered with {type: "error", id, stage, name, message}, where `name` is
//   the class name in errors.js and `message` is plain English.
//
// Worker to page, without a request:
//
//   {type: "data", buffer, frames, firstFrame, gapS}
//       One batch of whole frames: `buffer` is a transferred ArrayBuffer of int16 counts (little endian),
//       `frames` the number of frames in it, `firstFrame` the number of the first one since start, `gapS`
//       null, or the seconds lost to a recovered halt just before this batch. A batch never spans a gap.
//   {type: "stats", bytesTotal, framesPosted, largestGapMs, gapsOverBuffer, creditFailures, recoveries}
//       Sent periodically while streaming.
//   {type: "halted", reason}
//       The stream stopped: no data for a while, a failed read, or a disconnect. The Worker is restarting it.
//   {type: "recovered", reason, tries, gapS}
//       Acquisition runs again. gapS is the seconds of data lost.
//   {type: "lost", name, message}
//       Recovery failed; the stream is over. Data posted before it is complete.
//   {type: "warning", message}

import { Usb6003Driver } from "./driver.js";
import { SimulatedUsb, SimulatedUsbDevice } from "./simulated.js";

/** Attaches the message handler to `scope` (a Worker's global scope, or any object with postMessage). */
export function attachWorker(scope) {
  let driver = null;
  const post = (msg, transfer) => (transfer ? scope.postMessage(msg, transfer) : scope.postMessage(msg));
  const emit = (msg, transfer) => post(msg, transfer);

  const commands = {
    async init(m) {
      let usb = typeof navigator !== "undefined" ? navigator.usb : null;
      if (m.simulated !== undefined && m.simulated !== null) {
        usb = new SimulatedUsb();
        usb.add(new SimulatedUsbDevice({ ...m.simulated, bus: usb }));
      }
      driver = new Usb6003Driver({ usb, emit, timing: m.timing });
      return { type: "ready" };
    },
    async open(m) { return { type: "opened", ...(await need().open(m)) }; },
    async configure(m) { return { type: "configured", ...need().configure(m.inputs, m.ratePerInput) }; },
    async start() { await need().start(); return { type: "started" }; },
    async stop() { const r = await need().stop(); return { type: "stopped", interruptHex: r.interruptHex, bytesAfterStop: r.bytesAfterStop }; },
    async close() { if (driver) await driver.close(); return { type: "closed" }; },
  };
  function need() {
    if (!driver) throw Object.assign(new Error("send init first"), { name: "Usb6003Error" });
    return driver;
  }

  scope.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (!commands[m.type]) throw Object.assign(new Error("unknown message type: " + m.type), { name: "Usb6003Error" });
      post({ id: m.id, ...(await commands[m.type](m)) });
    } catch (err) {
      post({ type: "error", id: m.id, stage: m.type, name: (err && err.name) || "Error", message: (err && err.message) || String(err) });
    }
  };
  return scope;
}

// In a real Worker, attach to the global scope.
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) attachWorker(self);
