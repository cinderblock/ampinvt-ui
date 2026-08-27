"""Does back-to-back polling wedge the inverter's Modbus stack?

Modbus RTU delimits frames by silence: at least 3.5 character times between
them. At 9600 8N1 a character is ~1.04ms, so the required gap is ~3.65ms. A
master that starts transmitting sooner can be mis-framed by the slave, and a
cheap slave stack can end up stuck.

This runs identical read bursts at decreasing inter-frame gaps and reports the
failure rate for each, then checks whether the device recovers on its own.

Deliberately bounded: short bursts, and it aborts a phase after a few
consecutive failures rather than hammering a device that has already stopped
answering.

Usage:
    python gap_test.py COM3
"""
import sys
import time

import serial

from scan_blocks import build, crc16


def transact(ser, addr, count, gap):
    """One read. Returns True on a well-formed reply."""
    ser.reset_input_buffer()
    ser.write(build(1, 3, addr, count))
    ser.flush()
    resp = ser.read(5 + count * 2)
    time.sleep(gap)
    if len(resp) < 5 or resp[0] != 1 or resp[1] != 3:
        return False
    nbytes = resp[2]
    end = 3 + nbytes
    if len(resp) < end + 2:
        return False
    return crc16(resp[:end]) == resp[end:end + 2]


def phase(ser, label, gap, n=25):
    ok = 0
    fails = 0
    consecutive = 0
    for i in range(n):
        if transact(ser, 0x1000, 32, gap):
            ok += 1
            consecutive = 0
        else:
            fails += 1
            consecutive += 1
            if consecutive >= 5:
                print("    aborting phase after 5 consecutive failures")
                break
    total = ok + fails
    print("  %-28s %2d/%2d ok  (%d failed)" % (label, ok, total, fails))
    return fails


def main():
    port = sys.argv[1]
    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    try:
        print("Reading 0x1000 x25 at each inter-frame gap.")
        print("Modbus RTU minimum at 9600 8N1 is ~3.65ms.\n")

        results = {}
        for label, gap in [
            ("50ms (what Python used)", 0.050),
            ("10ms", 0.010),
            ("4ms (just above spec)", 0.004),
            ("1ms (below spec)", 0.001),
            ("0ms (what the app does)", 0.0),
        ]:
            results[label] = phase(ser, label, gap)
            time.sleep(0.5)  # let it settle between phases

        print("\nRecovery check after the 0ms burst:")
        time.sleep(2.0)
        recovered = phase(ser, "50ms again", 0.050, n=10)
        if recovered == 0:
            print("  -> device recovered on its own; no power cycle needed")
        else:
            print("  -> STILL FAILING. The stack is wedged; power cycle required.")

        print("\nSummary:")
        for label, fails in results.items():
            print("  %-28s %s" % (label, "clean" if fails == 0 else "%d failures" % fails))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
