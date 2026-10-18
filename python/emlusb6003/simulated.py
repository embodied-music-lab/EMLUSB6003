# SPDX-License-Identifier: MIT
"""A simulated USB-6003 for tests and demos with no hardware.

SimulatedCard answers the driver's messages, parses the channel list and rate it is sent, and
streams frames at the implied rate. All values are synthetic: the serial number, the calibration
and the sample values (a counter pattern, see sim_count).

Faults, for testing recovery: halt_mode is one of
  "hang"        data stops; commands are still answered
  "error"       the data read fails with a transfer error
  "wedged"      data stops and no command is answered
  "disconnect"  as "error", then the device leaves the bus for gone_s seconds (None: for good)
  "unplug"      as "hang", and reset() never ends it
reset() ends a halt after resets_to_fix calls (except "unplug"). halt_after_s is the time after each
start at which a halt strikes; halts is how many starts get one.
"""
import queue
import random
import struct
import threading
import time

from . import protocol as P
from .errors import DeviceNotReturned, TransportError, TransportTimeout
from .transport import Stream, Transport

SIM_SERIAL = "0a0b0c0d"          # synthetic
SIM_GAIN = 3.0e-4                # synthetic volts per count
SIM_OFFSET = 0.01                # synthetic offset in volts
SIM_TICK_S = 0.002


def sim_count(frame, input_number):
    """The synthetic count a SimulatedCard sends for input `input_number` in frame number `frame`."""
    return (input_number + 1) * 1000 + frame % 1000


def _reply(selector, total, payload=b""):
    body = P.REPLY_STATUS_OK + bytes(payload)
    body = body.ljust(total - P.HEADER_BYTES, b"\0")
    return selector + total.to_bytes(2, "big") + (total - 4).to_bytes(2, "big") + body


def _device_info_payload(serial, product_id, gain, offset):
    """A synthetic device information block."""
    block = bytearray(b"\xff" * (P.DEVICE_INFO_REPLY_LENGTH - P.REPLY_HEADER_BYTES))
    h = P.REPLY_HEADER_BYTES

    def put(offset_in_reply, data):
        block[offset_in_reply - h:offset_in_reply - h + len(data)] = data
    put(P.CAL_SERIAL_OFFSET, bytes(reversed(serial)))
    put(h + 0x0A, struct.pack("<HxxHxx", P.VENDOR_ID, product_id))
    put(h + 0x13, b"National Instruments".ljust(0x37 - 0x13, b"\0"))
    put(h + 0x37, P.PRODUCTS[product_id].encode().ljust(16, b"\0"))
    for k in range(12):
        put(P.CAL_GAIN_OFFSET + 8 * k, struct.pack("<ff", gain, offset))
    return bytes(block)


class SimStream(threading.Thread, Stream):
    """The simulated data stream."""

    def __init__(self, card, credit, chunk_bytes):
        threading.Thread.__init__(self, daemon=True)
        self.card, self.credit, self.chunk_bytes = card, credit, chunk_bytes
        self.blocks, self.total, self.error, self.running = queue.Queue(), 0, None, True
        self.longest_stall_s = 0.0

    def run(self):
        card, pending, last_put = self.card, bytearray(), time.monotonic()
        while self.running:
            time.sleep(SIM_TICK_S)
            now = time.monotonic()
            if card.is_gone():
                self.error = "transfer error: the device is gone"
                return
            if card.halted in ("error", "disconnect"):
                self.error = "transfer error"
                return
            if card.halted:
                last_put = now
                continue
            pending += card.make_bytes(now)
            while pending:
                n = min(len(pending), P.READ_BYTES, self.chunk_bytes or P.READ_BYTES)
                block = bytes(pending[:n])
                del pending[:n]
                self.total += len(block)
                try:
                    self.credit(self.total)
                except TransportError as e:
                    self.error = f"credit failed: {e}"
                    return
                self.blocks.put(block)
                self.longest_stall_s, last_put = max(self.longest_stall_s, now - last_put), now
                if self.chunk_bytes == 0:
                    break

    def stop(self):
        self.running = False
        self.join(1)


class SimulatedCard(Transport):
    def __init__(self, serial_hex=SIM_SERIAL, product_id=0x76C6, gain=SIM_GAIN, offset=SIM_OFFSET,
                 halt_mode=None, halt_after_s=1.0, halts=1, resets_to_fix=1, gone_s=None,
                 already_streaming=False, chunk_bytes=0):
        if product_id not in P.PRODUCTS:
            raise ValueError(f"unknown product ID 0x{product_id:04x}")
        self.serial_hex, self.product_id = serial_hex, product_id
        self.product_name = P.PRODUCTS[product_id]
        self.serial = bytes.fromhex(serial_hex)
        self.gain, self.offset = gain, offset
        self.halt_mode, self.halt_after_s, self.halts_left = halt_mode, halt_after_s, halts
        self.resets_to_fix, self.gone_s = resets_to_fix, gone_s
        self.chunk_bytes = chunk_bytes
        self.lock = threading.Lock()
        # state a test can inspect
        self.sent = []                  # every message written, except credits
        self.credits = []               # the value of every credit written
        self.resets = 0
        self.starts = 0
        self.halt_times = []
        self.configs = []               # (inputs, divisor) at each start
        self.stream = None
        self.is_open = False
        # simulated card state
        self.halted = None
        self.wedged = False
        self.gone_until = None
        self._resets_seen = 0
        self._inputs, self._divisor = (), None
        self._streaming = already_streaming
        self._t0, self._made, self._reply_bytes = time.monotonic(), 0, None
        self._status_ready = False
        self._rng = random.Random(1)

    # ---- card model -------------------------------------------------------------------------

    def is_gone(self):
        return self.gone_until is not None and time.monotonic() < self.gone_until

    @property
    def rate_per_input(self):
        return P.TIMEBASE_HZ / self._divisor / len(self._inputs)

    def make_bytes(self, now):
        """The bytes produced since the last call: whole frames at the configured rate."""
        if not self._streaming or not self._inputs:
            return b""
        n = int((now - self._t0) * self.rate_per_input) - self._made
        if n <= 0:
            return b""
        f0, out = self._made, bytearray()
        for f in range(f0, f0 + n):
            for i in self._inputs:
                out += struct.pack("<h", sim_count(f, i))
        self._made += n
        return bytes(out)

    def _begin_halt(self, session):
        if session != self.starts or not self._streaming:
            return
        self.halted = self.halt_mode
        self.halt_times.append(time.monotonic())
        if self.halt_mode == "wedged":
            self.wedged = True
        if self.halt_mode == "disconnect":
            self.gone_until = time.monotonic() + (self.gone_s if self.gone_s is not None else 1e9)

    def _answer(self, data):
        selector, flag, op = data[0:2], data[6], data[7]
        address = int.from_bytes(data[8:12], "big")
        operands = data[12:]
        ack = _reply(selector, P.ACK_LENGTH)
        if address == P.ADDR_INFO_QUERY and selector == P.SELECTOR_INFO.to_bytes(2, "big"):
            return _reply(selector, 28 if op == P.OP_00 else 24)
        if address == P.ADDR_CHALLENGE and op == P.OP_20:
            challenge = operands[:P.CHALLENGE_BYTES]
            return _reply(selector, P.CHALLENGE_REPLY_LENGTH, bytes(a ^ b for a, b in zip(challenge, self.serial)))
        if address == P.ADDR_DEVICE_INFO and op == P.OP_0A:
            return _reply(selector, P.DEVICE_INFO_REPLY_LENGTH,
                          _device_info_payload(self.serial, self.product_id, self.gain, self.offset))
        if address == P.ADDR_CHANNELS and op == P.OP_08:
            count = int.from_bytes(operands[:2], "big") - 2
            self._inputs = tuple(operands[2:2 + count])
            return ack
        if address == P.ADDR_ENGINE and op == P.OP_09:
            self._divisor = int.from_bytes(operands[2:4], "big")
            return ack
        if address == P.ADDR_ENGINE and op == P.OP_0C:
            if self.stream is None or not self._inputs or not self._divisor:
                return None              # no stream open: no reply
            self._streaming, self._t0, self._made, self.starts = True, time.monotonic(), 0, self.starts + 1
            self.configs.append((self._inputs, self._divisor))
            if self.halt_mode and self.halts_left > 0:
                self.halts_left -= 1
                session = self.starts
                threading.Timer(self.halt_after_s, self._begin_halt, (session,)).start()
            return ack
        if address == P.ADDR_ENGINE and op == P.OP_0D:
            self._streaming, self._status_ready = False, True
            return _reply(selector, 16)
        if address in (P.ADDR_DEVICE_INFO, P.ADDR_ENGINE, P.ADDR_ENGINE_B, P.ADDR_CHANNELS, P.ADDR_CREDIT):
            return ack
        return None

    # ---- Transport --------------------------------------------------------------------------

    def open(self):
        if self.is_gone():
            raise TransportError("the device is gone")
        self.is_open = True

    def close(self):
        self.is_open = False

    def reset(self):
        self.resets += 1
        self._resets_seen += 1
        self._streaming, self._reply_bytes = False, None
        if self.halt_mode != "unplug" and self._resets_seen >= self.resets_to_fix and not self.is_gone():
            self.halted, self.wedged, self._resets_seen = None, False, 0

    def present(self):
        return not self.is_gone()

    def refresh(self):
        if self.is_gone():
            raise TransportError("the device is not on the USB bus")

    def wait_for_return(self, timeout_s, cancelled):
        deadline = time.monotonic() + timeout_s
        while not cancelled():
            if not self.is_gone():
                self.halted, self.gone_until, self._streaming = None, None, False
                return
            if time.monotonic() >= deadline:
                raise DeviceNotReturned(f"the device was disconnected and did not reconnect within {timeout_s:g} s")
            time.sleep(0.02)

    def write(self, data, timeout_ms):
        data = bytes(data)
        with self.lock:
            if self.is_gone():
                raise TransportError("the device is gone")
            if data[6] == 0 and data[7] == P.OP_09 and int.from_bytes(data[8:12], "big") == P.ADDR_CREDIT:
                self.credits.append(int.from_bytes(data[12:16], "big"))
                return
            self.sent.append(data)
            if self.wedged:
                self._reply_bytes = None
                return
            self._reply_bytes = self._answer(data)

    def read_reply(self, timeout_ms):
        with self.lock:
            if self.is_gone():
                raise TransportError("the device is gone")
            reply, self._reply_bytes = self._reply_bytes, None
        if reply is None:
            time.sleep(timeout_ms / 1000)
            raise TransportTimeout("no reply")
        return reply

    def read_status(self, timeout_ms):
        if self._status_ready:
            self._status_ready = False
            return P.STOP_INTERRUPT
        time.sleep(min(timeout_ms, 50) / 1000)
        return b""

    def open_stream(self, credit, queued):
        self.stream = SimStream(self, credit, self.chunk_bytes)
        self.stream.queued = queued
        self.stream.start()
        return self.stream

    def drain_data(self, timeout_ms=300):
        return 0
