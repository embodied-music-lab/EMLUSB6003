// SPDX-License-Identifier: MIT
// Protocol builders and reply checks. No hardware.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/protocol.js";

const hex = (b) => P.bytesToHex(b);
const throwsProtocol = (fn, match) => assert.throws(fn, (e) => e instanceof P.ProtocolError && (!match || match.test(e.message)));
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

test("identity table", () => {
  assert.equal(P.VENDOR_ID, 0x3923);
  assert.deepEqual({ ...P.PRODUCTS }, { 0x76C6: "USB-6003", 0x76C7: "USB-6003 (OEM)" });
});

test("limits", () => {
  assert.deepEqual([P.INPUT_COUNT, P.INPUT_RANGE_V, P.MAX_AGGREGATE_RATE, P.TIMEBASE_HZ, P.FIFO_SAMPLES], [8, 10, 100000, 80000000, 2047]);
  assert.equal(P.DIVISOR_MIN, 800);
});

test("message is padded to four and counts length", () => {
  const m = P.message(P.ADDR_CHANNELS, P.OP_08, Uint8Array.of(0, 3, 1));
  assert.equal(m.length % 4, 0);
  assert.equal(P.readBE(m, 2, 2), m.length);
  assert.equal(P.readBE(m, 4, 2), m.length - 4);
  assert.equal(hex(m), "00010010000c01080d30000000030100");
});

test("channel list layout", () => {
  assert.equal(hex(P.channelListMessage([7, 6, 5, 4, 3, 2, 1, 0])), "00010018001401080d300000000a07060504030201000000");
  assert.equal(hex(P.channelListMessage([1])), "00010010000c01080d30000000030100");
});

test("bad lists are refused", () => {
  for (const bad of [[], [8], [-1], [1.5], ["a"], [true], Array(24).fill(0), 5, null, "01"]) throwsProtocol(() => P.channelListMessage(bad));
});

test("any order and repeats are allowed", () => {
  assert.deepEqual(P.validateInputs([3, 3, 0, 7, 3]), [3, 3, 0, 7, 3]);
  assert.equal(P.validateInputs(Array(P.MAX_LIST_ENTRIES).fill(0)).length, P.MAX_LIST_ENTRIES);
});

test("the true rate is at or above the request", () => {
  for (const [inputs, rate] of [[[0, 1, 2], 1000], [[5], 2500], [[0, 1, 2, 3, 4], 4321], [[7, 7], 777]]) {
    const c = P.makeConfiguration(inputs, rate);
    assert.equal(c.divisor, Math.floor(P.TIMEBASE_HZ / (rate * inputs.length)));
    near(c.conversionRate, P.TIMEBASE_HZ / c.divisor);
    near(c.ratePerInput, c.conversionRate / inputs.length);
    assert.ok(c.ratePerInput >= rate);
  }
});

test("the limit is the aggregate rate", () => {
  P.makeConfiguration([0, 1, 2, 3, 4, 5, 6, 7], 12500);
  P.makeConfiguration([0], 100000);
  throwsProtocol(() => P.makeConfiguration([0, 1, 2, 3, 4, 5, 6, 7], 12501), /limit/);
  throwsProtocol(() => P.makeConfiguration([0], 100001), /limit/);
  throwsProtocol(() => P.makeConfiguration([0, 1], 50001), /limit/);
});

test("bad rates are refused", () => {
  for (const rate of [0, -5, NaN, Infinity, "100", null, true]) throwsProtocol(() => P.makeConfiguration([0], rate));
});

test("a rate below the divisor field is refused", () => {
  throwsProtocol(() => P.makeConfiguration([0], 1000), /too slow/);
  P.makeConfiguration([0], 1221);
});

test("rateMessage refuses divisors outside the field", () => {
  for (const d of [0, 799, 65536, 833.5]) throwsProtocol(() => P.rateMessage(d));
});

test("credit counts down from the start value", () => {
  assert.equal(hex(P.creditMessage(0)), "00010010000c0009000200027fffffff");
  assert.equal(hex(P.creditMessage(7680)), "00010010000c0009000200027fffe1ff");
  assert.equal(P.readBE(P.creditMessage(1000000), 12, 4), P.CREDIT_START - 1000000);
  assert.equal(P.readBE(P.creditMessage(P.CREDIT_START + 1), 12, 4), 0xFFFFFFFF);
});

function fakeReply(length, payload = new Uint8Array(0)) {
  const out = new Uint8Array(length);
  out[1] = 1; out[2] = length >> 8; out[3] = length & 255; out[4] = (length - 4) >> 8; out[5] = (length - 4) & 255;
  out.set(P.REPLY_STATUS_OK, 6); out.set(payload, 12);
  return out;
}

test("reply checks", () => {
  const ack = P.startSteps(P.makeConfiguration([0], 1221))[0];
  assert.ok(P.replyOk(ack, fakeReply(12)));
  assert.ok(!P.replyOk(ack, fakeReply(16)));
  const wrongStatus = fakeReply(12); wrongStatus[11] = 3;
  assert.ok(!P.replyOk(ack, wrongStatus));
  assert.ok(!P.replyOk(ack, new Uint8Array(12)));
  const badLength = fakeReply(12); badLength[3] = 8;
  assert.ok(!P.replyOk(ack, badLength));
});

test("handshake reply check", () => {
  const step = P.handshakeSteps().find((s) => s.name === "challenge");
  const challenge = Uint8Array.of(1, 2, 3, 4), serial = Uint8Array.of(0xF0, 0x0F, 0xAA, 0x55);
  const msg = P.withChallenge(step, challenge);
  assert.equal(msg.length, 16);
  assert.deepEqual(msg.slice(12), challenge);
  assert.deepEqual(msg.slice(0, 12), step.data.slice(0, 12));
  assert.ok(P.replyOk(step, fakeReply(16, Uint8Array.from(challenge, (c, i) => c ^ serial[i])), challenge, serial));
  assert.ok(!P.replyOk(step, fakeReply(16, challenge), challenge, serial));
});

test("the calibration is read from the device info reply", () => {
  const reply = new Uint8Array(P.DEVICE_INFO_REPLY_LENGTH), dv = new DataView(reply.buffer);
  dv.setFloat32(P.CAL_GAIN_OFFSET, 0.5, true); dv.setFloat32(P.CAL_OFFSET_OFFSET, 0.25, true);
  const cal = P.parseCalibration(reply);
  assert.deepEqual([cal.gain, cal.offset, cal.usable, cal.volts(10)], [0.5, 0.25, true, 5.25]);
  for (const [g, o] of [[0, 0], [-1, 0], [NaN, 0], [1, Infinity]]) {
    dv.setFloat32(P.CAL_GAIN_OFFSET, g, true); dv.setFloat32(P.CAL_OFFSET_OFFSET, o, true);
    assert.ok(!P.parseCalibration(reply).usable);
  }
});

test("the serial is checked byte-reversed", () => {
  const reply = new Uint8Array(P.DEVICE_INFO_REPLY_LENGTH);
  reply.set([4, 3, 2, 1], P.CAL_SERIAL_OFFSET);
  assert.ok(P.deviceInfoSerialOk(reply, Uint8Array.of(1, 2, 3, 4)));
  assert.ok(!P.deviceInfoSerialOk(reply, Uint8Array.of(4, 3, 2, 1)));
});

test("the read queue and the buffer follow the rate", () => {
  for (const rate of [1221, 20000, 90000]) {
    assert.equal(P.readQueueDepth(rate), Math.max(1, Math.ceil(P.USB_QUEUE_SECONDS * rate * P.BYTES_PER_SAMPLE / P.READ_BYTES)));
    near(P.deviceBufferMs(rate), P.FIFO_SAMPLES / rate * 1000);
  }
});
