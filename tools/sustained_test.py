"""Simulate the app's polling pattern for a while and count losses.

The gap tests proved 30ms+ is reliable over 30 reads. This checks the thing
those tests could not: whether it stays reliable under the app's real duty
cycle, sustained. The original failure only appeared after prolonged running,
so a short burst passing proves less than it seems.

Mimics v0.4.0:
  * fast blocks (0x0500, 0x0600) every 1s
  * slow blocks (0x0400, 0x1000, 0x1100) every 15s
  * 50ms inter-frame gap throughout

Usage:
    python sustained_test.py COM3 [seconds]
"""
import sys
import time

import serial

from scan_blocks import build, crc16

GAP = 0.050
FAST = [0x0500, 0x0600]
SLOW = [0x0400, 0x1000, 0x1100]


def read_block(ser, addr, count=32):
    ser.reset_input_buffer()
    ser.write(build(1, 3, addr, count))
    ser.flush()
    resp = ser.read(5 + count * 2)
    time.sleep(GAP)
    if len(resp) < 5 or resp[0] != 1 or resp[1] != 3:
        return False
    nbytes = resp[2]
    end = 3 + nbytes
    if len(resp) < end + 2:
        return False
    return crc16(resp[:end]) == resp[end:end + 2]


def main():
    port = sys.argv[1]
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0

    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    ok = 0
    fail = 0
    fail_detail = []
    started = time.time()
    last_slow = 0.0

    print("simulating app poll pattern for %.0fs (gap %dms)..." % (duration, GAP * 1000))
    try:
        while time.time() - started < duration:
            cycle = time.time()
            blocks = list(FAST)
            if cycle - last_slow >= 15.0:
                blocks += SLOW
                last_slow = cycle

            for addr in blocks:
                if read_block(ser, addr):
                    ok += 1
                else:
                    fail += 1
                    fail_detail.append((round(cycle - started, 1), hex(addr)))

            elapsed = time.time() - cycle
            if elapsed < 1.0:
                time.sleep(1.0 - elapsed)
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()

    total = ok + fail
    print()
    print("reads: %d   ok: %d   failed: %d   (%.2f%% loss)"
          % (total, ok, fail, 100.0 * fail / total if total else 0.0))
    if fail_detail:
        print("failures at (seconds, block):")
        for when, addr in fail_detail[:20]:
            print("  %6.1fs  %s" % (when, addr))
    else:
        print("clean - no lost frames for the whole run")


if __name__ == "__main__":
    main()
