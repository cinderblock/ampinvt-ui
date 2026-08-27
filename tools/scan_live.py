"""Sample the AMPINVT TEL register blocks twice and report what moves.

Registers that change between samples are live telemetry; the rest are config.
READ-ONLY (function 0x03 only).
"""
import sys
import time

import serial

from scan_blocks import BASES, read_regs


def snapshot(ser, spans):
    out = {}
    for base, span in spans.items():
        got = read_regs(ser, base, span)
        if got and got[0] == "ok":
            for i, val in enumerate(got[1]):
                out[base + i] = val
    return out


def main():
    port = sys.argv[1]
    gap = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    try:
        spans = {}
        for base in BASES:
            for count in (32, 16, 8, 4, 2, 1):
                got = read_regs(ser, base, count)
                if got and got[0] == "ok":
                    spans[base] = count
                    break

        first = snapshot(ser, spans)
        print("sampled %d registers; waiting %.1fs ..." % (len(first), gap))
        time.sleep(gap)
        second = snapshot(ser, spans)

        changed = [a for a in sorted(first) if a in second and first[a] != second[a]]
        print("=== CHANGED (live telemetry) : %d ===" % len(changed))
        for addr in changed:
            print("  0x%04x : %-6d -> %-6d   (delta %+d)"
                  % (addr, first[addr], second[addr], second[addr] - first[addr]))

        nonzero_static = [a for a in sorted(first)
                          if a not in changed and first[a] not in (0,)]
        print("=== static and non-zero : %d ===" % len(nonzero_static))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
