# SPDX-License-Identifier: MIT
"""UsbTransport against a fake pyusb module (no libusb or card needed)."""
import threading
import time
from types import SimpleNamespace

import pytest

from emlusb6003 import DeviceNotFound, DeviceNotReturned, TransportError, TransportTimeout, Usb6003, protocol as P
from emlusb6003 import transport as T


class USBError(Exception):
    pass


class USBTimeoutError(USBError):
    pass


class FakeDev:
    def __init__(self, pid=0x76C6, serial="0a0b0c0d", vid=P.VENDOR_ID):
        self.idVendor, self.idProduct, self.iSerialNumber, self.serial = vid, pid, 3, serial
        self.calls, self.fail_write, self.reads = [], None, []   # reads: bytes the data read returns, then times out

    def set_configuration(self, v): self.calls.append(("set_configuration", v))
    def reset(self): self.calls.append(("reset",))

    def write(self, ep, data, timeout):
        if self.fail_write:
            raise self.fail_write
        self.calls.append(("write", ep, bytes(data), timeout))

    def read(self, ep, size, timeout):
        if ep == P.EP_DATA_IN and self.reads:
            return self.reads.pop(0)
        time.sleep(timeout / 1000)
        raise USBTimeoutError("timeout")


@pytest.fixture
def bus(monkeypatch):
    devices = []

    def find(find_all=False, custom_match=None, backend=None):
        hits = [d for d in devices if custom_match is None or custom_match(d)]
        return hits if find_all else (hits[0] if hits else None)

    fake = SimpleNamespace(
        core=SimpleNamespace(find=find, USBError=USBError, USBTimeoutError=USBTimeoutError),
        util=SimpleNamespace(get_string=lambda d, i: d.serial, claim_interface=lambda d, n: d.calls.append(("claim", n)),
                             release_interface=lambda d, n: d.calls.append(("release", n)), dispose_resources=lambda d: None),
        backend=SimpleNamespace(libusb1=SimpleNamespace(get_backend=lambda **k: object())))
    monkeypatch.setattr(T, "_usb", lambda: fake)
    return devices


def test_finds_only_cards_with_a_known_vendor_and_product(bus):
    bus += [FakeDev(vid=0x1234), FakeDev(pid=0x9999), FakeDev(pid=0x76C7, serial="11111111")]
    t = T.UsbTransport()
    assert (t.serial_hex, t.product_name) == ("11111111", "USB-6003 (OEM)")


def test_serial_selects_one_of_several_cards(bus):
    bus += [FakeDev(serial="aaaaaaaa"), FakeDev(serial="bbbbbbbb")]
    assert T.UsbTransport(serial="bbbbbbbb").serial_hex == "bbbbbbbb"
    with pytest.raises(DeviceNotFound):
        T.UsbTransport(serial="cccccccc")


def test_list_devices(bus):
    bus += [FakeDev(), FakeDev(pid=0x76C7, serial="22222222"), FakeDev(vid=1)]
    assert T.UsbTransport.list_devices() == [("USB-6003", "0a0b0c0d"), ("USB-6003 (OEM)", "22222222")]


def test_no_card_and_no_libusb_are_reported_in_plain_words(bus, monkeypatch):
    with pytest.raises(DeviceNotFound, match="No USB-6003 found"):
        T.UsbTransport()
    monkeypatch.setattr(T, "find_backend", lambda: None)
    with pytest.raises(DeviceNotFound, match="libusb"):
        T.UsbTransport()


def test_open_selects_configuration_1_and_claims_interface_0(bus):
    d = FakeDev(); bus.append(d)
    T.UsbTransport().open()
    assert d.calls == [("set_configuration", 1), ("claim", 0)]


def test_libusb_errors_become_ours(bus):
    d = FakeDev(); bus.append(d)
    t = T.UsbTransport()
    d.fail_write = USBError("pipe error")
    with pytest.raises(TransportError):
        t.write(b"x", 10)
    with pytest.raises(TransportTimeout):
        t.read_reply(10)
    assert t.read_status(10) == b""                       # a status timeout is not an error


def test_commands_are_written_to_the_command_out_address(bus):
    d = FakeDev(); bus.append(d)
    T.UsbTransport().write(b"abc", 55)
    assert d.calls == [("write", P.EP_CMD_OUT, b"abc", 55)]


def test_reset_releases_resets_and_survives_a_failing_reset(bus):
    d = FakeDev(); bus.append(d)
    t = T.UsbTransport()
    d.reset = lambda: (_ for _ in ()).throw(USBError("gone"))
    t.reset()                                              # must not raise
    assert ("release", 0) in d.calls


def test_present_refresh_and_wait_for_return(bus):
    d = FakeDev(); bus.append(d)
    t = T.UsbTransport()
    assert t.present()
    bus.clear()
    assert not t.present()
    with pytest.raises(TransportError):
        t.refresh()
    with pytest.raises(DeviceNotReturned):
        t.wait_for_return(0.3, lambda: False)
    again = FakeDev(); threading.Timer(0.3, lambda: bus.append(again)).start()
    t.wait_for_return(5, lambda: False)
    assert t.dev is again
    bus.clear()
    t.wait_for_return(5, lambda: True)                     # cancelled: returns at once


def test_a_returning_card_must_have_the_same_serial(bus):
    bus.append(FakeDev(serial="aaaaaaaa"))
    t = T.UsbTransport()
    bus.clear(); bus.append(FakeDev(serial="bbbbbbbb"))
    assert not t.present()


def test_single_read_reader_keeps_reading_and_sends_credit(bus):
    d = FakeDev(); bus.append(d)
    d.reads = [b"\x01\x02" * 8, b"\x03\x04" * 8]
    t = T.UsbTransport()
    credits = []
    stream = t.open_stream(credits.append, 4)              # the fake has no libusb handle, so the single-read reader is used
    assert isinstance(stream, T.DataReader)
    got = [stream.blocks.get(timeout=2), stream.blocks.get(timeout=2)]
    stream.stop()
    assert got == [b"\x01\x02" * 8, b"\x03\x04" * 8] and credits == [16, 32] and stream.total == 32 and stream.error is None


def test_a_read_error_ends_the_reader_with_an_error_text(bus):
    d = FakeDev(); bus.append(d)
    t = T.UsbTransport()
    d.read = lambda ep, size, timeout: (_ for _ in ()).throw(USBError("device gone"))
    stream = t.open_stream(lambda total: None, 4)
    time.sleep(0.2)
    stream.stop()
    assert stream.error == "device gone"


def test_usb6003_refuses_a_non_transport():
    with pytest.raises(TypeError):
        Usb6003("not a transport")
