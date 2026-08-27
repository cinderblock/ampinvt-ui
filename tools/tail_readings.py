"""Print the last N decoded readings from a log.

For looking at what the inverter was doing immediately before it stopped
answering. Shows the identified live registers plus the strongest unidentified
movers, since a cause may well show up in a register we cannot name yet.

Usage:
    python tail_readings.py LOGDIR [--n 25]
"""
import argparse

from logreader import load_rows

FIELDS = [
    (0x0500, "battV", 0.1, 1, True),
    (0x0501, "battA", 0.1, 1, True),
    (0x0507, "pvV", 0.1, 1, False),
    (0x061F, "acinV", 0.1, 1, False),
    (0x0502, "soc%", 1, 0, False),
    (0x0509, "r0509", 1, 0, False),
    (0x0510, "r0510", 1, 0, False),
    (0x061E, "r061e", 1, 0, False),
]


def signed(v):
    return v - 65536 if v > 32767 else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    ap.add_argument("--n", type=int, default=25)
    args = ap.parse_args()

    rows = load_rows(args.logdir)
    if not rows:
        raise SystemExit("no records")

    header = "%-21s " % "timestamp (UTC)" + " ".join("%7s" % f[1] for f in FIELDS)
    print(header)
    print("-" * len(header))

    for stamp, regs in rows[-args.n:]:
        cells = []
        for addr, _, scale, decimals, is_signed in FIELDS:
            if addr in regs:
                raw = signed(regs[addr]) if is_signed else regs[addr]
                cells.append("%7.*f" % (decimals, raw * scale))
            else:
                cells.append("%7s" % "-")
        print("%-21s %s" % (stamp, " ".join(cells)))


if __name__ == "__main__":
    main()
