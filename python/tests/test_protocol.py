# SPDX-License-Identifier: MIT
"""Protocol builders and reply checks. No hardware."""
import math
import struct

import pytest

from emlusb6003 import protocol as P


def test_identity_table():
    assert P.VENDOR_ID == 0x3923
    assert P.PRODUCTS == {0x76C6: "USB-6003", 0x76C7: "USB-6003 (OEM)"}


def test_limits():
    assert (P.INPUT_COUNT, P.INPUT_RANGE_V, P.MAX_AGGREGATE_RATE, P.TIMEBASE_HZ, P.FIFO_SAMPLES) == (8, 10.0, 100_000, 80_000_000, 2047)
    assert P.DIVISOR_MIN == 800


def test_message_is_padded_to_four_and_counts_length():
    m = P.message(P.ADDR_CHANNELS, P.OP_08, b"\x00\x03\x01")
    assert len(m) % 4 == 0 and int.from_bytes(m[2:4], "big") == len(m) and int.from_bytes(m[4:6], "big") == len(m) - 4
    assert m.hex() == "00010010000c01080d30000000030100"


def test_channel_list_layout():
    m = P.channel_list_message([7, 6, 5, 4, 3, 2, 1, 0])
    assert m.hex() == "00010018001401080d300000000a07060504030201000000"
    assert P.channel_list_message([1]).hex() == "00010010000c01080d30000000030100"


@pytest.mark.parametrize("bad", [[], [8], [-1], [1.5], ["a"], [True], list(range(8)) * 3, 5, None])
def test_bad_lists_are_refused(bad):
    with pytest.raises(P.ProtocolError):
        P.channel_list_message(bad)


def test_any_order_and_repeats_are_allowed():
    assert P.validate_inputs([3, 3, 0, 7, 3]) == (3, 3, 0, 7, 3)
    assert P.validate_inputs(range(8)) == tuple(range(8))
    assert len(P.validate_inputs([0] * P.MAX_LIST_ENTRIES)) == P.MAX_LIST_ENTRIES


@pytest.mark.parametrize("inputs,rate", [([0, 1, 2], 1000), ([5], 2500), ([0, 1, 2, 3, 4], 4321), ([7, 7], 777)])
def test_true_rate_is_at_or_above_the_request(inputs, rate):
    c = P.make_configuration(inputs, rate)
    aggregate = rate * len(inputs)
    assert c.divisor == math.floor(P.TIMEBASE_HZ / aggregate)
    assert c.conversion_rate == pytest.approx(P.TIMEBASE_HZ / c.divisor)
    assert c.rate_per_input == pytest.approx(c.conversion_rate / len(inputs))
    assert c.rate_per_input >= rate


def test_the_limit_is_the_aggregate_rate():
    P.make_configuration(range(8), 12500)              # exactly 100,000 in total
    P.make_configuration([0], 100_000)
    with pytest.raises(P.ProtocolError, match="limit"):
        P.make_configuration(range(8), 12501)
    with pytest.raises(P.ProtocolError, match="limit"):
        P.make_configuration([0], 100_001)
    with pytest.raises(P.ProtocolError, match="limit"):
        P.make_configuration([0, 1], 50_001)


@pytest.mark.parametrize("rate", [0, -5, float("nan"), float("inf"), "100", None, True])
def test_bad_rates_are_refused(rate):
    with pytest.raises(P.ProtocolError):
        P.make_configuration([0], rate)


def test_a_rate_below_the_divisor_field_is_refused():
    with pytest.raises(P.ProtocolError, match="too slow"):
        P.make_configuration([0], 1000)
    P.make_configuration([0], 1221)


def test_rate_message_refuses_divisors_outside_the_field():
    for d in (0, 799, 65536, 833.5):
        with pytest.raises(P.ProtocolError):
            P.rate_message(d)


def test_credit_counts_down_from_the_start_value():
    assert P.credit_message(0).hex() == "00010010000c0009000200027fffffff"
    assert P.credit_message(7680).hex() == "00010010000c0009000200027fffe1ff"
    assert struct.unpack(">I", P.credit_message(1_000_000)[12:])[0] == P.CREDIT_START - 1_000_000


def test_credit_wraps_like_a_32_bit_counter():
    assert int.from_bytes(P.credit_message(P.CREDIT_START + 1)[12:], "big") == 0xFFFFFFFF


def _reply(length, payload=b"", total=None):
    total = total or length
    return (b"\x00\x01" + total.to_bytes(2, "big") + (total - 4).to_bytes(2, "big") + P.REPLY_STATUS_OK + payload).ljust(length, b"\0")


def test_reply_checks():
    ack = P.start_steps(P.make_configuration([0], 1221))[0]
    assert P.reply_ok(ack, _reply(12))
    assert not P.reply_ok(ack, _reply(16))                                  # wrong length
    assert not P.reply_ok(ack, _reply(12)[:-1] + b"\x03")                   # wrong status
    assert not P.reply_ok(ack, b"\x00" * 12)
    bad_len = bytearray(_reply(12)); bad_len[3] = 8
    assert not P.reply_ok(ack, bytes(bad_len))                              # header length disagrees


def test_handshake_reply_check():
    step = [s for s in P.handshake_steps() if s.name == "challenge"][0]
    challenge, serial = bytes([1, 2, 3, 4]), bytes([0xF0, 0x0F, 0xAA, 0x55])
    msg = P.with_challenge(step, challenge)
    assert msg[:12] == step.data[:12] and msg[12:] == challenge and len(msg) == 16
    good = _reply(16, bytes(a ^ b for a, b in zip(challenge, serial)))
    assert P.reply_ok(step, good, challenge, serial)
    assert not P.reply_ok(step, _reply(16, challenge), challenge, serial)


def test_calibration_is_read_from_the_device_info_reply():
    reply = bytearray(P.DEVICE_INFO_REPLY_LENGTH)
    struct.pack_into("<ff", reply, P.CAL_GAIN_OFFSET, 0.5, 0.25)
    cal = P.parse_calibration(bytes(reply))
    assert (cal.gain, cal.offset, cal.usable) == (0.5, 0.25, True)
    assert cal.volts(10) == 5.25
    for gain, offset in [(0.0, 0.0), (-1.0, 0.0), (float("nan"), 0.0), (1.0, float("inf"))]:
        struct.pack_into("<ff", reply, P.CAL_GAIN_OFFSET, gain, offset)
        assert not P.parse_calibration(bytes(reply)).usable


def test_serial_is_checked_byte_reversed():
    reply = bytearray(P.DEVICE_INFO_REPLY_LENGTH)
    reply[P.CAL_SERIAL_OFFSET:P.CAL_SERIAL_OFFSET + 4] = bytes([4, 3, 2, 1])
    assert P.device_info_serial_ok(bytes(reply), bytes([1, 2, 3, 4]))
    assert not P.device_info_serial_ok(bytes(reply), bytes([4, 3, 2, 1]))


def test_read_queue_and_buffer_follow_the_rate():
    for rate in (1221.0, 20_000.0, 90_000.0):
        assert P.read_queue_depth(rate) == max(1, math.ceil(P.USB_QUEUE_SECONDS * rate * P.BYTES_PER_SAMPLE / P.READ_BYTES))
        assert P.device_buffer_ms(rate) == pytest.approx(P.FIFO_SAMPLES / rate * 1000)


def test_constants_table_is_complete():
    for name, value in P.CONSTANTS.items():
        assert getattr(P, name) == value
