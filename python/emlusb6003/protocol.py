# SPDX-License-Identifier: MIT
"""Constants, message builders and reply checks for the USB-6003. No USB access.

The JavaScript twin is js/src/protocol.js; tests/test_cross_language.py checks that both agree.
"""
import math
import struct
from dataclasses import dataclass

# Device identity

VENDOR_ID = 0x3923
# Supported product IDs. 0x76C7 is the OEM version of the card.
PRODUCTS = {0x76C6: "USB-6003", 0x76C7: "USB-6003 (OEM)"}

CONFIGURATION = 1
INTERFACE = 0
EP_CMD_OUT = 0x01
EP_REPLY_IN = 0x81
EP_DATA_IN = 0x82
EP_STATUS_IN = 0x84

# Limits

TIMEBASE_HZ = 80_000_000        # sample timebase, 80 MHz
INPUT_COUNT = 8                 # analog inputs ai0 to ai7
INPUT_RANGE_V = 10.0            # -10 V to +10 V
MAX_AGGREGATE_RATE = 100_000    # conversions per second, summed over all list entries
FIFO_SAMPLES = 2047             # the card's own sample buffer
MAX_LIST_ENTRIES = 16           # longest channel list the driver accepts
DIVISOR_MAX = 0xFFFF
DIVISOR_MIN = TIMEBASE_HZ // MAX_AGGREGATE_RATE

# Streaming

BYTES_PER_SAMPLE = 2                  # signed 16-bit counts
READ_BYTES = 7680                     # size of each data read
CREDIT_START = 0x7FFFFFFF
TIMEOUT_MS = 1000                     # for one command and its reply

# Halt recovery: no data for HALT_DETECT_MS while streaming counts as a halt.
USB_QUEUE_SECONDS = 2.0               # seconds of data the queued reads can hold
HALT_DETECT_QUEUE_FRACTION = 0.75
HALT_DETECT_MS = round(USB_QUEUE_SECONDS * 1000 * HALT_DETECT_QUEUE_FRACTION)
HALT_POLL_MS = 100
RECOVER_ATTEMPTS = 5                  # tries before the stream is reported lost
RECOVER_RETRY_WAIT_MS = 1500
DISCONNECT_GRACE_MS = 300
RECONNECT_WAIT_MS = 30000             # how long to wait for a removed device to return
RECONNECT_POLL_MS = 250

# Message constants

SELECTOR = 0x0001
SELECTOR_INFO = 0x0000
HEADER_BYTES = 6
REPLY_HEADER_BYTES = 12
REPLY_STATUS_OK = bytes.fromhex("010000000002")

ADDR_INFO_QUERY = 0x00000000
ADDR_CHALLENGE = 0x0D210000
ADDR_DEVICE_INFO = 0x0D220000
ADDR_CHANNELS = 0x0D300000
ADDR_ENGINE_B = 0x0D310000
ADDR_ENGINE = 0x0D600000
ADDR_CREDIT = 0x00020002

OP_00, OP_02, OP_05 = 0x00, 0x02, 0x05
OP_08, OP_09, OP_0A, OP_0B, OP_0C, OP_0D, OP_0E, OP_0F, OP_20 = 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x20

# Reply lengths, in bytes.
ACK_LENGTH = 12
CHALLENGE_BYTES = 4
CHALLENGE_REPLY_LENGTH = 16
DEVICE_INFO_LENGTH = 236
DEVICE_INFO_REPLY_LENGTH = 252

# Offsets of the fields the driver reads from the device information reply.
CAL_SERIAL_OFFSET = 18
CAL_GAIN_OFFSET = 114
CAL_OFFSET_OFFSET = 118

STOP_INTERRUPT = bytes.fromhex("00000010000c00050d60000000000000")


class ProtocolError(ValueError):
    """A request outside the card's limits, or a reply that is not one the card sends."""


def message(address, opcode, operands=b"", *, flag=1, selector=SELECTOR):
    """Builds one framed message. `flag` 1 means a reply is expected."""
    body = bytes([flag, opcode]) + address.to_bytes(4, "big") + bytes(operands)
    total = HEADER_BYTES + len(body)
    body += bytes(-total % 4)
    total = HEADER_BYTES + len(body)
    return selector.to_bytes(2, "big") + total.to_bytes(2, "big") + (total - 4).to_bytes(2, "big") + body


@dataclass(frozen=True)
class Step:
    """A message to send and the reply it expects. `kind` is "ack", "challenge" or "data"."""
    name: str
    data: bytes
    reply_length: int
    kind: str = "ack"


def _ack(name, data):
    return Step(name, data, ACK_LENGTH, "ack")


# Steps

def handshake_steps():
    """The steps run when the card is attached. The "device_info" step returns the calibration
    (see parse_calibration). The "challenge" step ends with placeholder bytes (see with_challenge)."""
    query_a = message(ADDR_INFO_QUERY, OP_00, selector=SELECTOR_INFO)
    query_b = message(ADDR_INFO_QUERY, OP_02, selector=SELECTOR_INFO)
    return [
        Step("query_a", query_a, 28, "data"),
        Step("query_b", query_b, 24, "data"),
        Step("challenge", message(ADDR_CHALLENGE, OP_20, bytes(CHALLENGE_BYTES)), CHALLENGE_REPLY_LENGTH, "challenge"),
        _ack("select_info", message(ADDR_DEVICE_INFO, OP_08)),
        Step("device_info", message(ADDR_DEVICE_INFO, OP_0A, (0).to_bytes(4, "big") + DEVICE_INFO_LENGTH.to_bytes(2, "big") + bytes(2)),
             DEVICE_INFO_REPLY_LENGTH, "data"),
        Step("query_a_again", query_a, 28, "data"),
        _ack("engine_ready", message(ADDR_ENGINE, OP_08)),
        _ack("engine_b_ready", message(ADDR_ENGINE_B, OP_08)),
    ]


def channel_list_message(inputs):
    """The channel list message for a list of inputs."""
    inputs = validate_inputs(inputs)
    return message(ADDR_CHANNELS, OP_08, (len(inputs) + 2).to_bytes(2, "big") + bytes(inputs))


def rate_message(divisor):
    """The rate message for a conversion divisor (timebase divided by divisor is the conversion rate)."""
    if not isinstance(divisor, int) or not DIVISOR_MIN <= divisor <= DIVISOR_MAX:
        raise ProtocolError(f"the conversion divisor must be a whole number from {DIVISOR_MIN} to {DIVISOR_MAX}")
    return message(ADDR_ENGINE, OP_09, bytes(2) + divisor.to_bytes(2, "big") + bytes(4) + bytes([0xFF, 0x00, 0x02, 0x00]))


def credit_message(total_bytes):
    """The flow-control message for the total bytes received so far. Expects no reply."""
    return message(ADDR_CREDIT, OP_09, ((CREDIT_START - total_bytes) & 0xFFFFFFFF).to_bytes(4, "big"), flag=0)


def validate_inputs(inputs):
    """The list as a tuple of ints, or ProtocolError. Any order and repeats are allowed."""
    try:
        entries = tuple(inputs)
    except TypeError:
        raise ProtocolError("inputs must be a list of input numbers, for example [0, 1, 2]") from None
    if not entries:
        raise ProtocolError("the channel list needs at least one input")
    if len(entries) > MAX_LIST_ENTRIES:
        raise ProtocolError(f"the channel list has {len(entries)} entries; the longest list is {MAX_LIST_ENTRIES}")
    for e in entries:
        if isinstance(e, bool) or not isinstance(e, int) or not 0 <= e < INPUT_COUNT:
            raise ProtocolError(f"input {e!r} does not exist; the card has ai0 to ai{INPUT_COUNT - 1}")
    return entries


def conversion_rate_for(divisor):
    return TIMEBASE_HZ / divisor


@dataclass(frozen=True)
class Configuration:
    """A validated request: the list, the divisor to send, and the rates the card will really run at."""
    inputs: tuple
    divisor: int
    requested_rate: float

    @property
    def entries(self):
        return len(self.inputs)

    @property
    def conversion_rate(self):
        return conversion_rate_for(self.divisor)

    @property
    def rate_per_input(self):
        """The true rate of each list entry, in frames per second."""
        return self.conversion_rate / self.entries

    @property
    def frame_bytes(self):
        return self.entries * BYTES_PER_SAMPLE


def make_configuration(inputs, rate_per_input):
    """Builds the configuration for a list and a rate for each entry, or raises ProtocolError.
    The true rate is at or just above the request."""
    entries = validate_inputs(inputs)
    if isinstance(rate_per_input, bool) or not isinstance(rate_per_input, (int, float)) or not math.isfinite(rate_per_input) or rate_per_input <= 0:
        raise ProtocolError("the rate must be a number above 0")
    aggregate = rate_per_input * len(entries)
    if aggregate > MAX_AGGREGATE_RATE:
        raise ProtocolError(
            f"{len(entries)} entries at {rate_per_input:g} per second is {aggregate:g} conversions per second; "
            f"the card's limit is {MAX_AGGREGATE_RATE} in total")
    # Small tolerance against floating-point rounding.
    divisor = math.floor(TIMEBASE_HZ / aggregate * (1 + 1e-12))
    if divisor > DIVISOR_MAX:
        lowest = TIMEBASE_HZ / DIVISOR_MAX / len(entries)
        raise ProtocolError(f"{rate_per_input:g} per second is too slow for {len(entries)} entries; the lowest rate is {lowest:.3f}")
    return Configuration(entries, divisor, float(rate_per_input))


def start_steps(config):
    """The start steps for a configuration. Queue the data reads before the step named READS_BEGIN_BEFORE."""
    return [
        _ack("channel_read", message(ADDR_CHANNELS, OP_09)),
        _ack("channel_list", channel_list_message(config.inputs)),
        _ack("rate", rate_message(config.divisor)),
        _ack("opening_credit", message(ADDR_CREDIT, OP_08, CREDIT_START.to_bytes(4, "big"))),
        _ack("engine_0a", message(ADDR_ENGINE, OP_0A)),
        _ack("engine_0b", message(ADDR_ENGINE, OP_0B, bytes(4))),
        _ack("start", message(ADDR_ENGINE, OP_0C)),
    ]


READS_BEGIN_BEFORE = "engine_0a"


def stop_steps():
    return [
        Step("stop_0d", message(ADDR_ENGINE, OP_0D), 16, "data"),
        _ack("stop_0e", message(ADDR_ENGINE, OP_0E)),
        _ack("stop_0f", message(ADDR_ENGINE, OP_0F)),
    ]


# Replies

def with_challenge(step, challenge):
    """The challenge step's message with `challenge` in place of the placeholder bytes."""
    if len(challenge) != CHALLENGE_BYTES:
        raise ProtocolError(f"the challenge is {CHALLENGE_BYTES} bytes")
    return step.data[:-CHALLENGE_BYTES] + bytes(challenge)


def serial_bytes(serial_hex):
    """The USB serial string (8 hex digits) as 4 bytes."""
    return bytes.fromhex(serial_hex)


def reply_ok(step, got, challenge=None, serial=None):
    """True when `got` is an acceptable reply to `step`."""
    got = bytes(got)
    if len(got) != step.reply_length or len(got) < REPLY_HEADER_BYTES:
        return False
    if int.from_bytes(got[2:4], "big") != len(got) or int.from_bytes(got[4:6], "big") != len(got) - 4:
        return False
    if got[6:REPLY_HEADER_BYTES] != REPLY_STATUS_OK:
        return False
    if step.kind == "challenge":
        want = bytes(a ^ b for a, b in zip(challenge, serial))
        return got[REPLY_HEADER_BYTES:] == want
    return True


def device_info_serial_ok(info_reply, serial):
    """True when the device information reply holds the unit's serial."""
    return bytes(info_reply[CAL_SERIAL_OFFSET:CAL_SERIAL_OFFSET + 4]) == bytes(reversed(serial))


@dataclass(frozen=True)
class Calibration:
    """The card's own scale: volts = count * gain + offset."""
    gain: float
    offset: float

    @property
    def usable(self):
        return math.isfinite(self.gain) and self.gain > 0 and math.isfinite(self.offset)

    def volts(self, count):
        return count * self.gain + self.offset


def parse_calibration(info_reply):
    gain, offset = struct.unpack("<ff", bytes(info_reply[CAL_GAIN_OFFSET:CAL_GAIN_OFFSET + 4]) + bytes(info_reply[CAL_OFFSET_OFFSET:CAL_OFFSET_OFFSET + 4]))
    return Calibration(gain, offset)


def device_buffer_ms(conversion_rate):
    """How long, in ms, the card's buffer holds data at a conversion rate."""
    return FIFO_SAMPLES / conversion_rate * 1000


def read_queue_depth(conversion_rate):
    """Number of reads to keep queued so USB_QUEUE_SECONDS of data can wait."""
    return max(1, math.ceil(USB_QUEUE_SECONDS * conversion_rate * BYTES_PER_SAMPLE / READ_BYTES))


# Constants shared with the JavaScript version, for the cross-language test.
CONSTANTS = {
    "VENDOR_ID": VENDOR_ID, "CONFIGURATION": CONFIGURATION, "INTERFACE": INTERFACE,
    "EP_CMD_OUT": EP_CMD_OUT, "EP_REPLY_IN": EP_REPLY_IN, "EP_DATA_IN": EP_DATA_IN, "EP_STATUS_IN": EP_STATUS_IN,
    "TIMEBASE_HZ": TIMEBASE_HZ, "INPUT_COUNT": INPUT_COUNT, "INPUT_RANGE_V": INPUT_RANGE_V,
    "MAX_AGGREGATE_RATE": MAX_AGGREGATE_RATE, "FIFO_SAMPLES": FIFO_SAMPLES, "MAX_LIST_ENTRIES": MAX_LIST_ENTRIES,
    "DIVISOR_MAX": DIVISOR_MAX, "DIVISOR_MIN": DIVISOR_MIN,
    "BYTES_PER_SAMPLE": BYTES_PER_SAMPLE, "READ_BYTES": READ_BYTES, "CREDIT_START": CREDIT_START, "TIMEOUT_MS": TIMEOUT_MS,
    "USB_QUEUE_SECONDS": USB_QUEUE_SECONDS, "HALT_DETECT_QUEUE_FRACTION": HALT_DETECT_QUEUE_FRACTION,
    "HALT_DETECT_MS": HALT_DETECT_MS, "HALT_POLL_MS": HALT_POLL_MS, "RECOVER_ATTEMPTS": RECOVER_ATTEMPTS,
    "RECOVER_RETRY_WAIT_MS": RECOVER_RETRY_WAIT_MS, "DISCONNECT_GRACE_MS": DISCONNECT_GRACE_MS,
    "RECONNECT_WAIT_MS": RECONNECT_WAIT_MS, "RECONNECT_POLL_MS": RECONNECT_POLL_MS,
    "SELECTOR": SELECTOR, "SELECTOR_INFO": SELECTOR_INFO, "HEADER_BYTES": HEADER_BYTES,
    "REPLY_HEADER_BYTES": REPLY_HEADER_BYTES, "ADDR_INFO_QUERY": ADDR_INFO_QUERY, "ADDR_CHALLENGE": ADDR_CHALLENGE,
    "ADDR_DEVICE_INFO": ADDR_DEVICE_INFO, "ADDR_CHANNELS": ADDR_CHANNELS, "ADDR_ENGINE_B": ADDR_ENGINE_B,
    "ADDR_ENGINE": ADDR_ENGINE, "ADDR_CREDIT": ADDR_CREDIT,
    "ACK_LENGTH": ACK_LENGTH, "CHALLENGE_BYTES": CHALLENGE_BYTES, "CHALLENGE_REPLY_LENGTH": CHALLENGE_REPLY_LENGTH, "DEVICE_INFO_LENGTH": DEVICE_INFO_LENGTH,
    "DEVICE_INFO_REPLY_LENGTH": DEVICE_INFO_REPLY_LENGTH,
    "CAL_SERIAL_OFFSET": CAL_SERIAL_OFFSET, "CAL_GAIN_OFFSET": CAL_GAIN_OFFSET, "CAL_OFFSET_OFFSET": CAL_OFFSET_OFFSET,
}
