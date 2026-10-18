# SPDX-License-Identifier: MIT
"""The driver against SimulatedCard (all values synthetic)."""
import math
import time

import pytest

from emlusb6003 import HandshakeError, ProtocolError, SimulatedCard, StartError, StreamLost, Usb6003, protocol as P
from emlusb6003.simulated import SIM_GAIN, SIM_OFFSET, SIM_SERIAL, sim_count

# Shorten the waits so recovery tests run quickly.
@pytest.fixture(autouse=True)
def quick_recovery(monkeypatch):
    monkeypatch.setattr(P, "HALT_DETECT_MS", 400)
    monkeypatch.setattr(P, "RECOVER_RETRY_WAIT_MS", 100)
    monkeypatch.setattr(P, "DISCONNECT_GRACE_MS", 50)
    monkeypatch.setattr(P, "TIMEOUT_MS", 150)


def collect(card, seconds, timeout=0.2):
    runs, end = [], time.monotonic() + seconds
    while time.monotonic() < end:
        f = card.read(timeout)
        if f:
            runs.append(f)
    return runs


def test_open_reads_the_cards_own_calibration_and_identity():
    sim = SimulatedCard()
    with Usb6003(sim).open() as card:
        assert card.serial == SIM_SERIAL and card.product_name == "USB-6003"
        assert card.calibration.gain == pytest.approx(SIM_GAIN, rel=1e-6)
        assert card.calibration.offset == pytest.approx(SIM_OFFSET, rel=1e-6)


def test_the_oem_product_id_is_accepted():
    with Usb6003(SimulatedCard(product_id=0x76C7)).open() as card:
        assert card.product_name == "USB-6003 (OEM)"


def test_open_stops_a_card_a_previous_program_left_running():
    sim = SimulatedCard(already_streaming=True)
    Usb6003(sim).open()
    assert sim.sent[0] == P.stop_steps()[0].data                   # the first message is a stop
    assert sim._streaming is False


def test_the_startup_exchange_is_sent_in_order():
    sim = SimulatedCard()
    Usb6003(sim).open()
    handshake = list(sim.sent[3:])                                # after the stop messages
    assert [m[7] for m in handshake][:3] == [P.OP_00, P.OP_02, P.OP_20]
    assert len(handshake) == len(P.handshake_steps())


def test_a_wrong_serial_in_the_device_info_is_refused():
    sim = SimulatedCard()
    sim.serial = bytes.fromhex("01010101")          # a serial that does not match the unit's
    with pytest.raises(HandshakeError):
        Usb6003(sim).open()


def test_a_card_that_does_not_answer_is_refused_in_plain_words():
    sim = SimulatedCard(halt_mode="unplug"); sim.wedged = True      # a reset does not help
    with pytest.raises(HandshakeError, match="startup exchange"):
        Usb6003(sim).open()


def test_configure_returns_the_true_rate_and_refuses_what_the_card_cannot_do():
    with Usb6003(SimulatedCard()).open() as card:
        for inputs, rate in [(range(8), 3000), ([1], 3000), ([0, 2, 4], 2500)]:
            n = len(list(inputs))
            want = P.TIMEBASE_HZ / math.floor(P.TIMEBASE_HZ / (rate * n)) / n
            assert card.configure(inputs, rate) == pytest.approx(want)
        assert card.configure(range(8), 12500) == 12500
        for inputs, rate in [(range(8), 12501), ([8], 100), ([], 100), ([0], 0), ([0], 1000), ([0] * 17, 100)]:
            with pytest.raises(ProtocolError):
                card.configure(inputs, rate)
        assert card.configuration.divisor == 800                   # a refused request leaves the last good one


def test_start_requires_a_configuration():
    with Usb6003(SimulatedCard()).open() as card:
        with pytest.raises(Exception, match="configure"):
            card.start()


def test_card_receives_the_list_and_divisor_that_were_requested():
    sim = SimulatedCard()
    with Usb6003(sim).open() as card:
        card.configure([7, 3, 3, 0], 5000)
        card.start(); time.sleep(0.1); card.stop()
    assert sim.configs == [((7, 3, 3, 0), 4000)]                   # 80e6 / 20,000 = 4000


@pytest.mark.parametrize("inputs,rate", [(list(range(8)), 9000), ([7, 6, 5, 4, 3, 2, 1, 0], 9000), ([1], 4000),
                                         ([1, 1, 1, 1], 3000), ([2, 5, 2, 5, 0], 2000)])
def test_frames_arrive_whole_in_list_order_and_complete(inputs, rate):
    sim = SimulatedCard(chunk_bytes=37)                            # blocks that split frames mid-value
    with Usb6003(sim).open() as card:
        true_rate = card.configure(inputs, rate)
        card.start()
        runs = collect(card, 0.6)
        card.stop()
        runs += collect(card, 0.3, 0.05)
    assert runs, "no frames arrived"
    expected_next = 0
    total = 0
    for r in runs:
        assert r.entries == len(inputs) and r.inputs == tuple(inputs)
        assert r.first_frame == expected_next
        for i, row in enumerate(r.rows()):
            assert row == tuple(sim_count(r.first_frame + i, n) for n in inputs)
        expected_next += len(r)
        total += len(r)
    assert total > 0.2 * true_rate                                  # roughly the right amount for the time given


def test_volts_use_the_cards_calibration():
    with Usb6003(SimulatedCard()).open() as card:
        card.configure([0, 4], 1500)
        card.start(); f = card.read(2); card.stop()
    assert f.volts[0] == pytest.approx(f.counts[0] * SIM_GAIN + SIM_OFFSET, rel=1e-5)
    assert list(f.channel(1, volts=True))[0] == pytest.approx(f.counts[1] * SIM_GAIN + SIM_OFFSET, rel=1e-5)
    assert list(f.channel(1)) == [sim_count(f.first_frame + i, 4) for i in range(len(f))]


def test_the_stream_rate_matches_the_true_rate():
    sim = SimulatedCard()
    with Usb6003(sim).open() as card:
        true_rate = card.configure(range(8), 9000)
        card.start(); t0 = time.monotonic()
        total = sum(len(r) for r in collect(card, 1.0))
        elapsed = time.monotonic() - t0
        card.stop()
    assert total / elapsed == pytest.approx(true_rate, rel=0.1)


def test_credit_is_the_start_value_minus_bytes_received():
    sim = SimulatedCard()
    with Usb6003(sim).open() as card:
        card.configure(range(8), 9000)
        card.start(); time.sleep(0.4); card.stop()
        total = card._stream.total
    assert sim.credits and P.CREDIT_START - total <= sim.credits[-1] < P.CREDIT_START   # none after stop begins
    assert all(a > b for a, b in zip(sim.credits, sim.credits[1:]))


def test_no_credit_is_sent_once_a_stop_begins_and_earlier_frames_are_delivered():
    sim = SimulatedCard()
    with Usb6003(sim).open() as card:
        card.configure(range(8), 9000)
        card.start(); time.sleep(0.3)
        at_stop = []
        real_set = card._stop_requested.set
        card._stop_requested.set = lambda: (at_stop.append(len(sim.credits)), real_set())[1]
        card.stop()
        stream = card._stream
        delivered = sum(len(f.counts) for f in collect(card, 0.1)) * 2
        assert at_stop and at_stop[0] > 0
        assert len(sim.credits) == at_stop[0]
        assert delivered > 0 and delivered + len(card._carry) == stream.total


def test_start_without_a_queued_read_gets_no_reply():
    sim = SimulatedCard()
    card = Usb6003(sim).open()
    card.configure([0], 1500)
    steps = P.start_steps(card.configuration)
    k = [s.name for s in steps].index(P.READS_BEGIN_BEFORE)
    bad, _ = card._run(steps[:k] + steps[k:])
    assert bad == ["start"]                                         # no reply to the start command
    assert sim.starts == 0


def test_start_error_when_the_card_refuses_start():
    sim = SimulatedCard()
    card = Usb6003(sim).open()
    card.configure([0], 1500)
    sim.wedged = True
    with pytest.raises(StartError):
        card.start()


def test_stop_then_start_again_restarts_the_frame_count():
    with Usb6003(SimulatedCard()).open() as card:
        card.configure([2], 3000)
        card.start(); a = card.read(1); card.stop()
        card.start(); b = card.read(1); card.stop()
    assert a.first_frame == 0 and b.first_frame == 0


def test_close_while_streaming_stops_first():
    sim = SimulatedCard()
    card = Usb6003(sim).open()
    card.configure([0], 3000); card.start(); time.sleep(0.1)
    card.close()
    assert sim.sent[-3:] and sim.sent[-1].hex() == "0001000c0008010f0d600000" and not sim.is_open


def test_read_with_no_stream_returns_none_at_once():
    with Usb6003(SimulatedCard()).open() as card:
        t = time.monotonic()
        assert card.read(5) is None and time.monotonic() - t < 0.5


# ---- halts and disconnects

@pytest.mark.parametrize("mode", ["hang", "error", "wedged"])
def test_a_halt_is_recovered_and_the_gap_is_reported(mode):
    events = []
    sim = SimulatedCard(halt_mode=mode, halt_after_s=0.5, halts=2)
    with Usb6003(sim, on_event=lambda n, **i: events.append((n, i))).open() as card:
        card.configure(range(8), 9000)
        card.start()
        runs = collect(card, 4.5, 0.1)
        card.stop()
    names = [n for n, _ in events]
    assert names.count("halted") == 2 and names.count("recovered") == 2
    assert card.recoveries == 2
    gaps = [r for r in runs if r.gap_s is not None]
    assert len(gaps) == 2
    for r in gaps:
        assert 0.05 < r.gap_s < 2.5
    # frame numbers keep counting across a gap and no run spans one
    nxt = 0
    for r in runs:
        assert r.first_frame >= nxt
        nxt = r.first_frame + len(r)
    assert sim.resets >= 2


def test_a_wedged_card_that_needs_three_resets_is_recovered_by_a_later_stronger_try():
    sim = SimulatedCard(halt_mode="wedged", halt_after_s=0.4, halts=1, resets_to_fix=3)
    with Usb6003(sim).open() as card:
        card.configure([0, 1], 3000); card.start()
        collect(card, 6.0, 0.1)
        card.stop()
    assert card.recoveries == 1 and sim.resets >= 3


def test_a_card_a_reset_never_fixes_is_reported_and_does_not_hang():
    sim = SimulatedCard(halt_mode="unplug", halt_after_s=0.3, halts=1)
    card = Usb6003(sim).open()
    card.configure([0], 3000); card.start()
    t = time.monotonic()
    with pytest.raises(StreamLost, match=f"did not restart after {P.RECOVER_ATTEMPTS} tries"):
        while time.monotonic() - t < 15:
            card.read(0.2)
    card.close()
    assert time.monotonic() - t < 15


def test_a_disconnect_that_comes_back_is_recovered():
    sim = SimulatedCard(halt_mode="disconnect", halt_after_s=0.4, halts=1, gone_s=0.8)
    with Usb6003(sim).open() as card:
        card.configure(range(8), 9000); card.start()
        runs = collect(card, 3.5, 0.1)
        card.stop()
    assert card.recoveries == 1
    gaps = [r.gap_s for r in runs if r.gap_s is not None]
    assert len(gaps) == 1 and gaps[0] >= 0.7


def test_a_disconnect_that_never_returns_is_reported(monkeypatch):
    monkeypatch.setattr(P, "RECONNECT_WAIT_MS", 600)
    sim = SimulatedCard(halt_mode="disconnect", halt_after_s=0.3, halts=1, gone_s=None)
    card = Usb6003(sim).open()
    card.configure([0], 3000); card.start()
    t = time.monotonic()
    with pytest.raises(StreamLost, match="did not reconnect"):
        while time.monotonic() - t < 10:
            card.read(0.2)
    card.close()


def test_stop_during_a_wait_for_a_returning_device_does_not_hang(monkeypatch):
    monkeypatch.setattr(P, "RECONNECT_WAIT_MS", 20000)
    sim = SimulatedCard(halt_mode="disconnect", halt_after_s=0.3, halts=1, gone_s=None)
    card = Usb6003(sim).open()
    card.configure([0], 3000); card.start()
    time.sleep(1.2)
    t = time.monotonic()
    card.close()
    assert time.monotonic() - t < 5


def test_a_faulty_event_callback_does_not_stop_the_stream():
    def boom(name, **info):
        raise RuntimeError("callback bug")
    sim = SimulatedCard(halt_mode="hang", halt_after_s=0.3, halts=1)
    with Usb6003(sim, on_event=boom).open() as card:
        card.configure([0], 3000); card.start()
        collect(card, 2.5, 0.1)
    assert card.recoveries == 1


def test_a_restart_that_gives_no_data_keeps_the_gap_from_the_real_beginning():
    # The first restart does not fix this card; the second does. The gap must cover both waits.
    sim = SimulatedCard(halt_mode="hang", halt_after_s=0.4, halts=1, resets_to_fix=2)
    with Usb6003(sim).open() as card:
        card.configure([0, 1], 3000); card.start()
        runs = collect(card, 4.0, 0.1)
        card.stop()
    gaps = [r.gap_s for r in runs if r.gap_s is not None]
    assert len(gaps) == 1 and gaps[0] > 0.8, gaps          # two detection waits of 0.4 s
    assert card.recoveries == 2 and sim.resets >= 2        # each restart the card acknowledged counts
