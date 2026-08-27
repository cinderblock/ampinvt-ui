#!/usr/bin/env python3
"""
Probe an AMPINVT TEL-series inverter (TEL-48502M100) over Modbus RTU.

Nothing about this inverter's serial protocol is documented by the vendor. The
baud rate, framing, slave id and register meanings are all *hypotheses* borrowed
from community work on the smaller HT-series (Bgilsing/ampinvt-ht12212-modbus).
This script exists to turn those hypotheses into measurements.

READ-ONLY. It only ever issues function codes 0x03 and 0x04. It will not write.

Usage:
    ./ampinvt_probe.py find          # autodetect port, hunt for baud + slave id
    ./ampinvt_probe.py sweep         # dump input + holding registers as a table
    ./ampinvt_probe.py watch         # poll the guessed live fields once a second

    Options: --port /dev/ttyUSB0 --baud 9600 --slave 1
"""

import argparse
import glob
import sys
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial missing. Add 'py3-pyserial' to the add-on's apks option.")

BAUDS = [9600, 19200, 4800, 38400, 2400, 115200, 57600]

# Hypothesised map, inherited from the HT-series. Confidence is theirs, not ours.
# Registers 8 and 10-12 read zero on the HT (it has no MPPT); on this unit they
# are the prime suspects for PV voltage / current / power.
INPUT_GUESS = {
    0:  ("AC input voltage",     0.1, "V"),
    1:  ("AC input frequency",   0.1, "Hz"),
    2:  ("AC output voltage",    0.1, "V"),
    3:  ("AC output frequency",  0.1, "Hz"),
    4:  ("Load percentage",      1,   "%"),
    5:  ("Output power",         1,   "W"),
    6:  ("Charge current",       0.1, "A"),
    7:  ("Battery voltage",      0.1, "V"),
    8:  ("UNKNOWN (PV volts?)",  0.1, "?"),
    9:  ("Battery capacity",     1,   "%"),
    10: ("UNKNOWN (PV amps?)",   0.1, "?"),
    11: ("UNKNOWN (PV watts?)",  1,   "?"),
    12: ("UNKNOWN",              1,   "?"),
    13: ("Temperature 1",        0.1, "C"),
    14: ("Temperature 2",        0.1, "C"),
    32: ("Status/mode word",     1,   "bits"),
}


def crc16(data):
    crc = 0xFFFF
    for ch in data:
        crc ^= ch
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def build(slave, fc, addr, count):
    body = bytes([slave, fc]) + addr.to_bytes(2, "big") + count.to_bytes(2, "big")
    return body + crc16(body)


def transact(ser, req, settle=0.06):
    ser.reset_input_buffer()
    ser.write(req)
    ser.flush()
    time.sleep(settle)
    return ser.read(256)


def parse(resp, slave, fc):
    """Return (regs, None) on success, (None, reason) otherwise."""
    if not resp:
        return None, "no reply"
    if len(resp) < 5:
        return None, "short (%d bytes: %s)" % (len(resp), resp.hex())
    if resp[0] != slave:
        return None, "wrong slave %d" % resp[0]
    if resp[1] == (fc | 0x80):
        return None, "modbus exception %d" % resp[2]
    if resp[1] != fc:
        return None, "wrong fc %d" % resp[1]
    nbytes = resp[2]
    end = 3 + nbytes
    if len(resp) < end + 2:
        return None, "truncated payload"
    if crc16(resp[:end]) != resp[end:end + 2]:
        return None, "CRC mismatch (%s)" % resp.hex()
    payload = resp[3:end]
    return [int.from_bytes(payload[i:i + 2], "big") for i in range(0, len(payload), 2)], None


def autodetect_port():
    for pattern in ("/dev/serial/by-id/*", "/dev/ttyUSB*", "/dev/ttyACM*"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    return None


def open_port(port, baud):
    return serial.Serial(port=port, baudrate=baud, bytesize=8,
                         parity="N", stopbits=1, timeout=0.6)


def cmd_find(args):
    port = args.port or autodetect_port()
    if not port:
        sys.exit("No serial device found. Is the USB cable plugged in?\n"
                 "Expected /dev/serial/by-id/* or /dev/ttyUSB*.")
    print("port: %s\n" % port)
    found = []
    for baud in ([args.baud] if args.baud else BAUDS):
        try:
            ser = open_port(port, baud)
        except Exception as exc:
            print("  %6d  cannot open: %s" % (baud, exc))
            continue
        with ser:
            for slave in ([args.slave] if args.slave else list(range(1, 8)) + [247]):
                for fc in (0x04, 0x03):
                    regs, why = parse(transact(ser, build(slave, fc, 0, 1)), slave, fc)
                    tag = "fc=0x%02x slave=%-3d baud=%-6d" % (fc, slave, baud)
                    if regs is not None:
                        print("  ANSWER  %s -> reg0=%d" % (tag, regs[0]))
                        found.append((baud, slave, fc))
                    elif why not in ("no reply",):
                        print("  hint    %s -> %s" % (tag, why))
    print()
    if found:
        baud, slave, fc = found[0]
        print("Use: --baud %d --slave %d   (answered on fc 0x%02x)" % (baud, slave, fc))
    else:
        # ASCII only: Windows consoles default to cp1252 and a decorative
        # character here crashes the script at exactly the moment it is trying
        # to tell you what went wrong.
        print("Nothing answered. Check, in order:\n"
              "  1. Is the inverter actually powered on (LCD lit)? The CH340 is\n"
              "     USB-powered, so it enumerates even when the inverter is off.\n"
              "  2. Setting [32] must be SLA, not BMS.\n"
              "  3. Setting [30] is the Modbus address (default 1).\n"
              "  4. Cable seated at both ends.\n"
              "  5. Failing that, try the WIFI RJ45 jack over RS485: pin 8 = A,\n"
              "     pin 7 = B, pin 1 = GND. Leave pin 2 (+5V) unconnected.")
    return 0 if found else 1


def read_block(ser, slave, fc, start, count):
    """Read a block, falling back to single registers when the block is refused."""
    regs, why = parse(transact(ser, build(slave, fc, start, count)), slave, fc)
    if regs is not None:
        return {start + i: v for i, v in enumerate(regs)}, None
    out, last = {}, why
    for addr in range(start, start + count):
        regs, why = parse(transact(ser, build(slave, fc, addr, 1)), slave, fc)
        if regs is not None:
            out[addr] = regs[0]
        else:
            last = why
    return out, (None if out else last)


def cmd_sweep(args):
    port = args.port or autodetect_port()
    if not port:
        sys.exit("No serial device found.")
    baud, slave = args.baud or 9600, args.slave or 1
    print("port %s  baud %d  slave %d\n" % (port, baud, slave))
    with open_port(port, baud) as ser:
        for fc, label, hi in ((0x04, "INPUT registers (fc 0x04)", 48),
                              (0x03, "HOLDING registers (fc 0x03)", 48)):
            print("=" * 62)
            print(label)
            print("=" * 62)
            values, err = read_block(ser, slave, fc, 0, hi)
            if err:
                print("  failed: %s\n" % err)
                continue
            print("  %-5s %-8s %s" % ("addr", "raw", "guess"))
            for addr in sorted(values):
                raw = values[addr]
                note = ""
                if fc == 0x04 and addr in INPUT_GUESS:
                    name, scale, unit = INPUT_GUESS[addr]
                    note = "%s = %g %s" % (name, raw * scale, unit)
                print("  %-5d %-8d %s" % (addr, raw, note))
            print()
    print("Cross-check every value against the inverter's LCD before trusting it.")
    return 0


def cmd_watch(args):
    port = args.port or autodetect_port()
    if not port:
        sys.exit("No serial device found.")
    baud, slave = args.baud or 9600, args.slave or 1
    keys = sorted(INPUT_GUESS)
    with open_port(port, baud) as ser:
        try:
            while True:
                values, err = read_block(ser, slave, 0x04, 0, 33)
                if err:
                    print("read failed: %s" % err)
                else:
                    parts = []
                    for addr in keys:
                        if addr in values:
                            name, scale, unit = INPUT_GUESS[addr]
                            parts.append("%s=%g%s" % (name.split()[0], values[addr] * scale, unit))
                    print(" | ".join(parts))
                time.sleep(1.0)          # the bus does not like faster than ~1 Hz
        except KeyboardInterrupt:
            print()
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["find", "sweep", "watch"])
    p.add_argument("--port")
    p.add_argument("--baud", type=int)
    p.add_argument("--slave", type=int)
    args = p.parse_args()
    return {"find": cmd_find, "sweep": cmd_sweep, "watch": cmd_watch}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
