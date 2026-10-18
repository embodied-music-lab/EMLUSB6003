// SPDX-License-Identifier: MIT
// Prints what protocol.js produces as JSON, for tests/test_cross_language.py to compare with protocol.py.
import * as P from "../src/protocol.js";

const hex = (steps) => steps.map((s) => ({ name: s.name, hex: P.bytesToHex(s.data), replyLength: s.replyLength, kind: s.kind }));
const cases = JSON.parse(process.argv[2]);

const out = {
  constants: P.CONSTANTS,
  products: Object.fromEntries(Object.entries(P.PRODUCTS)),
  replyStatusOk: P.bytesToHex(P.REPLY_STATUS_OK),
  stopInterrupt: P.bytesToHex(P.STOP_INTERRUPT),
  readsBeginBefore: P.READS_BEGIN_BEFORE,
  handshake: hex(P.handshakeSteps()),
  stop: hex(P.stopSteps()),
  credits: Object.fromEntries(cases.credits.map((n) => [n, P.bytesToHex(P.creditMessage(n))])),
  configs: cases.configs.map(([inputs, rate]) => {
    try {
      const c = P.makeConfiguration(inputs, rate);
      return { ok: true, divisor: c.divisor, conversionRate: c.conversionRate, ratePerInput: c.ratePerInput, frameBytes: c.frameBytes, start: hex(P.startSteps(c)) };
    } catch (e) { return { ok: false, error: e.name }; }
  }),
  queueDepths: cases.rates.map((r) => P.readQueueDepth(r)),
  bufferMs: cases.rates.map((r) => P.deviceBufferMs(r)),
};
console.log(JSON.stringify(out));
