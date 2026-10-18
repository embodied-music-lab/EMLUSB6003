# SPDX-License-Identifier: MIT
"""The driver: open, configure, start, read, stop, close.

    with Usb6003.open_device() as card:
        rate = card.configure([0, 1, 2], 1000)     # inputs ai0, ai1, ai2 at 1000 frames per second
        card.start()
        frames = card.read()                       # raw counts and volts, one value per list entry
        card.stop()
"""
import os
import queue
import sys
import threading
import time
from array import array

from . import protocol as P
from .errors import (DeviceNotReturned, HandshakeError, StartError, StreamLost, TransportError, TransportTimeout,
                     Usb6003Error)
from .transport import Transport


class Frames:
    """A run of whole frames. Each frame holds one value per entry of the channel list, in list order.

    counts       array('h'): raw signed 16-bit counts, frame after frame
    entries      values per frame
    inputs       the input number of each entry
    first_frame  the number of the first frame since start(); it keeps counting across a recovery
    gap_s        None, or the seconds of data lost to a recovered halt just before this run
    """

    def __init__(self, counts, inputs, calibration, first_frame, gap_s=None):
        self.counts, self.inputs, self.calibration = counts, tuple(inputs), calibration
        self.entries, self.first_frame, self.gap_s = len(self.inputs), first_frame, gap_s

    def __len__(self):
        return len(self.counts) // self.entries

    @property
    def volts(self):
        """array('d'): the same values in volts, using the card's own calibration."""
        g, o = self.calibration.gain, self.calibration.offset
        return array("d", (c * g + o for c in self.counts))

    def channel(self, entry, volts=False):
        """The values of one list entry (0 for the first), as counts or volts."""
        values = self.volts if volts else self.counts
        return values[entry::self.entries]

    def rows(self, volts=False):
        """Iterates frames as tuples, one value per entry."""
        values = self.volts if volts else self.counts
        for i in range(0, len(values), self.entries):
            yield tuple(values[i:i + self.entries])

    def _joined(self, others):
        counts = array("h", self.counts)
        for o in others:
            counts.extend(o.counts)
        return Frames(counts, self.inputs, self.calibration, self.first_frame, self.gap_s)


class Usb6003:
    """One NI USB-6003 (or its OEM version). Methods are called from one thread; data is gathered
    on a background thread while streaming.

    on_event(name, **info), if given, is called from that thread with name "halted" (the stream
    stopped; reason) and "recovered" (it restarted; reason, tries, gap_s).
    """

    def __init__(self, transport, on_event=None):
        if not isinstance(transport, Transport):
            raise TypeError("transport must be a Transport; use Usb6003.open_device() for a real card")
        self._t = transport
        self._on_event = on_event
        self._serial = P.serial_bytes(transport.serial_hex)
        self._cmd_lock = threading.Lock()
        self._cv = threading.Condition()
        self._out = []                    # Frames waiting for read()
        self._cfg = None
        self.calibration = None
        self._is_open = self._streaming = False
        self._stop_requested = threading.Event()
        self._pump = None
        self._stream = None
        self._error = None
        self.recoveries = 0

    # ---- construction ---------------------------------------------------------------------

    @classmethod
    def list_devices(cls):
        """[(product name, serial)] of every USB-6003 attached."""
        from .transport import UsbTransport
        return UsbTransport.list_devices()

    @classmethod
    def open_device(cls, serial=None, on_event=None):
        """Finds a card (the one with this serial, if given), opens it and runs the startup exchange."""
        from .transport import UsbTransport
        return cls(UsbTransport(serial), on_event).open()

    @property
    def serial(self):
        return self._t.serial_hex

    @property
    def product_name(self):
        return self._t.product_name

    @property
    def configuration(self):
        return self._cfg

    @property
    def streaming(self):
        return self._streaming

    # ---- commands -------------------------------------------------------------------------

    def _command(self, step, timeout_ms=None):
        """Sends one step and reads its reply. Returns (reply, acceptable)."""
        timeout_ms = timeout_ms or P.TIMEOUT_MS
        with self._cmd_lock:
            data, challenge = step.data, None
            if step.kind == "challenge":
                challenge = os.urandom(P.CHALLENGE_BYTES)
                data = P.with_challenge(step, challenge)
            self._t.write(data, timeout_ms)
            got = self._t.read_reply(timeout_ms)
        return got, P.reply_ok(step, got, challenge, self._serial)

    def _run(self, steps):
        """Sends each step in turn and stops at the first with no reply. Returns (bad, replies):
        the names of the steps whose reply was refused or missing, and each reply by step name."""
        bad, replies = [], {}
        for step in steps:
            try:
                got, ok = self._command(step)
            except TransportError:
                bad.append(step.name)
                break
            replies[step.name] = got
            if not ok:
                bad.append(step.name)
        return bad, replies

    def _handshake(self):
        bad, replies = self._run(P.handshake_steps())
        info = replies.get("device_info")
        if not bad and not P.device_info_serial_ok(info, self._serial):
            bad.append("device_info (serial number)")
        cal = P.parse_calibration(info) if info and not bad else None
        if cal is not None and not cal.usable:
            bad.append("device_info (calibration)")
        return bad, cal

    def open(self):
        """Claims the card, stops anything a previous program left running, runs the startup
        exchange and reads the card's own calibration."""
        self._t.open()
        self._is_open = True
        try:
            self._connect()
        except Exception:
            self._is_open = False
            self._t.close()
            raise
        return self

    def _connect(self):
        # Stop any acquisition left running.
        try:
            self._run(P.stop_steps())
        except Exception:
            pass
        bad, cal = self._handshake()
        if bad:                           # reset once and retry
            try:
                self._t.reset()
                self._t.open()
                bad, cal = self._handshake()
            except TransportError:
                pass
        if bad:
            raise HandshakeError("the card did not answer the startup exchange as expected; the steps that failed: " + ", ".join(bad))
        self.calibration = cal

    def configure(self, inputs, rate_per_input):
        """Sets the channel list and the rate for each entry, and returns the true rate per entry.

        inputs: input numbers 0 to 7 (ai0 to ai7), any order, repeats allowed.
        rate_per_input: requested frames per second. The card runs at the nearest rate its timebase
        allows at or above the request. Raises ProtocolError when the request is outside the card's limits.
        Nothing is sent until start().
        """
        if self._streaming:
            raise Usb6003Error("stop() before configure()")
        self._cfg = P.make_configuration(inputs, rate_per_input)
        return self._cfg.rate_per_input

    # ---- streaming ------------------------------------------------------------------------

    def _send_credit(self, total):
        if self._stop_requested.is_set():
            return
        self._t.write(P.credit_message(total), P.TIMEOUT_MS)

    def _begin_acquisition(self):
        """Sends the start sequence with a read waiting. Returns the
        monotonic time the card acknowledged the start. Raises StartError."""
        cfg = self._cfg
        steps = P.start_steps(cfg)
        k = next(i for i, s in enumerate(steps) if s.name == P.READS_BEGIN_BEFORE)
        bad, _ = self._run(steps[:k])
        if bad:
            raise StartError("the card refused the start sequence at: " + ", ".join(bad))
        self._stream = self._t.open_stream(self._send_credit, P.read_queue_depth(cfg.conversion_rate))
        bad, _ = self._run(steps[k:])
        if bad:
            self._stream.stop()
            raise StartError("the card refused the start sequence at: " + ", ".join(bad))
        return time.monotonic()

    def start(self):
        """Starts streaming. Frames arrive on a background thread; collect them with read()."""
        if not self._is_open:
            raise Usb6003Error("open the card first")
        if self._cfg is None:
            raise Usb6003Error("call configure() before start()")
        if self._streaming:
            raise Usb6003Error("already streaming")
        with self._cv:
            self._out, self._error = [], None
        self._carry, self._frame_index, self._gap_next, self._tries = b"", 0, None, 0
        self._stop_requested.clear()
        self._acq_start = self._begin_acquisition()
        self._last_data = self._acq_start
        self._streaming = True
        self._pump = threading.Thread(target=self._pump_loop, daemon=True)
        self._pump.start()

    def _emit(self, name, **info):
        if self._on_event:
            try:
                self._on_event(name, **info)
            except Exception as e:      # a faulty callback must not stop the stream
                print(f"emlusb6003: on_event raised {e!r}", file=sys.stderr)

    def _deliver(self, block):
        cfg = self._cfg
        buf = self._carry + block
        n = len(buf) // cfg.frame_bytes
        self._carry = buf[n * cfg.frame_bytes:]
        if not n:
            return
        counts = array("h")
        counts.frombytes(buf[:n * cfg.frame_bytes])
        if sys.byteorder == "big":
            counts.byteswap()
        frames = Frames(counts, cfg.inputs, self.calibration, self._frame_index, self._gap_next)
        self._frame_index += n
        self._gap_next = None
        with self._cv:
            self._out.append(frames)
            self._cv.notify_all()

    def _pump_loop(self):
        try:
            while not self._stop_requested.is_set():
                stream = self._stream
                try:
                    block = stream.blocks.get(timeout=0.05)
                except queue.Empty:
                    quiet_ms = (time.monotonic() - self._last_data) * 1000
                    if stream.error or quiet_ms > P.HALT_DETECT_MS:
                        reason = stream.error or f"no data for {quiet_ms / 1000:.1f} s"
                        self._recover(reason, transfer_error=bool(stream.error))
                    continue
                self._last_data = time.monotonic()
                self._tries = 0
                self._deliver(block)
        except Exception as e:
            with self._cv:
                self._error = e if isinstance(e, Usb6003Error) else StreamLost(f"{type(e).__name__}: {e}")
                self._cv.notify_all()

    def _recover(self, reason, transfer_error):
        """Restarts a halted stream, up to RECOVER_ATTEMPTS tries, waiting for a removed device to
        return. Raises StreamLost when the tries are used up."""
        cfg = self._cfg
        self._emit("halted", reason=reason)
        stream = self._stream
        if self._tries == 0:
            self._t_end = self._acq_start + (stream.total // cfg.frame_bytes) / cfg.rate_per_input
        t_end = self._t_end
        try:
            stream.stop()
        except Exception:
            pass
        self._carry = b""
        if transfer_error:
            time.sleep(P.DISCONNECT_GRACE_MS / 1000)
        cancelled = self._stop_requested.is_set
        err = None
        while self._tries < P.RECOVER_ATTEMPTS and not cancelled():
            self._tries += 1
            tries = self._tries
            try:
                if not self._t.present():
                    self._t.wait_for_return(P.RECONNECT_WAIT_MS / 1000, cancelled)
                    if cancelled():
                        return
                else:
                    self._t.reset()
                    if tries >= 2:
                        self._t.refresh()
                self._t.open()
                self._connect()
                self._acq_start = self._begin_acquisition()
                self._last_data = self._acq_start
                self.recoveries += 1
                self._gap_next = self._acq_start - t_end
                self._emit("recovered", reason=reason, tries=tries, gap_s=self._gap_next)
                return
            except DeviceNotReturned as e:
                err = e
                break
            except (Usb6003Error, OSError) as e:
                err = e
                if tries < P.RECOVER_ATTEMPTS and not cancelled():
                    time.sleep(P.RECOVER_RETRY_WAIT_MS / 1000)
        if cancelled():
            return
        if isinstance(err, DeviceNotReturned):
            raise StreamLost(f"{err} ({reason})")
        raise StreamLost(f"the card stopped sending data ({reason}) and did not restart after {P.RECOVER_ATTEMPTS} tries"
                         + (f": {err}" if err else ""))

    def read(self, timeout=1.0):
        """Returns the frames that have arrived, or None when none arrive within `timeout` seconds
        (or at once, when not streaming and nothing is buffered). A run never spans a recovered halt:
        the first run after one carries gap_s. Raises StreamLost when the stream was lost for good,
        after the frames that arrived before it."""
        deadline = time.monotonic() + timeout
        with self._cv:
            while not self._out:
                if self._error:
                    raise self._error
                if not self._streaming:
                    return None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cv.wait(remaining)
            first = self._out.pop(0)
            more = []
            while self._out and self._out[0].gap_s is None:
                more.append(self._out.pop(0))
        return first._joined(more) if more else first

    def stop(self):
        """Stops streaming. Frames already received can still be collected with read()."""
        if not self._streaming:
            return
        self._stop_requested.set()
        if self._pump:
            self._pump.join(P.RECONNECT_WAIT_MS / 1000 + 5)
        # Send the stop steps, deliver the frames already received, then release the stream.
        try:
            self._run(P.stop_steps())
        except TransportError:
            pass
        while True:
            try:
                self._deliver(self._stream.blocks.get_nowait())
            except queue.Empty:
                break
        try:
            self._stream.stop()
        except Exception:
            pass
        try:
            self._t.read_status(300)
            self._t.drain_data()
        except TransportError:
            pass
        self._streaming = False
        with self._cv:
            self._cv.notify_all()

    def close(self):
        """Stops streaming if needed and releases the card."""
        if self._streaming:
            self.stop()
        if self._is_open:
            self._is_open = False
            self._t.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False
