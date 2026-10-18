#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Streams a USB-6003 to a CSV file.

    python3 stream_to_csv.py --inputs 0,1,2 --rate 1000 --seconds 10 --out take.csv
    python3 stream_to_csv.py --simulate --seconds 2 --out sim.csv       (no hardware; synthetic values)

The file has one row per frame: the time in seconds, then one column per list entry in volts
(named e0_ai0, e1_ai1, and so on), or in raw counts with --counts.
"""
import argparse
import csv
import sys
import time

from emlusb6003 import SimulatedCard, Usb6003


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inputs", default="0,1,2,3,4,5,6,7", help="input numbers 0 to 7, in order, repeats allowed (default: all eight)")
    ap.add_argument("--rate", type=float, default=1000.0, help="requested frames per second for each entry (default 1000)")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--out", default="usb6003.csv")
    ap.add_argument("--counts", action="store_true", help="write raw counts instead of volts")
    ap.add_argument("--serial", help="use the card with this serial number")
    ap.add_argument("--simulate", action="store_true", help="use a simulated card with synthetic values")
    args = ap.parse_args()
    inputs = [int(x) for x in args.inputs.split(",")]

    transport = SimulatedCard() if args.simulate else None
    card = Usb6003(transport).open() if transport else Usb6003.open_device(args.serial)
    with card:
        rate = card.configure(inputs, args.rate)
        print(f"{card.product_name}, serial {card.serial}. True rate: {rate:.4f} frames per second for each of {len(inputs)} entries.")
        names = [f"e{k}_ai{n}" for k, n in enumerate(inputs)]
        total, lost = 0, 0.0
        with open(args.out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time_s"] + names)
            card.start()
            end = time.monotonic() + args.seconds
            while time.monotonic() < end:
                frames = card.read(timeout=0.5)
                if frames is None:
                    continue
                lost += frames.gap_s or 0.0
                for i, row in enumerate(frames.rows(volts=not args.counts)):
                    w.writerow([f"{(frames.first_frame + i) / rate + lost:.6f}"] + [f"{v:.6g}" if not args.counts else v for v in row])
                total += len(frames)
            card.stop()
        print(f"Wrote {total} frames to {args.out}." + (f" Recovered gaps totaled {lost:.3f} s." if lost else ""))


if __name__ == "__main__":
    sys.exit(main())
