// SPDX-License-Identifier: MIT
// A run of whole frames. Each frame holds one value per entry of the channel list, in list order.
//
//   counts      Int16Array: raw signed 16-bit counts, frame after frame
//   volts       Float64Array: the same values in volts, using the card's own calibration (computed on first use)
//   entries     values per frame
//   inputs      the input number of each entry
//   firstFrame  the number of the first frame since start(); it keeps counting across a recovery
//   gapS        null, or the seconds of data lost to a recovered halt just before this run

export class Frames {
  constructor(counts, inputs, calibration, firstFrame, gapS = null) {
    this.counts = counts; this.inputs = Object.freeze(Array.from(inputs)); this.calibration = calibration;
    this.entries = this.inputs.length; this.firstFrame = firstFrame; this.gapS = gapS;
    this._volts = null;
  }
  get length() { return this.counts.length / this.entries; }
  get volts() {
    if (!this._volts) {
      const { gain, offset } = this.calibration;
      this._volts = Float64Array.from(this.counts, (c) => c * gain + offset);
    }
    return this._volts;
  }
  /** The values of one list entry (0 for the first), as counts or volts. */
  channel(entry, volts = false) {
    const src = volts ? this.volts : this.counts, out = new (volts ? Float64Array : Int16Array)(this.length);
    for (let i = 0; i < out.length; i++) out[i] = src[i * this.entries + entry];
    return out;
  }
  /** Iterates frames as arrays, one value per entry. */
  *rows(volts = false) {
    const src = volts ? this.volts : this.counts;
    for (let i = 0; i < src.length; i += this.entries) yield Array.from(src.subarray(i, i + this.entries));
  }
  /** This run followed by others that carry no gap, as one run. */
  joined(others) {
    const total = this.counts.length + others.reduce((n, o) => n + o.counts.length, 0);
    const counts = new Int16Array(total);
    let at = 0;
    for (const f of [this, ...others]) { counts.set(f.counts, at); at += f.counts.length; }
    return new Frames(counts, this.inputs, this.calibration, this.firstFrame, this.gapS);
  }
}
