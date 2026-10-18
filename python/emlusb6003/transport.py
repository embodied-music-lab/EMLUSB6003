# SPDX-License-Identifier: MIT
"""The USB layer. `Transport` is the interface the driver uses; `UsbTransport` implements it with
pyusb and libusb. `SimulatedCard` (simulated.py) implements it with no hardware."""
import os
import queue
import sys
import threading
import time

from . import protocol as P
from .errors import DeviceNotFound, DeviceNotReturned, TransportError, TransportTimeout


class Stream:
    """A running data stream.

    blocks   queue.Queue of bytes, one item per completed read
    total    bytes received so far
    error    None, or text describing why the stream ended
    """
    blocks = None
    total = 0
    error = None

    def stop(self):
        raise NotImplementedError


class Transport:
    """What the driver needs from the USB layer. All methods raise TransportError (or its subclass
    TransportTimeout) when a transfer fails."""
    serial_hex = ""
    product_name = ""

    def open(self):
        """Select configuration 1 and claim interface 0."""
        raise NotImplementedError

    def close(self):
        """Release the interface and free the handle."""
        raise NotImplementedError

    def reset(self):
        """Best-effort bus reset: release, reset, free. Call open() afterwards."""
        raise NotImplementedError

    def present(self):
        """True when the device is on the USB bus."""
        raise NotImplementedError

    def refresh(self):
        """Find the device again and take the new handle (a stronger try than reset)."""
        raise NotImplementedError

    def wait_for_return(self, timeout_s, cancelled):
        """Wait for a device that left the bus to enumerate again and take its handle. Raises
        DeviceNotReturned after timeout_s. Returns early when cancelled() turns true."""
        raise NotImplementedError

    def write(self, data, timeout_ms):
        raise NotImplementedError

    def read_reply(self, timeout_ms):
        raise NotImplementedError

    def read_status(self, timeout_ms):
        raise NotImplementedError

    def open_stream(self, credit, queued):
        """Starts the data stream with `queued` reads. Returns a Stream."""
        raise NotImplementedError

    def drain_data(self, timeout_ms=300):
        """Reads and discards leftover data after a stop; returns the byte count."""
        raise NotImplementedError


# pyusb / libusb

def _usb():
    try:
        import usb.core
        import usb.util
        import usb.backend.libusb1
    except ImportError:
        raise DeviceNotFound("pyusb is not installed. Run:  python3 -m pip install pyusb") from None
    return usb


def find_backend():
    """The libusb backend, or None."""
    usb = _usb()
    backend = usb.backend.libusb1.get_backend()
    if backend is None:
        for path in ("/usr/local/lib/libusb-1.0.dylib", "/opt/homebrew/lib/libusb-1.0.dylib"):
            if os.path.exists(path):
                backend = usb.backend.libusb1.get_backend(find_library=lambda _n, p=path: p)
                if backend:
                    break
    return backend


def _matches(d, serial_hex=None):
    if d.idVendor != P.VENDOR_ID or d.idProduct not in P.PRODUCTS:
        return False
    if serial_hex is None:
        return True
    try:
        return _usb().util.get_string(d, d.iSerialNumber) == serial_hex
    except Exception:
        return False


def _call(fn, *args):
    """Runs a pyusb call and maps libusb errors to ours."""
    usb = _usb()
    try:
        return fn(*args)
    except usb.core.USBTimeoutError as e:
        raise TransportTimeout(str(e)) from e
    except usb.core.USBError as e:
        raise TransportError(str(e)) from e


class DataReader(threading.Thread, Stream):
    """Reads one block at a time. Used when queued reads are unavailable."""

    def __init__(self, dev, credit):
        threading.Thread.__init__(self, daemon=True)
        self.dev, self.credit = dev, credit
        self.blocks, self.total, self.error, self.running = queue.Queue(), 0, None, True

    def run(self):
        usb = _usb()
        while self.running:
            try:
                block = bytes(self.dev.read(P.EP_DATA_IN, P.READ_BYTES, 200))
            except usb.core.USBTimeoutError:
                continue
            except usb.core.USBError as e:
                self.error = str(e)
                break
            if block:
                self.total += len(block)
                try:
                    self.credit(self.total)
                except TransportError as e:
                    self.error = f"credit failed: {e}"
                    break
                self.blocks.put(block)

    def stop(self):
        self.running = False
        self.join(2)


class QueuedDataReader(threading.Thread, Stream):
    """Keeps several reads queued, using libusb's asynchronous transfers through pyusb's handle."""

    def __init__(self, dev, credit, queued):
        threading.Thread.__init__(self, daemon=True)
        import ctypes
        import usb.backend.libusb1 as lb
        self.ct, self.lb = ctypes, lb
        self.dev, self.credit = dev, credit
        self.blocks, self.total, self.error, self.running, self.credited = queue.Queue(), 0, None, True, 0
        backend = dev._ctx.backend
        self.lib, self.ctx, self.handle = backend.lib, backend.ctx, dev._ctx.handle.handle

        class Timeval(ctypes.Structure):
            _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]
        self.tv = Timeval(0, 100000)
        self.lib.libusb_handle_events_timeout.argtypes = [ctypes.c_void_p, ctypes.POINTER(Timeval)]
        self.lib.libusb_handle_events_timeout.restype = ctypes.c_int
        self.lib.libusb_cancel_transfer.argtypes = [ctypes.POINTER(lb._libusb_transfer)]
        self.lib.libusb_cancel_transfer.restype = ctypes.c_int
        self.callback = lb._libusb_transfer_cb_fn_p(self._done)    # kept alive for libusb
        self.transfers, self.buffers, self.in_flight = [], [], 0
        for _ in range(queued):
            t = self.lib.libusb_alloc_transfer(0)
            buf = ctypes.create_string_buffer(P.READ_BYTES)
            c = t.contents
            c.dev_handle, c.flags, c.endpoint, c.type = self.handle, 0, P.EP_DATA_IN, 2   # 2 = bulk
            c.timeout, c.length = 0, P.READ_BYTES
            c.buffer = ctypes.cast(buf, ctypes.c_void_p)
            c.callback = self.callback
            self.transfers.append(t)
            self.buffers.append(buf)

    def _done(self, t):
        # Transfer-complete callback; only resubmits.
        c = t.contents
        self.in_flight -= 1
        if c.status == 0:                        # completed
            if c.actual_length:
                block = self.ct.string_at(c.buffer, c.actual_length)
                self.total += len(block)
                self.blocks.put(block)
            if self.running and self.lib.libusb_submit_transfer(t) == 0:
                self.in_flight += 1
        elif c.status != 3 and self.error is None:   # 3 = cancelled
            self.error = f"data read ended with libusb transfer status {c.status}"
            self.running = False

    def run(self):
        for t in self.transfers:
            if self.lib.libusb_submit_transfer(t) == 0:
                self.in_flight += 1
        while self.running:
            self.lib.libusb_handle_events_timeout(self.ctx, self.ct.byref(self.tv))
            if self.total != self.credited:
                self.credited = self.total
                try:
                    self.credit(self.credited)
                except TransportError as e:
                    self.error, self.running = f"credit failed: {e}", False
        for t in self.transfers:
            self.lib.libusb_cancel_transfer(t)
        deadline = time.monotonic() + 2
        while self.in_flight > 0 and time.monotonic() < deadline:
            self.lib.libusb_handle_events_timeout(self.ctx, self.ct.byref(self.tv))
        if self.in_flight == 0:
            for t in self.transfers:
                self.lib.libusb_free_transfer(t)

    def stop(self):
        self.running = False
        self.join(3)


class UsbTransport(Transport):
    """A USB-6003 reached through pyusb and libusb."""

    def __init__(self, serial=None, backend=None):
        usb = _usb()
        self.usb = usb
        self.backend = backend or find_backend()
        if self.backend is None:
            raise DeviceNotFound("libusb was not found. macOS: brew install libusb. Debian or Ubuntu: sudo apt install libusb-1.0-0")
        self.wanted_serial = serial
        self.dev = self._find()
        if self.dev is None:
            raise DeviceNotFound("No USB-6003 found. Is it plugged in, and is no other program using it?")
        self.serial_hex = usb.util.get_string(self.dev, self.dev.iSerialNumber)
        self.product_name = P.PRODUCTS[self.dev.idProduct]
        self.wanted_serial = self.serial_hex     # later finds match this unit

    def _find(self):
        return self.usb.core.find(custom_match=lambda d: _matches(d, self.wanted_serial), backend=self.backend)

    @staticmethod
    def list_devices(backend=None):
        """[(product name, serial)] of every USB-6003 attached."""
        usb = _usb()
        backend = backend or find_backend()
        if backend is None:
            raise DeviceNotFound("libusb was not found.")
        out = []
        for d in usb.core.find(find_all=True, backend=backend, custom_match=_matches):
            out.append((P.PRODUCTS[d.idProduct], usb.util.get_string(d, d.iSerialNumber)))
        return out

    def open(self):
        _call(self.dev.set_configuration, P.CONFIGURATION)
        _call(self.usb.util.claim_interface, self.dev, P.INTERFACE)

    def close(self):
        for step in (lambda: self.usb.util.release_interface(self.dev, P.INTERFACE),
                     lambda: self.usb.util.dispose_resources(self.dev)):
            try:
                step()
            except Exception:
                pass

    def reset(self):
        for step in (lambda: self.usb.util.release_interface(self.dev, P.INTERFACE), self.dev.reset,
                     lambda: self.usb.util.dispose_resources(self.dev)):
            try:
                step()
            except Exception:
                pass

    def present(self):
        return self._find() is not None

    def refresh(self):
        dev = self._find()
        if dev is None:
            raise TransportError("the device is not on the USB bus")
        self.dev = dev

    def wait_for_return(self, timeout_s, cancelled):
        deadline = time.monotonic() + timeout_s
        while not cancelled():
            dev = self._find()
            if dev is not None:
                self.dev = dev
                return
            if time.monotonic() >= deadline:
                raise DeviceNotReturned(f"the device was disconnected and did not reconnect within {timeout_s:g} s")
            time.sleep(P.RECONNECT_POLL_MS / 1000)

    def write(self, data, timeout_ms):
        _call(self.dev.write, P.EP_CMD_OUT, bytes(data), timeout_ms)

    def read_reply(self, timeout_ms):
        return bytes(_call(self.dev.read, P.EP_REPLY_IN, 512, timeout_ms))

    def read_status(self, timeout_ms):
        try:
            return bytes(_call(self.dev.read, P.EP_STATUS_IN, 64, timeout_ms))
        except TransportTimeout:
            return b""

    def open_stream(self, credit, queued):
        try:
            reader = QueuedDataReader(self.dev, credit, queued)
        except Exception as e:                       # fall back to one read at a time
            print(f"emlusb6003: queued reads unavailable ({e}); using one read at a time", file=sys.stderr)
            reader = DataReader(self.dev, credit)
        reader.start()
        return reader

    def drain_data(self, timeout_ms=300):
        got = 0
        while True:
            try:
                got += len(bytes(self.dev.read(P.EP_DATA_IN, 4096, timeout_ms)))
            except self.usb.core.USBError:
                return got
