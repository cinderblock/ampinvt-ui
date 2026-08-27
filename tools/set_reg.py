"""Write a single AMPINVT TEL holding register, with guards and verification.

Safety model:
  * refuses to write unless the register currently holds an expected value
  * snapshots the whole surrounding 32-register block before and after
  * reports every register that changed, not just the target
  * tries function 0x06 first, falls back to 0x10

Usage:
    python set_reg.py COM3 0x1103 150 --expect 400
    python set_reg.py COM3 0x1103 150 --expect 400 --commit
Without --commit it is a dry run: it reads and reports but writes nothing.
"""
import argparse
import sys
import time

import serial

from scan_blocks import crc16, read_regs


def build_write_single(slave, addr, value):
    body = bytes([slave, 0x06]) + addr.to_bytes(2, "big") + value.to_bytes(2, "big")
    return body + crc16(body)


def build_write_multi(slave, addr, value):
    body = (bytes([slave, 0x10]) + addr.to_bytes(2, "big") + (1).to_bytes(2, "big")
            + bytes([2]) + value.to_bytes(2, "big"))
    return body + crc16(body)


def transact(ser, frame):
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    time.sleep(0.08)
    return ser.read(64)


def describe(resp, fc):
    if not resp:
        return "no reply"
    if len(resp) >= 3 and resp[1] == (fc | 0x80):
        return "exception %d" % resp[2]
    return "ok (%s)" % resp.hex()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("addr")
    ap.add_argument("value", type=int)
    ap.add_argument("--expect", type=int, required=True)
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()

    addr = int(args.addr, 0)
    base = addr & 0xFF00
    offset = addr - base

    ser = serial.Serial(args.port, 9600, 8, "N", 1, timeout=0.5)
    try:
        before = read_regs(ser, base, 32)
        if not before or before[0] != "ok":
            sys.exit("could not read block 0x%04x: %r" % (base, before))
        current = before[1][offset]
        print("register 0x%04x currently = %d" % (addr, current))

        if current != args.expect:
            sys.exit("ABORT: expected %d, found %d. Refusing to write."
                     % (args.expect, current))
        if not args.commit:
            print("dry run only - would write %d. Re-run with --commit." % args.value)
            return

        resp = transact(ser, build_write_single(1, addr, args.value))
        print("fc 0x06 -> %s" % describe(resp, 0x06))
        if not resp or (len(resp) >= 2 and resp[1] == 0x86):
            resp = transact(ser, build_write_multi(1, addr, args.value))
            print("fc 0x10 -> %s" % describe(resp, 0x10))

        time.sleep(0.3)
        after = read_regs(ser, base, 32)
        if not after or after[0] != "ok":
            sys.exit("could not re-read block: %r" % (after,))

        changed = [(base + i, a, b) for i, (a, b) in enumerate(zip(before[1], after[1]))
                   if a != b]
        print("=== changed registers in block 0x%04x ===" % base)
        for a, old, new in changed:
            flag = "  <-- target" if a == addr else "  *** UNEXPECTED"
            print("  0x%04x : %d -> %d%s" % (a, old, new, flag))
        if not changed:
            print("  none - the write did NOT take effect")
        target_now = after[1][offset]
        print("result: 0x%04x = %d (wanted %d) : %s"
              % (addr, target_now, args.value,
                 "OK" if target_now == args.value else "MISMATCH"))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
