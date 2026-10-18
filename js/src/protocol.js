// SPDX-License-Identifier: MIT
// Constants, message builders and reply checks for the USB-6003. No USB access.
// The Python twin is python/emlusb6003/protocol.py; tests/test_cross_language.py checks that both agree.

// Device identity

export const VENDOR_ID = 0x3923;
// Supported product IDs. 0x76C7 is the OEM version of the card.
export const PRODUCTS = Object.freeze({ 0x76C6: "USB-6003", 0x76C7: "USB-6003 (OEM)" });

export const CONFIGURATION = 1;
export const INTERFACE = 0;
export const EP_CMD_OUT = 0x01;
export const EP_REPLY_IN = 0x81;
export const EP_DATA_IN = 0x82;
export const EP_STATUS_IN = 0x84;
// WebUSB takes the number without the direction bit.
export const endpointNumber = (address) => address & 0x7F;

// Limits

export const TIMEBASE_HZ = 80_000_000;       // sample timebase, 80 MHz
export const INPUT_COUNT = 8;                // analog inputs ai0 to ai7
export const INPUT_RANGE_V = 10.0;           // -10 V to +10 V
export const MAX_AGGREGATE_RATE = 100_000;   // conversions per second, summed over all list entries
export const FIFO_SAMPLES = 2047;            // the card's own sample buffer
export const MAX_LIST_ENTRIES = 16;          // longest channel list the driver accepts
export const DIVISOR_MAX = 0xFFFF;
export const DIVISOR_MIN = Math.floor(TIMEBASE_HZ / MAX_AGGREGATE_RATE);

// Streaming

export const BYTES_PER_SAMPLE = 2;     // signed 16-bit counts
export const READ_BYTES = 7680;        // size of each data read
export const CREDIT_START = 0x7FFFFFFF;
export const TIMEOUT_MS = 1000;        // for one command and its reply

// Halt recovery: no data for HALT_DETECT_MS while streaming counts as a halt.
export const USB_QUEUE_SECONDS = 2.0;  // seconds of data the queued reads can hold
export const HALT_DETECT_QUEUE_FRACTION = 0.75;
export const HALT_DETECT_MS = Math.round(USB_QUEUE_SECONDS * 1000 * HALT_DETECT_QUEUE_FRACTION);
export const HALT_POLL_MS = 100;
export const RECOVER_ATTEMPTS = 5;     // tries before the stream is reported lost
export const RECOVER_RETRY_WAIT_MS = 1500;
export const DISCONNECT_GRACE_MS = 300;
export const RECONNECT_WAIT_MS = 30000;   // how long to wait for a removed device to return
export const RECONNECT_POLL_MS = 250;

// Message constants

export const SELECTOR = 0x0001;
export const SELECTOR_INFO = 0x0000;
export const HEADER_BYTES = 6;
export const REPLY_HEADER_BYTES = 12;
export const REPLY_STATUS_OK = Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x02]);

export const ADDR_INFO_QUERY = 0x00000000;
export const ADDR_CHALLENGE = 0x0D210000;
export const ADDR_DEVICE_INFO = 0x0D220000;
export const ADDR_CHANNELS = 0x0D300000;
export const ADDR_ENGINE_B = 0x0D310000;
export const ADDR_ENGINE = 0x0D600000;
export const ADDR_CREDIT = 0x00020002;

export const OP_00 = 0x00, OP_02 = 0x02, OP_05 = 0x05;
export const OP_08 = 0x08, OP_09 = 0x09, OP_0A = 0x0A, OP_0B = 0x0B, OP_0C = 0x0C, OP_0D = 0x0D, OP_0E = 0x0E, OP_0F = 0x0F, OP_20 = 0x20;

// Reply lengths, in bytes.
export const ACK_LENGTH = 12;
export const CHALLENGE_BYTES = 4;
export const CHALLENGE_REPLY_LENGTH = 16;
export const DEVICE_INFO_LENGTH = 236;
export const DEVICE_INFO_REPLY_LENGTH = 252;

// Offsets of the fields the driver reads from the device information reply.
export const CAL_SERIAL_OFFSET = 18;
export const CAL_GAIN_OFFSET = 114;
export const CAL_OFFSET_OFFSET = 118;

export const STOP_INTERRUPT = hexToBytes("00000010000c00050d60000000000000");

export class ProtocolError extends Error {
  constructor(message) { super(message); this.name = "ProtocolError"; }
}

// Bytes

export function hexToBytes(hex) {
  hex = hex.replace(/\s+/g, "");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const be = (value, length) => {
  const out = new Uint8Array(length);
  for (let i = length - 1, v = value; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
};
export const readBE = (bytes, at, length) => {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + bytes[at + i];
  return v;
};

/** Builds one framed message. `flag` 1 means a reply is expected. */
export function message(address, opcode, operands = new Uint8Array(0), { flag = 1, selector = SELECTOR } = {}) {
  let body = concatBytes(Uint8Array.of(flag, opcode), be(address, 4), operands);
  let total = HEADER_BYTES + body.length;
  body = concatBytes(body, new Uint8Array((4 - (total % 4)) % 4));
  total = HEADER_BYTES + body.length;
  return concatBytes(be(selector, 2), be(total, 2), be(total - 4, 2), body);
}

/** A message to send and the reply it expects. `kind` is "ack", "challenge" or "data". */
const step = (name, data, replyLength, kind = "ack") => Object.freeze({ name, data, replyLength, kind });
const ack = (name, data) => step(name, data, ACK_LENGTH, "ack");

// Steps

/**
 * The steps run when the card is attached. The "device_info" step returns the calibration
 * (see parseCalibration). The "challenge" step ends with placeholder bytes (see withChallenge).
 */
export function handshakeSteps() {
  const queryA = message(ADDR_INFO_QUERY, OP_00, undefined, { selector: SELECTOR_INFO });
  const queryB = message(ADDR_INFO_QUERY, OP_02, undefined, { selector: SELECTOR_INFO });
  return [
    step("query_a", queryA, 28, "data"),
    step("query_b", queryB, 24, "data"),
    step("challenge", message(ADDR_CHALLENGE, OP_20, new Uint8Array(CHALLENGE_BYTES)), CHALLENGE_REPLY_LENGTH, "challenge"),
    ack("select_info", message(ADDR_DEVICE_INFO, OP_08)),
    step("device_info", message(ADDR_DEVICE_INFO, OP_0A, concatBytes(be(0, 4), be(DEVICE_INFO_LENGTH, 2), new Uint8Array(2))),
      DEVICE_INFO_REPLY_LENGTH, "data"),
    step("query_a_again", queryA, 28, "data"),
    ack("engine_ready", message(ADDR_ENGINE, OP_08)),
    ack("engine_b_ready", message(ADDR_ENGINE_B, OP_08)),
  ];
}

/** The channel list message for a list of inputs. */
export function channelListMessage(inputs) {
  const entries = validateInputs(inputs);
  return message(ADDR_CHANNELS, OP_08, concatBytes(be(entries.length + 2, 2), Uint8Array.from(entries)));
}

/** The rate message for a conversion divisor (timebase divided by divisor is the conversion rate). */
export function rateMessage(divisor) {
  if (!Number.isInteger(divisor) || divisor < DIVISOR_MIN || divisor > DIVISOR_MAX) {
    throw new ProtocolError(`the conversion divisor must be a whole number from ${DIVISOR_MIN} to ${DIVISOR_MAX}`);
  }
  return message(ADDR_ENGINE, OP_09, concatBytes(new Uint8Array(2), be(divisor, 2), new Uint8Array(4), Uint8Array.of(0xFF, 0x00, 0x02, 0x00)));
}

/** The flow-control message for the total bytes received so far. Expects no reply. */
export function creditMessage(totalBytes) {
  const value = (((CREDIT_START - totalBytes) % 2 ** 32) + 2 ** 32) % 2 ** 32;
  return message(ADDR_CREDIT, OP_09, be(value, 4), { flag: 0 });
}

/** The list as an array of ints, or ProtocolError. Any order and repeats are allowed. */
export function validateInputs(inputs) {
  let entries;
  try { entries = Array.from(inputs); } catch (_e) { entries = null; }
  if (inputs == null || typeof inputs === "string" || !entries) throw new ProtocolError("inputs must be a list of input numbers, for example [0, 1, 2]");
  if (!entries.length) throw new ProtocolError("the channel list needs at least one input");
  if (entries.length > MAX_LIST_ENTRIES) {
    throw new ProtocolError(`the channel list has ${entries.length} entries; the longest list is ${MAX_LIST_ENTRIES}`);
  }
  for (const e of entries) {
    if (typeof e !== "number" || !Number.isInteger(e) || e < 0 || e >= INPUT_COUNT) {
      throw new ProtocolError(`input ${JSON.stringify(e)} does not exist; the card has ai0 to ai${INPUT_COUNT - 1}`);
    }
  }
  return entries;
}

export const conversionRateFor = (divisor) => TIMEBASE_HZ / divisor;

/** A validated request: the list, the divisor to send, and the rates the card will really run at. */
export class Configuration {
  constructor(inputs, divisor, requestedRate) {
    this.inputs = Object.freeze(inputs.slice());
    this.divisor = divisor;
    this.requestedRate = requestedRate;
    Object.freeze(this);
  }
  get entries() { return this.inputs.length; }
  get conversionRate() { return conversionRateFor(this.divisor); }
  /** The true rate of each list entry, in frames per second. */
  get ratePerInput() { return this.conversionRate / this.entries; }
  get frameBytes() { return this.entries * BYTES_PER_SAMPLE; }
}

/** Builds the configuration for a list and a rate for each entry, or throws ProtocolError. The true rate is at or just above the request. */
export function makeConfiguration(inputs, ratePerInput) {
  const entries = validateInputs(inputs);
  if (typeof ratePerInput !== "number" || !Number.isFinite(ratePerInput) || ratePerInput <= 0) {
    throw new ProtocolError("the rate must be a number above 0");
  }
  const aggregate = ratePerInput * entries.length;
  if (aggregate > MAX_AGGREGATE_RATE) {
    throw new ProtocolError(
      `${entries.length} entries at ${ratePerInput} per second is ${aggregate} conversions per second; ` +
      `the card's limit is ${MAX_AGGREGATE_RATE} in total`);
  }
  // Small tolerance against floating-point rounding.
  const divisor = Math.floor(TIMEBASE_HZ / aggregate * (1 + 1e-12));
  if (divisor > DIVISOR_MAX) {
    const lowest = TIMEBASE_HZ / DIVISOR_MAX / entries.length;
    throw new ProtocolError(`${ratePerInput} per second is too slow for ${entries.length} entries; the lowest rate is ${lowest.toFixed(3)}`);
  }
  return new Configuration(entries, divisor, ratePerInput);
}

/** The start steps for a configuration. Queue the data reads before the step named READS_BEGIN_BEFORE. */
export function startSteps(config) {
  return [
    ack("channel_read", message(ADDR_CHANNELS, OP_09)),
    ack("channel_list", channelListMessage(config.inputs)),
    ack("rate", rateMessage(config.divisor)),
    ack("opening_credit", message(ADDR_CREDIT, OP_08, be(CREDIT_START, 4))),
    ack("engine_0a", message(ADDR_ENGINE, OP_0A)),
    ack("engine_0b", message(ADDR_ENGINE, OP_0B, new Uint8Array(4))),
    ack("start", message(ADDR_ENGINE, OP_0C)),
  ];
}

export const READS_BEGIN_BEFORE = "engine_0a";

export function stopSteps() {
  return [
    step("stop_0d", message(ADDR_ENGINE, OP_0D), 16, "data"),
    ack("stop_0e", message(ADDR_ENGINE, OP_0E)),
    ack("stop_0f", message(ADDR_ENGINE, OP_0F)),
  ];
}

// Replies

/** The challenge step's message with `challenge` in place of the placeholder bytes. */
export function withChallenge(stepObj, challenge) {
  if (challenge.length !== CHALLENGE_BYTES) throw new ProtocolError(`the challenge is ${CHALLENGE_BYTES} bytes`);
  return concatBytes(stepObj.data.subarray(0, stepObj.data.length - CHALLENGE_BYTES), challenge);
}

/** The USB serial string (8 hex digits) as 4 bytes. */
export const serialBytes = (serialHex) => hexToBytes(serialHex);

/** True when `got` is an acceptable reply to `stepObj`. */
export function replyOk(stepObj, got, challenge, serial) {
  if (got.length !== stepObj.replyLength || got.length < REPLY_HEADER_BYTES) return false;
  if (readBE(got, 2, 2) !== got.length || readBE(got, 4, 2) !== got.length - 4) return false;
  if (!bytesEqual(got.subarray(6, REPLY_HEADER_BYTES), REPLY_STATUS_OK)) return false;
  if (stepObj.kind === "challenge") {
    const want = Uint8Array.from(challenge, (c, i) => c ^ serial[i]);
    return bytesEqual(got.subarray(REPLY_HEADER_BYTES), want);
  }
  return true;
}

/** True when the device information reply holds the unit's serial. */
export function deviceInfoSerialOk(infoReply, serial) {
  return bytesEqual(infoReply.subarray(CAL_SERIAL_OFFSET, CAL_SERIAL_OFFSET + 4), Uint8Array.from(serial).reverse());
}

/** The card's own scale: volts = count * gain + offset. */
export class Calibration {
  constructor(gain, offset) { this.gain = gain; this.offset = offset; Object.freeze(this); }
  get usable() { return Number.isFinite(this.gain) && this.gain > 0 && Number.isFinite(this.offset); }
  volts(count) { return count * this.gain + this.offset; }
}

export function parseCalibration(infoReply) {
  const dv = new DataView(infoReply.buffer, infoReply.byteOffset, infoReply.byteLength);
  return new Calibration(dv.getFloat32(CAL_GAIN_OFFSET, true), dv.getFloat32(CAL_OFFSET_OFFSET, true));
}

/** How long, in ms, the card's buffer holds data at a conversion rate. */
export const deviceBufferMs = (conversionRate) => FIFO_SAMPLES / conversionRate * 1000;

/** Number of reads to keep queued so USB_QUEUE_SECONDS of data can wait. */
export const readQueueDepth = (conversionRate) =>
  Math.max(1, Math.ceil(USB_QUEUE_SECONDS * conversionRate * BYTES_PER_SAMPLE / READ_BYTES));

// Constants shared with the Python version, for the cross-language test.
export const CONSTANTS = Object.freeze({
  VENDOR_ID, CONFIGURATION, INTERFACE, EP_CMD_OUT, EP_REPLY_IN, EP_DATA_IN, EP_STATUS_IN,
  TIMEBASE_HZ, INPUT_COUNT, INPUT_RANGE_V, MAX_AGGREGATE_RATE, FIFO_SAMPLES, MAX_LIST_ENTRIES, DIVISOR_MAX, DIVISOR_MIN,
  BYTES_PER_SAMPLE, READ_BYTES, CREDIT_START, TIMEOUT_MS,
  USB_QUEUE_SECONDS, HALT_DETECT_QUEUE_FRACTION, HALT_DETECT_MS, HALT_POLL_MS, RECOVER_ATTEMPTS, RECOVER_RETRY_WAIT_MS,
  DISCONNECT_GRACE_MS, RECONNECT_WAIT_MS, RECONNECT_POLL_MS,
  SELECTOR, SELECTOR_INFO, HEADER_BYTES, REPLY_HEADER_BYTES,
  ADDR_INFO_QUERY, ADDR_CHALLENGE, ADDR_DEVICE_INFO, ADDR_CHANNELS, ADDR_ENGINE_B, ADDR_ENGINE, ADDR_CREDIT,
  ACK_LENGTH, CHALLENGE_BYTES, CHALLENGE_REPLY_LENGTH, DEVICE_INFO_LENGTH, DEVICE_INFO_REPLY_LENGTH,
  CAL_SERIAL_OFFSET, CAL_GAIN_OFFSET, CAL_OFFSET_OFFSET,
});
