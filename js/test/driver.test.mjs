// SPDX-License-Identifier: MIT
// The driver against the simulated card (all values synthetic).
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/protocol.js";
import { Usb6003Driver } from "../src/driver.js";
import { Usb6003 } from "../src/usb6003.js";
import { SimulatedUsb, SimulatedUsbDevice, SIM_GAIN, SIM_OFFSET, SIM_SERIAL, simCount } from "../src/simulated.js";
import { HandshakeError, ProtocolError, StartError, StreamLost } from "../src/errors.js";

// Shorter waits so recovery tests run quickly.
const FAST = { commandTimeoutMs: 150, haltDetectMs: 400, haltPollMs: 50, recoverRetryWaitMs: 100, disconnectGraceMs: 50, reconnectWaitMs: 5000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, rel = 1e-6) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

function rig(opts = {}, timing = {}) {
  const bus = new SimulatedUsb();
  const device = bus.add(new SimulatedUsbDevice({ ...opts, bus }));
  const messages = [];
  const driver = new Usb6003Driver({ usb: bus, emit: (m) => messages.push(m), timing: { ...FAST, ...timing } });
  return { bus, device, driver, messages };
}

async function openCard(options = {}, timing = {}) {
  return Usb6003.request({ simulated: options, timing: { ...FAST, ...timing } });
}

async function collect(card, ms, timeout = 100) {
  const runs = [], end = Date.now() + ms;
  while (Date.now() < end) { const f = await card.read({ timeout }); if (f) runs.push(f); }
  return runs;
}

test("open reads the card's own calibration and identity", async () => {
  const { driver } = rig();
  const info = await driver.open({});
  assert.equal(info.serialHex, SIM_SERIAL); assert.equal(info.productName, "USB-6003");
  near(info.calibration.gain, SIM_GAIN); near(info.calibration.offset, SIM_OFFSET);
  await driver.close();
});

test("the OEM product ID is accepted", async () => {
  const { driver } = rig({ productId: 0x76C7 });
  assert.equal((await driver.open({})).productName, "USB-6003 (OEM)");
  await driver.close();
});

test("open stops a card a previous page left running", async () => {
  const { driver, device } = rig({ startAcquiring: true });
  await driver.open({});
  assert.equal(device.sent[0], P.bytesToHex(P.stopSteps()[0].data));     // the first message is a stop
  assert.equal(device._streaming, false);
  await driver.close();
});

test("the startup exchange is sent in order", async () => {
  const { driver, device } = rig();
  await driver.open({});
  const handshake = device.sent.slice(3);                        // after the stop messages
  assert.deepEqual(handshake.slice(0, 3).map((h) => parseInt(h.slice(14, 16), 16)), [P.OP_00, P.OP_02, P.OP_20]);
  assert.equal(handshake.length, P.handshakeSteps().length);
  await driver.close();
});

test("a wrong serial in the answers is refused", async () => {
  const { driver, device } = rig();
  device._serial = Uint8Array.of(1, 1, 1, 1);
  await assert.rejects(driver.open({}), HandshakeError);
});

test("a card that does not answer is refused in plain words", async () => {
  const { driver, device } = rig({ haltMode: "unplug" });
  device._wedged = true;
  await assert.rejects(driver.open({}), (e) => e instanceof HandshakeError && /startup exchange/.test(e.message));
});

test("configure returns the true rate and refuses what the card cannot do", async () => {
  const { driver } = rig();
  await driver.open({});
  for (const [inputs, rate] of [[[0, 1, 2, 3, 4, 5, 6, 7], 3000], [[1], 3000], [[0, 2, 4], 2500]]) {
    const n = inputs.length;
    near(driver.configure(inputs, rate).ratePerInput, P.TIMEBASE_HZ / Math.floor(P.TIMEBASE_HZ / (rate * n)) / n);
  }
  assert.equal(driver.configure([0, 1, 2, 3, 4, 5, 6, 7], 12500).ratePerInput, 12500);
  for (const [inputs, rate] of [[[0, 1, 2, 3, 4, 5, 6, 7], 12501], [[8], 100], [[], 100], [[0], 0], [[0], 1000], [Array(17).fill(0), 100]]) {
    assert.throws(() => driver.configure(inputs, rate), ProtocolError);
  }
  assert.equal(driver.cfg.divisor, 800);                         // a refused request leaves the last good one
  await driver.close();
});

test("start requires a configuration", async () => {
  const { driver } = rig();
  await driver.open({});
  await assert.rejects(driver.start(), /configure/);
  await driver.close();
});

test("the card receives the list and divisor that were requested", async () => {
  const { driver, device } = rig();
  await driver.open({});
  driver.configure([7, 3, 3, 0], 5000);
  await driver.start(); await sleep(100); await driver.stop();
  assert.deepEqual(device.configs, [{ inputs: [7, 3, 3, 0], divisor: 4000 }]);     
  await driver.close();
});

for (const [inputs, rate] of [[[0, 1, 2, 3, 4, 5, 6, 7], 9000], [[7, 6, 5, 4, 3, 2, 1, 0], 9000], [[1], 4000], [[1, 1, 1, 1], 3000], [[2, 5, 2, 5, 0], 2000]]) {
  test(`frames arrive whole, in list order, complete: ${inputs.join(",")} at ${rate}`, async () => {
    const card = await openCard({ pieceBytes: 37 });               // blocks that split frames mid-value
    const trueRate = await card.configure(inputs, rate);
    await card.start();
    let runs = await collect(card, 600);
    await card.stop();
    runs = runs.concat(await collect(card, 300, 50));
    await card.close();
    assert.ok(runs.length, "no frames arrived");
    let next = 0, total = 0;
    for (const r of runs) {
      assert.equal(r.entries, inputs.length); assert.deepEqual([...r.inputs], inputs); assert.equal(r.firstFrame, next);
      let i = 0;
      for (const row of r.rows()) { assert.deepEqual(row, inputs.map((n) => simCount(r.firstFrame + i, n))); i++; }
      next += r.length; total += r.length;
    }
    assert.ok(total > 0.2 * trueRate);
  });
}

test("volts use the card's calibration", async () => {
  const card = await openCard();
  await card.configure([0, 4], 1500); await card.start();
  const f = await card.read({ timeout: 2000 });
  await card.stop(); await card.close();
  near(f.volts[0], f.counts[0] * SIM_GAIN + SIM_OFFSET, 1e-5);
  near(f.channel(1, true)[0], f.counts[1] * SIM_GAIN + SIM_OFFSET, 1e-5);
  assert.deepEqual([...f.channel(1)], Array.from({ length: f.length }, (_, i) => simCount(f.firstFrame + i, 4)));
});

test("the stream rate matches the true rate", async () => {
  const card = await openCard();
  const trueRate = await card.configure([0, 1, 2, 3, 4, 5, 6, 7], 9000);
  await card.start();
  const t0 = Date.now();
  const total = (await collect(card, 1000)).reduce((n, r) => n + r.length, 0);
  const elapsed = (Date.now() - t0) / 1000;
  await card.stop(); await card.close();
  near(total / elapsed, trueRate, 0.1);
});

test("credit is the start value minus the bytes received", async () => {
  const { driver, device } = rig();
  await driver.open({});
  driver.configure([0, 1, 2, 3, 4, 5, 6, 7], 9000);
  await driver.start(); await sleep(400);
  await driver.stop();
  const total = driver.totalBytes;
  assert.ok(device.credits.length > 0);
  assert.ok(device.credits.at(-1) >= P.CREDIT_START - total && device.credits.at(-1) < P.CREDIT_START);   // none after stop begins
  assert.ok(device.credits.every((c, i) => i === 0 || c < device.credits[i - 1]));
  await driver.close();
});

test("start without a queued read gets no reply", async () => {
  const { driver, device } = rig();
  await driver.open({});
  driver.configure([0], 1500);
  const { bad } = await driver.runSteps(P.startSteps(driver.cfg));
  assert.deepEqual(bad, ["start"]);
  assert.equal(device.starts, 0);
  await driver.close();
});

test("start fails with StartError when the card refuses", async () => {
  const { driver, device } = rig();
  await driver.open({});
  driver.configure([0], 1500);
  device._wedged = true;
  await assert.rejects(driver.start(), StartError);
  await driver.close();
});

test("no credit is sent once a stop begins and earlier frames are delivered", async () => {
  const { driver, device, messages } = rig();
  await driver.open({});
  driver.configure([0, 1, 2, 3, 4, 5, 6, 7], 9000);
  await driver.start(); await sleep(300);
  const atStop = device.credits.length;
  await driver.stop();
  await sleep(50);
  assert.ok(atStop > 0);
  assert.equal(device.credits.length, atStop);
  const delivered = messages.filter((m) => m.type === "data").reduce((n, m) => n + m.buffer.byteLength, 0);
  assert.ok(delivered > 0);
  assert.equal(delivered + driver.carry.length, driver.acqBytes);
  await driver.close();
});

test("stop then start again restarts the frame count", async () => {
  const card = await openCard();
  await card.configure([2], 3000);
  await card.start(); const a = await card.read({ timeout: 1000 }); await card.stop();
  await card.start(); const b = await card.read({ timeout: 1000 }); await card.stop();
  await card.close();
  assert.equal(a.firstFrame, 0); assert.equal(b.firstFrame, 0);
});

test("close while streaming stops first", async () => {
  const { driver, device } = rig();
  await driver.open({});
  driver.configure([0], 3000); await driver.start(); await sleep(100);
  await driver.close();
  assert.equal(device.sent.at(-1), "0001000c0008010f0d600000");
  assert.equal(device.opened, false);
});

test("read with no stream resolves to null at once", async () => {
  const card = await openCard();
  const t = Date.now();
  assert.equal(await card.read({ timeout: 5000 }), null);
  assert.ok(Date.now() - t < 500);
  await card.close();
});

// ---- halts and disconnects

for (const mode of ["hang", "error", "stall", "wedged"]) {
  test(`a halt is recovered and the gap is reported: ${mode}`, async () => {
    const events = [];
    const card = await openCard({ haltMode: mode, haltAfterMs: 500, haltCount: 2 });
    card.onEvent = (name, info) => events.push([name, info]);
    await card.configure([0, 1, 2, 3, 4, 5, 6, 7], 9000); await card.start();
    const runs = await collect(card, 4500);
    await card.stop(); await card.close();
    const names = events.map(([n]) => n);
    assert.equal(names.filter((n) => n === "halted").length, 2);
    assert.equal(names.filter((n) => n === "recovered").length, 2);
    assert.equal(card.recoveries, 2);
    const gaps = runs.filter((r) => r.gapS != null);
    assert.equal(gaps.length, 2);
    for (const r of gaps) assert.ok(r.gapS > 0.05 && r.gapS < 2.5, `gap ${r.gapS}`);
    let next = 0;
    for (const r of runs) { assert.ok(r.firstFrame >= next); next = r.firstFrame + r.length; }
  });
}

test("a wedged card that needs three resets is recovered by a later, stronger try", async () => {
  const { driver, device, messages } = rig({ haltMode: "wedged", haltAfterMs: 400, resetsToFix: 3 });
  await driver.open({});
  driver.configure([0, 1], 3000); await driver.start();
  await sleep(6000);
  await driver.stop(); await driver.close();
  assert.ok(messages.some((m) => m.type === "recovered"));
  assert.ok(device.resets >= 3);
});

test("a card a reset never fixes is reported and does not hang", async () => {
  const { driver, messages } = rig({ haltMode: "unplug", haltAfterMs: 300 });
  await driver.open({});
  driver.configure([0], 3000); await driver.start();
  const t = Date.now();
  while (!messages.some((m) => m.type === "lost") && Date.now() - t < 20000) await sleep(100);
  const lost = messages.find((m) => m.type === "lost");
  assert.ok(lost, "no loss reported");
  assert.match(lost.message, new RegExp(`did not restart after ${P.RECOVER_ATTEMPTS} tries`));
  assert.equal(lost.name, "StreamLost");
  await driver.close();
});

test("a disconnect that comes back is recovered", async () => {
  const card = await openCard({ disconnectAfterMs: 400, reconnectAfterMs: 800 });
  await card.configure([0, 1, 2, 3, 4, 5, 6, 7], 9000); await card.start();
  const runs = await collect(card, 3500);
  await card.stop(); await card.close();
  assert.equal(card.recoveries, 1);
  const gaps = runs.filter((r) => r.gapS != null).map((r) => r.gapS);
  assert.equal(gaps.length, 1); assert.ok(gaps[0] >= 0.7, `gap ${gaps[0]}`);
});

test("a disconnect that never returns is reported", async () => {
  const card = await openCard({ disconnectAfterMs: 300 }, { reconnectWaitMs: 600 });
  await card.configure([0], 3000); await card.start();
  await assert.rejects((async () => { const t = Date.now(); while (Date.now() - t < 10000) await card.read({ timeout: 200 }); })(),
    (e) => e instanceof StreamLost && /did not reconnect/.test(e.message));
  await card.close();
});

test("close during the wait for a returning device does not hang", async () => {
  const card = await openCard({ disconnectAfterMs: 300 }, { reconnectWaitMs: 20000 });
  await card.configure([0], 3000); await card.start();
  await sleep(1200);
  const t = Date.now();
  await card.close();
  assert.ok(Date.now() - t < 5000);
});

test("a faulty event callback does not stop the stream", async () => {
  const card = await openCard({ haltMode: "hang", haltAfterMs: 300 });
  card.onEvent = () => { throw new Error("callback bug"); };
  await card.configure([0], 3000); await card.start();
  await collect(card, 2500);
  await card.stop(); await card.close();
  assert.equal(card.recoveries, 1);
});

test("a restart that gives no data keeps the gap from the real beginning", async () => {
  // The first restart does not fix this card; the second does. The gap must cover both waits.
  const card = await openCard({ haltMode: "hang", haltAfterMs: 400, resetsToFix: 2 });
  await card.configure([0, 1], 3000); await card.start();
  const runs = await collect(card, 4000);
  await card.stop(); await card.close();
  const gaps = runs.filter((r) => r.gapS != null).map((r) => r.gapS);
  assert.equal(gaps.length, 1); assert.ok(gaps[0] > 0.8, `gap ${gaps[0]}`);
  assert.equal(card.recoveries, 2);                  // each restart the card acknowledged counts
});
