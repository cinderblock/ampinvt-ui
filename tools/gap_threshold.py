"""Find the minimum inter-frame gap this inverter actually needs.

gap_test.py showed a clean split: 25/25 at 50ms, and exactly 13/25 at 10ms and
below. 13/25 is an alternating ok/fail pattern, so the device answers every
other request once the gap is too short. That is not the Modbus 3.5-character
rule (~3.65ms at 9600) - it is an order of magnitude longer, so the slave is
slow to re-arm its receiver rather than mis-framing.

This walks the gap between 10ms and 60ms to find where it becomes reliable, so
the app can use a justified number instead of a superstitious one.

Usage:
    python gap_threshold.py COM3 [reps]
"""
import sys
import time

import serial

from scan_blocks import build, crc16


def transact(ser, addr, count, gap):
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


def main():
    port = sys.argv[1]
    reps = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    try:
        print("gap(ms)  ok/total  verdict")
        print("-" * 34)
        first_clean = None
        for ms in (10, 15, 20, 25, 30, 35, 40, 45, 50, 60):
            ok = sum(1 for _ in range(reps) if transact(ser, 0x1000, 32, ms / 1000.0))
            verdict = "clean" if ok == reps else "%d lost" % (reps - ok)
            print("%7d  %3d/%-3d   %s" % (ms, ok, reps, verdict))
            if ok == reps and first_clean is None:
                first_clean = ms
            time.sleep(0.4)

        print()
        if first_clean is None:
            print("No gap up to 60ms was fully reliable.")
        else:
            print("First fully reliable gap: %dms" % first_clean)
            print("Recommend %dms in the app (2x margin over the observed threshold)."
                  % (first_clean * 2))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
