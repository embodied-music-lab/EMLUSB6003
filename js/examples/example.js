// SPDX-License-Identifier: MIT
// Lists, opens, configures and streams a USB-6003, and shows live numbers for each list entry.
import { Usb6003 } from "../src/index.js";

const $ = (id) => document.getElementById(id);
let card = null, running = false, framesTotal = 0, lostSeconds = 0, stats = [];

const say = (text) => { $("status").textContent = text; };
const log = (text) => { const l = $("log"); l.textContent += `${new Date().toLocaleTimeString()}  ${text}\n`; l.scrollTop = l.scrollHeight; };
const buttons = (state) => { for (const [id, on] of Object.entries(state)) $(id).disabled = !on; };

if (!Usb6003.supported && !$("simulated").checked) say("This browser has no WebUSB. Use Chrome or Edge, or tick the simulated card.");

$("connect").onclick = async () => {
  try {
    const simulated = $("simulated").checked;
    card = await Usb6003.request({ simulated: simulated ? {} : undefined, onEvent });
    say(`Opened ${card.productName}, serial ${card.serial}.`);
    log(`Calibration read from the card: ${card.calibration.gain} V per count, offset ${card.calibration.offset} V`);
    buttons({ configure: true, start: false, stop: false, close: true, connect: false });
  } catch (e) { say(`${e.name}: ${e.message}`); }
};

$("configure").onclick = async () => {
  try {
    const inputs = $("inputs").value.split(",").map((s) => Number(s.trim()));
    const rate = await card.configure(inputs, Number($("rate").value));
    say(`The card will run at ${rate.toFixed(4)} frames per second for each of ${inputs.length} entries.`);
    $("values").innerHTML = inputs.map((n, k) => `<tr><td>entry ${k}, ai${n}</td><td id="v${k}">-</td><td id="lo${k}">-</td><td id="hi${k}">-</td><td id="c${k}">-</td></tr>`).join("");
    stats = inputs.map(() => ({ lo: Infinity, hi: -Infinity }));
    buttons({ start: true });
  } catch (e) { say(`${e.name}: ${e.message}`); }
};

$("start").onclick = async () => {
  try {
    framesTotal = 0; lostSeconds = 0;
    stats.forEach((s) => { s.lo = Infinity; s.hi = -Infinity; });
    await card.start();
    running = true;
    buttons({ configure: false, start: false, stop: true, close: false });
    pump();
  } catch (e) { say(`${e.name}: ${e.message}`); }
};

$("stop").onclick = async () => {
  running = false;
  try { await card.stop(); } catch (e) { say(`${e.name}: ${e.message}`); }
  buttons({ configure: true, start: true, stop: false, close: true });
};

$("close").onclick = async () => {
  try { await card.close(); } catch (e) { say(`${e.name}: ${e.message}`); }
  card = null; running = false;
  buttons({ connect: true, configure: false, start: false, stop: false, close: false });
  say("Closed.");
};

function onEvent(name, info) {
  if (name === "halted") log(`The stream stopped (${info.reason}). The driver is restarting it.`);
  if (name === "recovered") log(`The stream restarted after ${(info.gapS * 1000).toFixed(0)} ms without data (try ${info.tries}).`);
  if (name === "warning") log(info.message);
}

// Reads whatever has arrived, about 10 times a second, and shows the newest frame.
async function pump() {
  while (running) {
    let frames;
    try { frames = await card.read({ timeout: 100 }); } catch (e) { say(`${e.name}: ${e.message}`); running = false; buttons({ configure: true, start: true, stop: false, close: true }); return; }
    if (!frames) continue;
    framesTotal += frames.length; lostSeconds += frames.gapS || 0;
    const volts = frames.volts, n = frames.entries, last = frames.length - 1;
    for (let k = 0; k < n; k++) {
      const s = stats[k];
      for (let i = k; i < volts.length; i += n) { if (volts[i] < s.lo) s.lo = volts[i]; if (volts[i] > s.hi) s.hi = volts[i]; }
      $(`v${k}`).textContent = volts[last * n + k].toFixed(4);
      $(`lo${k}`).textContent = s.lo.toFixed(4); $(`hi${k}`).textContent = s.hi.toFixed(4);
      $(`c${k}`).textContent = frames.counts[last * n + k];
    }
    $("totals").textContent = `${framesTotal} frames received` + (lostSeconds ? `, ${lostSeconds.toFixed(3)} s lost to recovered halts` : "") + ".";
  }
}
