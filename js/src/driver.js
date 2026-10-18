// SPDX-License-Identifier: MIT
// The driver core: open, configure, start, stop, close, with halt recovery and disconnect handling.
//
// Usb6003Driver needs a `usb` object shaped like navigator.usb (getDevices(), addEventListener) and an
// emit(message, transferList) function for the messages it sends out. worker.js hosts it inside a
// dedicated Worker. The message formats are documented in worker.js.

import * as P from "./protocol.js";
import { DeviceNotFound, DeviceNotReturned, HandshakeError, StartError, StreamLost, Usb6003Error } from "./errors.js";

/** Timing defaults. A caller can override any of these. */
export const DEFAULT_TIMING = Object.freeze({
  commandTimeoutMs: P.TIMEOUT_MS,
  haltDetectMs: P.HALT_DETECT_MS,
  haltPollMs: P.HALT_POLL_MS,
  recoverAttempts: P.RECOVER_ATTEMPTS,
  recoverRetryWaitMs: P.RECOVER_RETRY_WAIT_MS,
  disconnectGraceMs: P.DISCONNECT_GRACE_MS,
  reconnectWaitMs: P.RECONNECT_WAIT_MS,
  batchWindowMs: 20,
  statsEvery: 32,          // completions between 'stats' messages
});

const nowMs = () => performance.now();
const EP = { cmd: P.endpointNumber(P.EP_CMD_OUT), reply: P.endpointNumber(P.EP_REPLY_IN), data: P.endpointNumber(P.EP_DATA_IN), status: P.endpointNumber(P.EP_STATUS_IN) };

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(Object.assign(new Error(`${label} timed out after ${ms} ms with no reply`), { name: "TimeoutError" })); }
    }, ms);
    promise.then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

export class Usb6003Driver {
  /**
   * @param {object} o
   * @param {object} o.usb       navigator.usb, or SimulatedUsb
   * @param {function} o.emit    emit(message, transferList?) for each outgoing message
   * @param {object} [o.timing]  overrides for DEFAULT_TIMING
   */
  constructor({ usb, emit, timing = {} }) {
    this.usb = usb; this.emit = emit;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.transport = null; this.serial = null; this.target = null;
    this.opened = false; this.claimed = false;
    this.cfg = null; this.calibration = null;
    this.phase = "idle";                     // 'idle' | 'stream' | 'stopping' | 'drain'
    this.cmdChain = Promise.resolve();
    this.readerAlive = false; this.readerGen = 0; this.queueDepth = 1;
    this.watchdog = null;
    this.recovering = false; this.recoverCancelled = false; this.recoveryDone = Promise.resolve();
    this.deviceGone = false; this.returnedDevice = null; this.usbWaiters = []; this.watching = false;
    this.recoveries = 0; this.tries = 0; this.lostAt = null;
    this._resetStream();
  }

  _resetStream() {
    this.totalBytes = 0; this.acqBytes = 0; this.carry = new Uint8Array(0);
    this.framesPosted = 0; this.gapNext = null;
    this.lastCompletion = null; this.largestGapMs = 0; this.gapsOverBuffer = 0; this.creditFailures = 0; this.completions = 0;
    this.pendingBatch = []; this.pendingFrames = 0;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.bytesAfterStop = 0; this.lastAfterStop = 0;
    this.streamStartedAt = 0; this.acqAckAt = 0;
  }

  // ---- commands

  /** Sends one step and reads its reply, serialized against every other command. Resolves {got, ok}. */
  sendCommand(step) {
    const run = async () => {
      let msg = step.data, challenge = null;
      if (step.kind === "challenge") {
        challenge = crypto.getRandomValues(new Uint8Array(P.CHALLENGE_BYTES));
        msg = P.withChallenge(step, challenge);
      }
      const ms = this.timing.commandTimeoutMs;
      await withTimeout(this.transport.transferOut(EP.cmd, msg), ms, "command write");
      const r = await withTimeout(this.transport.transferIn(EP.reply, 512), ms, "command reply");
      const got = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      return { got, ok: P.replyOk(step, got, challenge, this.serial) };
    };
    const p = this.cmdChain.then(run, run);
    this.cmdChain = p.catch(() => {});      // keep the chain alive even if this one fails
    return p;
  }

  /**
   * Sends each step and stops at the first with no reply, since a reply read that timed out is still
   * waiting in the browser and would be mistaken for the next step's reply.
   * Resolves {bad: names of steps refused or missing, replies: {name: bytes}}.
   */
  async runSteps(steps) {
    const bad = [], replies = {};
    for (const step of steps) {
      try {
        const { got, ok } = await this.sendCommand(step);
        replies[step.name] = got;
        if (!ok) bad.push(step.name);
      } catch (_e) { bad.push(step.name); break; }
    }
    return { bad, replies };
  }

  async _handshake() {
    const { bad, replies } = await this.runSteps(P.handshakeSteps());
    const info = replies.device_info;
    let cal = null;
    if (!bad.length && !P.deviceInfoSerialOk(info, this.serial)) bad.push("device_info (serial number)");
    if (!bad.length) { cal = P.parseCalibration(info); if (!cal.usable) bad.push("device_info (calibration)"); }
    return { bad, cal };
  }

  // ---- open / connect

  _isOurs(d) {
    const t = this.target;
    return !!d && !!t && d.vendorId === t.vendorId && d.productId === t.productId && (!t.serialNumber || d.serialNumber === t.serialNumber);
  }

  /**
   * Finds the device the page was allowed to use (WebUSB gives a Worker no chooser), opens it, claims it,
   * stops anything a previous page left running, runs the startup exchange and reads the calibration.
   */
  async open({ vendorId = P.VENDOR_ID, productId, serialNumber } = {}) {
    this.target = { vendorId, productId, serialNumber };
    try {
      const info = await this._connect(0);
      this._watchUsb();
      return info;
    } catch (err) {
      await this._release();
      throw err;
    }
  }

  async _release() {
    if (this.claimed) { try { await this.transport.releaseInterface(P.INTERFACE); } catch (_e) { /* already released, or gone */ } this.claimed = false; }
    if (this.opened) { try { await this.transport.close(); } catch (_e) { /* already closed, or gone */ } this.opened = false; }
  }

  async _resetDevice() {
    await this.transport.reset();
    if (!this.transport.configuration || this.transport.configuration.configurationValue !== P.CONFIGURATION) await this.transport.selectConfiguration(P.CONFIGURATION);
    await this.transport.claimInterface(P.INTERFACE);
  }

  /** The open path. `level` is 0 for a first open, 1 to reset the bus first, 2 to close and reopen first. */
  async _connect(level) {
    if (!this.transport) {
      const devices = this.usb && this.usb.getDevices ? await this.usb.getDevices() : [];
      const t = this.target;
      this.transport = devices.find((d) => d.vendorId === t.vendorId && d.productId in P.PRODUCTS && (t.productId == null || d.productId === t.productId) &&
        (!t.serialNumber || d.serialNumber === t.serialNumber));
      if (!this.transport) throw new DeviceNotFound("the driver could not see a USB-6003 that the page was allowed to use");
      this.target = { vendorId: this.transport.vendorId, productId: this.transport.productId, serialNumber: this.transport.serialNumber };
    }
    if (level >= 2) await this._release();
    if (!this.transport.opened) await this.transport.open();
    this.opened = true;
    if (!this.transport.configuration || this.transport.configuration.configurationValue !== P.CONFIGURATION) await this.transport.selectConfiguration(P.CONFIGURATION);
    await this.transport.claimInterface(P.INTERFACE);
    this.claimed = true;
    if (level >= 1) await this._resetDevice();

    // Stop any acquisition left running.
    try { await this.runSteps(P.stopSteps()); } catch (_e) { /* idle already, or not answering */ }
    this.serial = P.serialBytes(this.transport.serialNumber || "00000000");
    let { bad, cal } = await this._handshake();
    if (bad.length && typeof this.transport.reset === "function") {
      try { await this._resetDevice(); ({ bad, cal } = await this._handshake()); } catch (_e) { /* the original failure is reported below */ }
    }
    if (bad.length) throw new HandshakeError("the card did not answer the startup exchange as expected; the steps that failed: " + bad.join(", "));
    this.calibration = cal;
    return { serialHex: this.transport.serialNumber, productName: P.PRODUCTS[this.transport.productId], calibration: { gain: cal.gain, offset: cal.offset } };
  }

  /** Sets the channel list and rate. Nothing is sent until start(). Returns the true rates. */
  configure(inputs, ratePerInput) {
    if (this.phase !== "idle") throw new Usb6003Error("stop() before configure()");
    this.cfg = P.makeConfiguration(inputs, ratePerInput);
    return this._configInfo();
  }
  _configInfo() {
    const c = this.cfg;
    return { inputs: Array.from(c.inputs), divisor: c.divisor, conversionRate: c.conversionRate, ratePerInput: c.ratePerInput };
  }

  // ---- USB events

  _wakeWaiters() { const w = this.usbWaiters; this.usbWaiters = []; for (const f of w) f(); }
  _watchUsb() {
    if (this.watching || !this.usb || !this.usb.addEventListener) return;
    this.usb.addEventListener("disconnect", (ev) => {
      if (!this._isOurs(ev.device)) return;
      this.deviceGone = true; this.returnedDevice = null; this._wakeWaiters();
      if (this.phase === "stream" && !this.recovering) this.recover("the device was disconnected", true);
    });
    this.usb.addEventListener("connect", (ev) => {
      if (!this._isOurs(ev.device)) return;
      this.deviceGone = false; this.returnedDevice = ev.device; this._wakeWaiters();
    });
    this.watching = true;
  }
  /** Resolves true once test() holds (checked now and at each usb event), false after `ms` or when the recovery is cancelled. */
  _waitUsb(test, ms) {
    return new Promise((resolve) => {
      let done = false, timer = null;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const check = () => { if (done) return; if (test()) finish(true); else if (this.recoverCancelled) finish(false); else this.usbWaiters.push(check); };
      timer = setTimeout(() => finish(false), ms);
      check();
    });
  }

  // ---- streaming

  async _beginAcquisition() {
    const steps = P.startSteps(this.cfg);
    const k = steps.findIndex((s) => s.name === P.READS_BEGIN_BEFORE);
    const first = await this.runSteps(steps.slice(0, k));
    if (first.bad.length) return { ok: false, bad: first.bad };
    this.phase = "stream";
    this.streamStartedAt = nowMs();
    this.queueDepth = P.readQueueDepth(this.cfg.conversionRate);
    this._startReader();
    const rest = await this.runSteps(steps.slice(k));
    this.acqAckAt = nowMs();               // acquisition runs from here (see recover)
    const bad = rest.bad;
    if (bad.length) { this.phase = "idle"; this.readerAlive = false; this.readerGen++; return { ok: false, bad }; }
    return { ok: true, bad: [] };
  }

  async start() {
    if (!this.opened) throw new Usb6003Error("open the card first");
    if (!this.cfg) throw new Usb6003Error("call configure() before start()");
    if (this.phase !== "idle") throw new Usb6003Error("already streaming");
    this._resetStream(); this.tries = 0; this.recoveries = 0;
    const r = await this._beginAcquisition();
    if (!r.ok) throw new StartError("the card refused the start sequence at: " + r.bad.join(", "));
    this._startWatchdog();
  }

  _sendCredit(total) {
    if (this.phase !== "stream") return;
    this.transport.transferOut(EP.cmd, P.creditMessage(total)).catch((err) => {
      this.creditFailures++;
      if (this.creditFailures <= 3) this.emit({ type: "warning", message: "a flow-control credit write failed: " + err.message });
    });
  }

  _flushBatch() {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    if (!this.pendingBatch.length) return;
    const buf = P.concatBytes(...this.pendingBatch);
    const frames = buf.length / this.cfg.frameBytes;
    this.pendingBatch = [];
    const msg = { type: "data", buffer: buf.buffer, frames, firstFrame: this.framesPosted, gapS: this.gapNext };
    this.framesPosted += frames; this.gapNext = null;
    this.emit(msg, [buf.buffer]);
  }

  _onBlock(block) {
    const t = nowMs();
    if (this.phase === "drain") { this.bytesAfterStop += block.length; this.lastAfterStop = t; return; }
    if (this.lastCompletion !== null) {
      const gap = t - this.lastCompletion;
      if (gap > this.largestGapMs) this.largestGapMs = gap;
      if (gap > P.deviceBufferMs(this.cfg.conversionRate)) this.gapsOverBuffer++;
    }
    this.lastCompletion = t; this.tries = 0;
    this.totalBytes += block.length; this.acqBytes += block.length;
    this._sendCredit(this.acqBytes);

    const fb = this.cfg.frameBytes;
    const buf = this.carry.length ? P.concatBytes(this.carry, block) : block;
    const n = Math.floor(buf.length / fb);
    this.carry = buf.slice(n * fb);
    if (n) {
      this.pendingBatch.push(buf.slice(0, n * fb));
      if (!this.batchTimer) this.batchTimer = setTimeout(() => this._flushBatch(), this.timing.batchWindowMs);
    }
    if (++this.completions >= this.timing.statsEvery) {
      this.completions = 0;
      this.emit({ type: "stats", bytesTotal: this.totalBytes, framesPosted: this.framesPosted, largestGapMs: this.largestGapMs,
        gapsOverBuffer: this.gapsOverBuffer, creditFailures: this.creditFailures, recoveries: this.recoveries });
    }
  }

  /** Keeps queueDepth data reads queued. */
  _startReader() {
    this.readerAlive = true;
    const gen = ++this.readerGen;
    const fault = (err) => {
      this.readerAlive = false;
      if (this.phase === "stream" && !this.recovering) this.recover(err.message || err.name || "data read failed", true);
      else this.emit({ type: "warning", message: "data read ended: " + (err.message || err.name) });
    };
    const submit = () => {
      if (!this.readerAlive || gen !== this.readerGen) return;
      this.transport.transferIn(EP.data, P.READ_BYTES).then((r) => {
        if (gen !== this.readerGen) return;
        if (r.status && r.status !== "ok") { fault(Object.assign(new Error("data read ended with status " + r.status), { name: "TransferStatus" })); return; }
        if (r.data && r.data.byteLength) this._onBlock(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        submit();
      }, (err) => { if (gen === this.readerGen && this.readerAlive) fault(err); });
    };
    for (let k = 0; k < this.queueDepth; k++) submit();
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.phase !== "stream" || this.recovering) return;
      const quiet = nowMs() - (this.lastCompletion !== null ? this.lastCompletion : this.streamStartedAt);
      if (quiet > this.timing.haltDetectMs) this.recover(`no data for ${(quiet / 1000).toFixed(1)} s`);
    }, this.timing.haltPollMs);
  }
  _stopWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; } }

  /**
   * Restarts a halted stream, up to recoverAttempts tries, waiting up to reconnectWaitMs for a
   * removed device to return. Emits 'halted' now and 'recovered' with the gap when the stream runs
   * again. Recovery that fails emits 'lost'.
   */
  recover(reason, transferError = false) {
    if (this.recovering || this.phase !== "stream") return this.recoveryDone;
    this.recovering = true; this.recoverCancelled = false;
    const T = this.timing;
    this.recoveryDone = (async () => {
      this._stopWatchdog();
      this.readerAlive = false; this.readerGen++;         // ignore reads from before the halt
      this._flushBatch();
      this.emit({ type: "halted", reason });
      if (this.tries === 0) {
        this.prodEnd = this.acqAckAt + (this.acqBytes / this.cfg.frameBytes) / this.cfg.ratePerInput * 1000;
      }
      this.acqBytes = 0; this.lastCompletion = null; this.carry = new Uint8Array(0);
      let lastErr = null, neverReturned = false;
      if (transferError && !this.deviceGone) await this._waitUsb(() => this.deviceGone, T.disconnectGraceMs);
      while (!this.recoverCancelled && this.tries < T.recoverAttempts) {
        let level = Math.min(this.tries + 1, 2);
        if (this.deviceGone) {
          const back = await this._waitUsb(() => !this.deviceGone && this.returnedDevice !== null, T.reconnectWaitMs);
          if (this.recoverCancelled) break;
          if (!back) { neverReturned = true; break; }
          this.transport = this.returnedDevice; this.returnedDevice = null;   // a new USBDevice object for the same device
          this.opened = false; this.claimed = false;
          level = 0;
        }
        this.tries++;
        try {
          await this._connect(level);
          if (this.recoverCancelled) break;
          const r = await this._beginAcquisition();
          if (r.ok && !this.recoverCancelled) {
            this.recoveries++;
            this.gapNext = (this.acqAckAt - this.prodEnd) / 1000;
            this._startWatchdog();
            this.recovering = false;
            this.emit({ type: "recovered", reason, tries: this.tries, gapS: this.gapNext });
            return;
          }
          if (r.ok) break;                                  // cancelled: stop() stops what is running
          lastErr = new Error("the card refused the start sequence at: " + r.bad.join(", "));
        } catch (err) { lastErr = err; }
        this.readerAlive = false; this.readerGen++;
        if (this.tries < T.recoverAttempts && !this.recoverCancelled && !this.deviceGone) await this._waitUsb(() => this.deviceGone, T.recoverRetryWaitMs);
      }
      this.recovering = false;
      if (this.recoverCancelled) return;
      this.phase = "idle";
      const e = neverReturned
        ? new DeviceNotReturned(`the device was disconnected (${reason}) and did not reconnect within ${T.reconnectWaitMs / 1000} s`)
        : new StreamLost(`the card stopped sending data (${reason}) and did not restart after ${T.recoverAttempts} tries` + (lastErr ? `: ${lastErr.message}` : ""));
      this.emit({ type: "lost", name: e.name, message: e.message });
    })().catch((err) => {
      this.recovering = false; this.phase = "idle";
      this.emit({ type: "lost", name: "StreamLost", message: `recovery failed: ${err.message}` });
    });
    return this.recoveryDone;
  }

  async _readInterrupt(ms) {
    try {
      const r = await withTimeout(this.transport.transferIn(EP.status, 64), ms, "status read");
      return r.data && r.data.byteLength ? P.bytesToHex(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)) : "";
    } catch (_e) { return ""; }
  }

  /** Stops streaming. Frames received before the stop replies are posted as 'data' before this resolves. */
  async stop() {
    if (this.phase === "idle" && !this.recovering) return { interruptHex: "", bytesAfterStop: 0 };
    this._stopWatchdog();
    if (this.recovering) { this.recoverCancelled = true; this._wakeWaiters(); await this.recoveryDone; }
    this.phase = "stopping";
    const { bad } = await this.runSteps(P.stopSteps());
    this._flushBatch();
    this.phase = "drain";
    const interruptHex = await this._readInterrupt(300);
    // Count leftover bytes until none arrive for 300 ms, or 2 s in all.
    const t0 = nowMs();
    await new Promise((resolve) => {
      (function wait(self) {
        const quietSince = self.lastAfterStop || t0;
        if (nowMs() - quietSince > 300 || nowMs() - t0 > 2000) resolve();
        else setTimeout(() => wait(self), 20);
      })(this);
    });
    this.readerAlive = false; this.readerGen++;
    this.phase = "idle";
    return { interruptHex, bytesAfterStop: this.bytesAfterStop, stopRefused: bad };
  }

  async close() {
    if (this.phase !== "idle") await this.stop();
    this._stopWatchdog();
    await this._release();
  }
}
