// SPDX-License-Identifier: MIT
// Usb6003: the page-side class. It owns a Worker (worker.js) that runs the USB loop, and has the
// same API names as the Python package: configure(), start(), read(), stop(), close().
//
//   const card = await Usb6003.request();            // Chrome's device chooser; call it from a click
//   const rate = await card.configure([0, 1, 2], 1000);   // true rate for each entry
//   await card.start();
//   const frames = await card.read();                // counts and volts, one value per list entry
//   await card.stop();
//   await card.close();

import * as P from "./protocol.js";
import { Frames } from "./frames.js";
import { errorFromText, Usb6003Error } from "./errors.js";
import { createInlineWorker } from "./inline.js";

export class Usb6003 {
  /**
   * @param {Worker} worker  a Worker running worker.js (or createInlineWorker())
   * @param {object} [o]
   * @param {function} [o.onEvent]  onEvent(name, info) for "halted", "recovered", "stats" and "warning"
   * @param {boolean} [o.ownsWorker]  terminate the Worker on close()
   */
  constructor(worker, { onEvent = null, ownsWorker = false } = {}) {
    this.worker = worker; this.onEvent = onEvent; this.ownsWorker = ownsWorker;
    this.nextId = 1; this.pending = new Map();
    this.out = []; this.waiters = []; this.error = null; this.streaming = false;
    this.calibration = null; this.serial = null; this.productName = null; this.configuration = null;
    this.recoveries = 0;
    this.worker.addEventListener("message", (ev) => this._onMessage(ev.data));
  }

  /** Whether this browser has WebUSB. */
  static get supported() { return typeof navigator !== "undefined" && !!navigator.usb; }

  /** The USB filters that match every card this driver supports. */
  static get filters() { return Object.keys(P.PRODUCTS).map((id) => ({ vendorId: P.VENDOR_ID, productId: Number(id) })); }

  /** Cards the page may already use (permission from an earlier chooser), as USBDevice objects. */
  static async permittedDevices() {
    return (await navigator.usb.getDevices()).filter((d) => d.vendorId === P.VENDOR_ID && d.productId in P.PRODUCTS);
  }

  /**
   * Shows Chrome's device chooser, then opens the card the person picks. Call it from a click.
   * Options: onEvent; worker (an existing Worker); inline (run on this thread instead of a Worker);
   * timing (overrides, see driver.js DEFAULT_TIMING); simulated (options for a simulated card, no chooser).
   */
  static async request(options = {}) {
    if (options.simulated !== undefined) return Usb6003.fromDevice(null, options);
    const device = await navigator.usb.requestDevice({ filters: Usb6003.filters });
    return Usb6003.fromDevice(device, options);
  }

  /** Opens a card the page already has permission for (a USBDevice from permittedDevices()). */
  static async fromDevice(device, { onEvent, worker, inline = false, timing, simulated } = {}) {
    const ownsWorker = !worker;
    const useInline = inline || typeof Worker === "undefined";      // no Worker (Node): run on this thread
    worker = worker || (useInline ? createInlineWorker() : new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
    const card = new Usb6003(worker, { onEvent, ownsWorker });
    try {
      await card._call({ type: "init", timing, simulated });
      const opened = await card._call({ type: "open", vendorId: device?.vendorId, productId: device?.productId, serialNumber: device?.serialNumber });
      card.serial = opened.serialHex; card.productName = opened.productName;
      card.calibration = new P.Calibration(opened.calibration.gain, opened.calibration.offset);
    } catch (err) {
      if (ownsWorker) worker.terminate();
      throw err;
    }
    return card;
  }

  _call(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  _onMessage(m) {
    if (m.id !== undefined && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.type === "error") reject(errorFromText(m.name, m.message)); else resolve(m);
      return;
    }
    switch (m.type) {
      case "data": {
        this.out.push(new Frames(new Int16Array(m.buffer), this.configuration.inputs, this.calibration, m.firstFrame, m.gapS));
        break;
      }
      case "lost": this.error = errorFromText(m.name, m.message); this.streaming = false; break;
      case "recovered": this.recoveries++; // falls through to the event call below
      default: if (this.onEvent) { const { type, ...info } = m; try { this.onEvent(type, info); } catch (_e) { /* a faulty callback must not stop the stream */ } }
    }
    const w = this.waiters; this.waiters = [];
    for (const f of w) f();
  }

  /**
   * Sets the channel list and the rate for each entry, and resolves with the true rate per entry.
   * inputs: input numbers 0 to 7 (ai0 to ai7), any order, repeats allowed. The card runs at the nearest
   * rate its timebase allows at or above the request. Rejects with ProtocolError when the request is
   * outside the card's limits. Nothing is sent to the card until start().
   */
  async configure(inputs, ratePerInput) {
    P.makeConfiguration(inputs, ratePerInput);            // refuse at once, before any round trip
    const r = await this._call({ type: "configure", inputs: Array.from(inputs), ratePerInput });
    this.configuration = P.makeConfiguration(r.inputs, ratePerInput);
    return r.ratePerInput;
  }

  async start() {
    if (!this.configuration) throw new Usb6003Error("call configure() before start()");
    this.out = []; this.error = null;
    await this._call({ type: "start" });
    this.streaming = true;
  }

  /**
   * Resolves with the frames that have arrived, or null when none arrive within `timeout` ms (or at once, when
   * not streaming and nothing is buffered). A run never spans a recovered halt: the first run after one carries
   * gapS. Rejects with StreamLost when the stream was lost for good, after the frames that arrived before it.
   */
  async read({ timeout = 1000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.out.length) {
        const first = this.out.shift(), more = [];
        while (this.out.length && this.out[0].gapS == null) more.push(this.out.shift());
        return more.length ? first.joined(more) : first;
      }
      if (this.error) throw this.error;
      if (!this.streaming) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise((resolve) => { const t = setTimeout(resolve, left); this.waiters.push(() => { clearTimeout(t); resolve(); }); });
    }
  }

  /** Stops streaming. Frames already received can still be collected with read(). */
  async stop() {
    if (!this.streaming && !this.error) return;
    await this._call({ type: "stop" });
    this.streaming = false;
  }

  /** Stops streaming if needed and releases the card. */
  async close() {
    try { await this._call({ type: "close" }); } finally { this.streaming = false; if (this.ownsWorker) this.worker.terminate(); }
  }
}
