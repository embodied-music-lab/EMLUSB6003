# SPDX-License-Identifier: MIT
"""The Python and JavaScript protocol definitions agree on constants, the product table and builder output."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from emlusb6003 import protocol as P

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    "credits": [0, 1, 7680, 1_000_000, P.CREDIT_START, P.CREDIT_START + 1],
    "configs": [
        [list(range(8)), 9000], [list(reversed(range(8))), 9000], [[1], 7000], [[1, 1, 1, 1], 4000], [[0, 2, 4], 2500],
        [[1, 0, 1, 2, 1, 4], 3000], [list(range(8)) * 2, 5000], [list(range(8)), 4000], [list(range(8)), 12500],
        [[0], 100_000], [[3, 3, 3], 33_333], [[0], 1221], [[7], 5000.5], [list(range(8)), 0.1],
        # both must refuse these
        [list(range(8)), 12501], [[0], 100_001], [[0], 1000], [[], 100], [[8], 100], [[-1], 100], [[0] * 17, 100], [[0], 0], [[0], -1],
    ],
    "rates": [1221.0, 20000.0, 90000.0, 100000.0],
}


@pytest.fixture(scope="module")
def js():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    out = subprocess.check_output([node, str(ROOT / "js" / "tools" / "dump-protocol.mjs"), json.dumps(CASES)], text=True)
    return json.loads(out)


def steps(items):
    return [{"name": s.name, "hex": s.data.hex(), "replyLength": s.reply_length, "kind": s.kind} for s in items]


def test_constants_are_identical(js):
    assert set(js["constants"]) == set(P.CONSTANTS), "the two definitions name different constants"
    for name, value in P.CONSTANTS.items():
        assert js["constants"][name] == value, name


def test_product_table_and_fixed_bytes_are_identical(js):
    assert {int(k): v for k, v in js["products"].items()} == P.PRODUCTS
    assert js["replyStatusOk"] == P.REPLY_STATUS_OK.hex()
    assert js["stopInterrupt"] == P.STOP_INTERRUPT.hex()
    assert js["readsBeginBefore"] == P.READS_BEGIN_BEFORE


def test_handshake_and_stop_messages_are_identical(js):
    assert js["handshake"] == steps(P.handshake_steps())
    assert js["stop"] == steps(P.stop_steps())


def test_credit_messages_are_identical(js):
    for n in CASES["credits"]:
        assert js["credits"][str(n)] == P.credit_message(n).hex(), n


def test_every_configuration_builds_the_same_bytes_or_is_refused_by_both(js):
    for (inputs, rate), got in zip(CASES["configs"], js["configs"]):
        try:
            c = P.make_configuration(inputs, rate)
        except P.ProtocolError:
            assert got["ok"] is False, f"JavaScript accepted {inputs} at {rate}, Python refused it"
            continue
        assert got["ok"] is True, f"Python accepted {inputs} at {rate}, JavaScript refused it: {got}"
        assert got["divisor"] == c.divisor
        assert got["conversionRate"] == c.conversion_rate and got["ratePerInput"] == c.rate_per_input
        assert got["frameBytes"] == c.frame_bytes
        assert got["start"] == steps(P.start_steps(c)), (inputs, rate)


def test_derived_figures_are_identical(js):
    for r, depth, buffer_ms in zip(CASES["rates"], js["queueDepths"], js["bufferMs"]):
        assert depth == P.read_queue_depth(r)
        assert buffer_ms == P.device_buffer_ms(r)
