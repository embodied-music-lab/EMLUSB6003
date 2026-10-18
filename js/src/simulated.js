// SPDX-License-Identifier: MIT
// A simulated USB-6003 for tests and demos with no hardware: a USBDevice-shaped object.
//
// SimulatedUsbDevice answers the driver's messages, parses the channel list and rate it is sent, and
// streams frames at the implied rate. All values are synthetic: the serial number, the calibration
// and the sample values (a counter pattern, see simCount).
//
// SimulatedUsb stands in for navigator.usb: getDevices() and the 'connect' and 'disconnect' events.

import * as P from "./protocol.js";

export const SIM_SERIAL = "0a0b0c0d";   // synthetic
export const SIM_GAIN = 3.0e-4;         // synthetic volts per count
export const SIM_OFFSET = 0.01;         // synthetic offset in volts

/** The synthetic count a simulated card sends for input `inputNumber` in frame number `frame`. */
export const simCount = (frame, inputNumber) => (inputNumber + 1) * 1000 + (frame % 1000);

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const abort = () => Object.assign(new Error("device closed"), { name: "AbortError" });
const gone = () => Object.assign(new Error("The device was disconnected."), { name: "NotFoundError" });
const transferError = () => Object.assign(new Error("A transfer error has occurred."), { name: "NetworkError" });

function reply(selector, total, payload = new Uint8Array(0)) {
  const body = P.concatBytes(P.REPLY_STATUS_OK, payload);
  const padded = new Uint8Array(total - P.HEADER_BYTES);
  padded.set(body.subarray(0, padded.length));
  const out = new Uint8Array(total);
  out[0] = selector >> 8; out[1] = selector & 0xFF;
  out[2] = total >> 8; out[3] = total & 0xFF;
  out[4] = (total - 4) >> 8; out[5] = (total - 4) & 0xFF;
  out.set(padded, P.HEADER_BYTES);
  return out;
}

function deviceInfoPayload(serial, productId, gain, offset) {
  const h = P.REPLY_HEADER_BYTES;
  const block = new Uint8Array(P.DEVICE_INFO_REPLY_LENGTH - h).fill(0xFF);
  const dv = new DataView(block.buffer);
  const put = (at, data) => block.set(data, at - h);
  put(P.CAL_SERIAL_OFFSET, Uint8Array.from(serial).reverse());
  put(h + 0x0A, new Uint8Array(8));
  dv.setUint16(h + 0x0A - h, P.VENDOR_ID, true); dv.setUint16(h + 0x0E - h, productId, true);
  const text = (s, length) => { const b = new Uint8Array(length); b.set(new TextEncoder().encode(s)); return b; };
  put(h + 0x13, text("National Instruments", 0x37 - 0x13));
  put(h + 0x37, text(P.PRODUCTS[productId], 16));
  for (let k = 0; k < 12; k++) {
    dv.setFloat32(P.CAL_GAIN_OFFSET + 8 * k - h, gain, true);
    dv.setFloat32(P.CAL_OFFSET_OFFSET + 8 * k - h, offset, true);
  }
  return block;
}

export class SimulatedUsb extends EventTarget {
  constructor() { super(); this.devices = []; }
  add(device) { this.devices.push(device); return device; }
  async getDevices() { return this.devices.filter((d) => !d._gone); }
  fire(type, device) { const ev = new Event(type); ev.device = device; this.dispatchEvent(ev); }
}

/**
 * Options (all optional):
 *   serialHex, productId, gain, offset   the unit's synthetic identity
 *   pieceBytes (192)          bytes per data completion; use a value that is not a multiple of the frame size to split frames
 *   pieceIntervalMs (1)       how often a piece becomes available
 *   startAcquiring            the card is already streaming when constructed, as an unclean quit leaves it
 *   haltMode, haltAfterMs, haltCount (1), resetsToFix (1)
 *       a mid-stream halt, haltAfterMs after a start. haltMode is one of
 *       "hang" (data reads never complete; commands answered), "error" (data reads fail with a transfer error),
 *       "stall" (data reads complete with status "stall"), "wedged" (as "hang", and no command is answered),
 *       "unplug" (as "hang", and reset() never ends it). reset() ends a halt after resetsToFix calls.
 *   disconnectAfterMs, disconnectCount (1), disconnectLagMs (70), reconnectAfterMs, bus
 *       a disconnect: transfers fail, the device is gone disconnectLagMs later ('disconnect' on bus),
 *       and reconnectAfterMs after that a new device object with the same serial appears ('connect' on bus).
 */
export class SimulatedUsbDevice {
  constructor(opts = {}) {
    this._opts = opts;
    this.serialHex = opts.serialHex || SIM_SERIAL;
    this._serial = P.hexToBytes(this.serialHex);
    this.productId = opts.productId ?? 0x76C6;
    if (!(this.productId in P.PRODUCTS)) throw new Error(`unknown product ID 0x${this.productId.toString(16)}`);
    this.vendorId = P.VENDOR_ID;
    this.productName = P.PRODUCTS[this.productId] + " (simulated)";
    this.manufacturerName = "National Instruments (simulated)";
    this.serialNumber = this.serialHex;
    this.gain = opts.gain ?? SIM_GAIN; this.offset = opts.offset ?? SIM_OFFSET;
    this.pieceBytes = opts.pieceBytes || 192;
    this.pieceIntervalMs = opts.pieceIntervalMs ?? 1;
    this._bus = opts.bus || null;
    this._haltMode = opts.haltMode || null;
    this._haltAfterMs = opts.haltAfterMs ?? 1000;
    this._haltsLeft = this._haltMode ? (opts.haltCount ?? 1) : 0;
    this._resetsToFix = opts.resetsToFix ?? 1;
    this._disconnectAfterMs = opts.disconnectAfterMs ?? null;
    this._disconnectsLeft = opts.disconnectCount ?? (this._disconnectAfterMs != null ? 1 : 0);
    this._disconnectLagMs = opts.disconnectLagMs ?? 70;
    this._reconnectAfterMs = opts.reconnectAfterMs ?? null;
    // state a test can inspect
    this.sent = [];            // every message written, except credits (hex strings)
    this.credits = [];         // the value of every credit written
    this.resets = 0; this.starts = 0; this.configs = []; this.haltLog = [];
    // simulated card state
    this.opened = false; this._configValue = 0;
    this._inputs = []; this._divisor = 0;
    this._streaming = !!opts.startAcquiring; this._everStreamed = this._streaming;
    this._streamStart = now(); this._streamStop = null; this._bytesConsumed = 0;
    this._wedged = false; this._halted = null; this._resetsSeen = 0; this._sess = 0; this._gen = 0;
    this._failing = false; this._gone = false;
    this._pendingReply = new Uint8Array(0);
    this._pendingDataReads = 0; this._dataQueue = []; this._pumpTimer = null;
    this._interruptReady = false;
    this.configurations = [{
      configurationValue: 1, configurationName: "Simulated configuration",
      interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0xFF, endpoints: [
        { endpointNumber: 1, direction: "out", type: "bulk", packetSize: 64 },
        { endpointNumber: 1, direction: "in", type: "bulk", packetSize: 64 },
        { endpointNumber: 2, direction: "in", type: "bulk", packetSize: 64 },
        { endpointNumber: 4, direction: "in", type: "interrupt", packetSize: 64 }] }] }],
    }];
  }

  get configuration() { return this._configValue ? this.configurations[0] : null; }
  get ratePerInput() { return P.TIMEBASE_HZ / this._divisor / this._inputs.length; }

  open() { if (this._gone) return Promise.reject(gone()); this.opened = true; return Promise.resolve(); }
  close() { this.opened = false; return this._gone ? Promise.reject(gone()) : Promise.resolve(); }
  selectConfiguration(v) { if (this._gone) return Promise.reject(gone()); this._configValue = v; return Promise.resolve(); }
  claimInterface() { return this._gone ? Promise.reject(gone()) : Promise.resolve(); }
  releaseInterface() { return this._gone ? Promise.reject(gone()) : Promise.resolve(); }
  /** A WebUSB bus reset. It drops the configuration, so the caller selects it again. */
  reset() {
    if (this._gone) return Promise.reject(gone());
    this._gen++; this._resetsSeen++; this.resets++;
    if (this._haltMode !== "unplug" && this._resetsSeen >= this._resetsToFix) { this._wedged = false; this._halted = null; this._resetsSeen = 0; }
    this._streaming = false; this._everStreamed = false; this._streamStop = null; this._configValue = 0;
    this._pendingReply = new Uint8Array(0);
    return Promise.resolve();
  }

  _beginHalt(sess) {
    if (sess !== this._sess || !this._streaming) return;
    this.haltLog.push(now());
    this._halted = this._haltMode;
    if (this._haltMode === "wedged") this._wedged = true;
  }

  _beginDisconnect(sess) {
    if (sess !== this._sess || !this._streaming) return;
    this._failing = true; this._halted = "error"; this.haltLog.push(now());
    setTimeout(() => {
      this._gone = true; this.opened = false; this._streaming = false; this._configValue = 0;
      if (this._bus) this._bus.fire("disconnect", this);
      if (this._reconnectAfterMs == null) return;
      setTimeout(() => {
        const { startAcquiring, ...rest } = this._opts;
        const again = new SimulatedUsbDevice({ ...rest, disconnectCount: this._disconnectsLeft });
        if (this._bus) { this._bus.add(again); this._bus.fire("connect", again); }
      }, this._reconnectAfterMs);
    }, this._disconnectLagMs);
  }

  _answer(data) {
    const selector = (data[0] << 8) | data[1], op = data[7];
    const address = P.readBE(data, 8, 4), operands = data.subarray(12);
    const ack = () => reply(selector, P.ACK_LENGTH);
    if (address === P.ADDR_INFO_QUERY && selector === P.SELECTOR_INFO) return reply(selector, op === P.OP_00 ? 28 : 24);
    if (address === P.ADDR_CHALLENGE && op === P.OP_20) {
      return reply(selector, P.CHALLENGE_REPLY_LENGTH, Uint8Array.from(operands.subarray(0, P.CHALLENGE_BYTES), (c, i) => c ^ this._serial[i]));
    }
    if (address === P.ADDR_DEVICE_INFO && op === P.OP_0A) {
      return reply(selector, P.DEVICE_INFO_REPLY_LENGTH, deviceInfoPayload(this._serial, this.productId, this.gain, this.offset));
    }
    if (address === P.ADDR_CHANNELS && op === P.OP_08) {
      const count = P.readBE(operands, 0, 2) - 2;
      this._inputs = Array.from(operands.subarray(2, 2 + count));
      return ack();
    }
    if (address === P.ADDR_ENGINE && op === P.OP_09) { this._divisor = P.readBE(operands, 2, 2); return ack(); }
    if (address === P.ADDR_ENGINE && op === P.OP_0C) {
      if (this._pendingDataReads === 0 || !this._inputs.length || !this._divisor) return null;   // no read queued: no reply
      this._streaming = this._everStreamed = true; this._streamStart = now(); this._bytesConsumed = 0; this._streamStop = null;
      const sess = ++this._sess; this.starts++;
      this.configs.push({ inputs: this._inputs.slice(), divisor: this._divisor });
      if (this._haltsLeft > 0) { this._haltsLeft--; setTimeout(() => this._beginHalt(sess), this._haltAfterMs); }
      if (this._disconnectAfterMs != null && this._disconnectsLeft > 0) { this._disconnectsLeft--; setTimeout(() => this._beginDisconnect(sess), this._disconnectAfterMs); }
      return ack();
    }
    if (address === P.ADDR_ENGINE && op === P.OP_0D) {
      if (this._streaming) { this._streaming = false; this._streamStop = now(); }
      this._interruptReady = true;
      return reply(selector, 16);
    }
    if ([P.ADDR_DEVICE_INFO, P.ADDR_ENGINE, P.ADDR_ENGINE_B, P.ADDR_CHANNELS, P.ADDR_CREDIT].includes(address)) return ack();
    return null;
  }

  transferOut(ep, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    if (this._gone) return Promise.reject(gone());
    if (this._failing) return Promise.reject(transferError());
    if (ep === P.endpointNumber(P.EP_CMD_OUT)) {
      if (bytes[6] === 0 && bytes[7] === P.OP_09 && P.readBE(bytes, 8, 4) === P.ADDR_CREDIT) {
        this.credits.push(P.readBE(bytes, 12, 4));
      } else {
        this.sent.push(P.bytesToHex(bytes));
        this._pendingReply = this._wedged ? null : this._answer(bytes);
      }
    }
    return Promise.resolve({ bytesWritten: bytes.length, status: "ok" });
  }

  transferIn(ep, length) {
    if (ep === P.endpointNumber(P.EP_REPLY_IN)) {
      return new Promise((resolve, reject) => {
        if (this._gone) { reject(gone()); return; }
        if (this._pendingReply === null) {   // no reply: the read waits until the device is closed or reset
          this._pendingReply = new Uint8Array(0);
          const gen = this._gen;
          const wait = () => {
            if (this._gone) { reject(gone()); return; }
            if (!this.opened || gen !== this._gen) { reject(abort()); return; }
            setTimeout(wait, 5);
          };
          wait();
          return;
        }
        const r = this._pendingReply;
        this._pendingReply = new Uint8Array(0);
        resolve({ status: "ok", data: new DataView(r.buffer, r.byteOffset, r.byteLength) });
      });
    }
    if (ep === P.endpointNumber(P.EP_STATUS_IN)) {
      return new Promise((resolve) => {
        if (this._interruptReady) {
          this._interruptReady = false;
          resolve({ status: "ok", data: new DataView(P.STOP_INTERRUPT.buffer.slice(0)) });
        } else setTimeout(() => resolve({ status: "ok", data: new DataView(new ArrayBuffer(0)) }), 50);
      });
    }
    if (ep === P.endpointNumber(P.EP_DATA_IN)) {
      this._pendingDataReads++;
      return new Promise((resolve, reject) => {
        this._dataQueue.push({ length, filled: 0, gen: this._gen, resolve, reject });
        if (!this._pumpTimer) this._pumpTimer = setTimeout(() => this._pump(), this.pieceIntervalMs);
      });
    }
    return Promise.reject(Object.assign(new Error("simulated card: unexpected address " + ep), { name: "NotSupportedError" }));
  }

  // Data reads complete in submission order; a read completes once it holds pieceBytes or is full.
  _pump() {
    this._pumpTimer = null;
    const q = this._dataQueue;
    const failAll = (err) => { while (q.length) { this._pendingDataReads--; q.shift().reject(err); } };
    if (this._gone) { failAll(gone()); return; }
    if (!this.opened) { failAll(abort()); return; }
    for (let i = 0; i < q.length;) {          // reads from before a reset are aborted
      if (q[i].gen !== this._gen) { this._pendingDataReads--; q.splice(i, 1)[0].reject(abort()); } else i++;
    }
    const again = () => { if (q.length || this._streaming) this._pumpTimer = setTimeout(() => this._pump(), this.pieceIntervalMs); };
    if (this._halted === "error") { failAll(transferError()); return; }
    if (this._halted === "stall") {
      while (q.length) { this._pendingDataReads--; q.shift().resolve({ status: "stall", data: new DataView(new ArrayBuffer(0)) }); }
      again(); return;
    }
    if (this._halted || (!this._streaming && !this._everStreamed) || !this._inputs.length) { again(); return; }
    const until = this._streaming ? now() : this._streamStop;
    const fb = this._inputs.length * P.BYTES_PER_SAMPLE;
    const produced = Math.floor((until - this._streamStart) / 1000 * this.ratePerInput) * fb;
    let free = produced - this._bytesConsumed - q.reduce((s, r) => s + r.filled, 0);
    for (const r of q) {
      if (free <= 0) break;
      const take = Math.min(r.length - r.filled, free);
      r.filled += take; free -= take;
    }
    while (q.length) {
      const r = q[0];
      if (!(r.filled >= this.pieceBytes || r.filled >= r.length || (!this._streaming && r.filled > 0))) break;
      q.shift(); this._pendingDataReads--;
      const block = this._makeBytes(r.filled);
      this._bytesConsumed += block.length;
      r.resolve({ status: "ok", data: new DataView(block.buffer, block.byteOffset, block.byteLength) });
    }
    again();
  }

  /** Bytes of the stream from the current offset: frame after frame, one int16 per list entry. */
  _makeBytes(n) {
    const out = new Uint8Array(n), fb = this._inputs.length * P.BYTES_PER_SAMPLE;
    for (let i = 0; i < n; i++) {
      const at = this._bytesConsumed + i, frame = Math.floor(at / fb), within = at % fb;
      const v = simCount(frame, this._inputs[within >> 1]);
      out[i] = (within & 1) ? (v >> 8) & 0xFF : v & 0xFF;
    }
    return out;
  }
}
