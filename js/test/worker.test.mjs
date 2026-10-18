// SPDX-License-Identifier: MIT
// The Worker's message interface (documented at the top of src/worker.js), driven with a plain scope object.
import test from "node:test";
import assert from "node:assert/strict";
import { attachWorker } from "../src/worker.js";

function scope() {
  const sent = [], waiters = [];
  const s = {
    onmessage: null,
    postMessage(msg) { sent.push(msg); waiters.splice(0).forEach((f) => f()); },
    send(msg) { return s.onmessage({ data: msg }); },
    sent,
    async next(pred, ms = 3000) {
      const t = Date.now();
      for (;;) {
        const hit = sent.find(pred);
        if (hit) return hit;
        if (Date.now() - t > ms) throw new Error("timed out waiting for a message");
        await new Promise((r) => { waiters.push(r); setTimeout(r, 20); });
      }
    },
  };
  attachWorker(s);
  return s;
}
const FAST = { commandTimeoutMs: 150, haltDetectMs: 400, haltPollMs: 50 };

test("every command is answered with the same id and the documented type", async () => {
  const w = scope();
  await w.send({ type: "init", id: 1, simulated: {}, timing: FAST });
  assert.deepEqual(w.sent.find((m) => m.id === 1), { id: 1, type: "ready" });
  await w.send({ type: "open", id: 2 });
  const opened = w.sent.find((m) => m.id === 2);
  assert.equal(opened.type, "opened");
  assert.deepEqual(Object.keys(opened).sort(), ["calibration", "id", "productName", "serialHex", "type"]);
  await w.send({ type: "configure", id: 3, inputs: [0, 1], ratePerInput: 1500 });
  const configured = w.sent.find((m) => m.id === 3);
  assert.equal(configured.type, "configured");
  assert.deepEqual(Object.keys(configured).sort(), ["conversionRate", "divisor", "id", "inputs", "ratePerInput", "type"]);
  await w.send({ type: "start", id: 4 });
  assert.equal(w.sent.find((m) => m.id === 4).type, "started");
  const data = await w.next((m) => m.type === "data");
  assert.deepEqual(Object.keys(data).sort(), ["buffer", "firstFrame", "frames", "gapS", "type"]);
  assert.equal(data.buffer.byteLength, data.frames * 4);          // 2 entries x 2 bytes
  assert.equal(data.gapS, null);
  await w.send({ type: "stop", id: 5 });
  const stopped = w.sent.find((m) => m.id === 5);
  assert.equal(stopped.type, "stopped");
  assert.deepEqual(Object.keys(stopped).sort(), ["bytesAfterStop", "id", "interruptHex", "type"]);
  assert.equal(stopped.interruptHex, "00000010000c00050d60000000000000");
  // every data message for frames received before the stop reply comes before it
  assert.ok(w.sent.indexOf(stopped) > w.sent.lastIndexOf(w.sent.filter((m) => m.type === "data").at(-1)));
  await w.send({ type: "close", id: 6 });
  assert.equal(w.sent.find((m) => m.id === 6).type, "closed");
});

test("failures come back as error messages with the class name and plain text", async () => {
  const w = scope();
  await w.send({ type: "open", id: 1 });                         // before init
  assert.deepEqual(w.sent.find((m) => m.id === 1), { type: "error", id: 1, stage: "open", name: "Usb6003Error", message: "send init first" });
  await w.send({ type: "init", id: 2, simulated: {}, timing: FAST });
  await w.send({ type: "open", id: 3 });
  await w.send({ type: "configure", id: 4, inputs: [9], ratePerInput: 100 });
  const bad = w.sent.find((m) => m.id === 4);
  assert.equal(bad.type, "error"); assert.equal(bad.name, "ProtocolError"); assert.equal(bad.stage, "configure");
  assert.match(bad.message, /does not exist/);
  await w.send({ type: "nonsense", id: 5 });
  assert.match(w.sent.find((m) => m.id === 5).message, /unknown message type/);
  await w.send({ type: "close", id: 6 });
});

test("halted, recovered and data with a gap are sent without a request", async () => {
  const w = scope();
  await w.send({ type: "init", id: 1, simulated: { haltMode: "hang", haltAfterMs: 300 }, timing: FAST });
  await w.send({ type: "open", id: 2 });
  await w.send({ type: "configure", id: 3, inputs: [0], ratePerInput: 3000 });
  await w.send({ type: "start", id: 4 });
  const halted = await w.next((m) => m.type === "halted");
  assert.match(halted.reason, /no data/);
  const recovered = await w.next((m) => m.type === "recovered");
  assert.deepEqual(Object.keys(recovered).sort(), ["gapS", "reason", "tries", "type"]);
  const afterGap = await w.next((m) => m.type === "data" && m.gapS != null);
  assert.ok(afterGap.gapS > 0);
  await w.send({ type: "stop", id: 5 });
  await w.send({ type: "close", id: 6 });
});
