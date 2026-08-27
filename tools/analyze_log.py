"""Find meaning in an AMPINVT register log.

Reads the JSONL written by either `log_all.py` or the app's built-in logger and
ranks registers by how informative they were during the capture.

The point is identification, not display. A register earns attention by
*moving*, and it earns a guess at its meaning by moving *in step with something
already named*. So this reports:

  1. which registers changed at all (static ones are settings or padding)
  2. how they moved, in raw units and under each candidate scale
  3. how strongly each unknown correlates with a chosen reference register

Usage:
    python analyze_log.py ampinvt-registers.jsonl
    python analyze_log.py log.jsonl --ref 1280        # correlate against 0x0500
    python analyze_log.py log.jsonl --since 2026-08-26T20:00:00Z
"""
import argparse
import json
import math
import sys

# Registers whose meaning is already established, so the report can say
# "moves with battery voltage" rather than "moves with 0x0500".
KNOWN = {
    0x0500: "battery voltage (/10 V)",
    0x0501: "current? (/10 A)",
    0x1002: "battery type",
    0x1003: "max charge current (/10 A)",
    0x1006: "constant-charge V (x0.4)",
    0x1007: "boost V (x0.4)",
    0x1008: "float V (x0.4)",
    0x1103: "AC charge current (/10 A)",
    0x1106: "max PV charge current (/10 A)",
}


def load(path, since=None):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if since and rec.get("t", "") < since:
                continue
            rows.append((rec["t"], {int(k): v for k, v in rec["regs"].items()}))
    return rows


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--ref", type=lambda s: int(s, 0), default=0x0500,
                    help="reference register to correlate against (default 0x0500)")
    ap.add_argument("--since", help="ISO-8601 UTC lower bound")
    ap.add_argument("--top", type=int, default=40)
    args = ap.parse_args()

    rows = load(args.logfile, args.since)
    if not rows:
        sys.exit("no records in %s (or all filtered out by --since)" % args.logfile)

    addrs = sorted({a for _, regs in rows for a in regs})
    series = {a: [regs.get(a) for _, regs in rows] for a in addrs}

    print("%d records  %s .. %s  %d registers"
          % (len(rows), rows[0][0], rows[-1][0], len(addrs)))
    print()

    ref_series = series.get(args.ref)
    if ref_series is None:
        print("reference 0x%04x never appeared in the log" % args.ref)
        ref_series = []
    else:
        present = sum(1 for v in ref_series if v is not None)
        print("reference: 0x%04x  %s  (present in %d/%d records)"
              % (args.ref, KNOWN.get(args.ref, "unknown"), present, len(rows)))
    print()

    def signed(v):
        """Several live registers are signed int16 - 0x0501 goes negative when
        charging. Correlating the raw unsigned value would put -1 next to 65535
        and destroy the relationship."""
        return v - 65536 if v > 32767 else v

    moving = []
    for addr in addrs:
        raw = series[addr]
        vals = [v for v in raw if v is not None]
        if len(vals) < 2:
            continue
        lo, hi = min(vals), max(vals)
        if lo == hi:
            continue

        # Pairwise-complete correlation: use only the records where BOTH the
        # reference and this register were read. Per-block read failures leave
        # gaps, and requiring a full column threw away every candidate.
        xs, ys = [], []
        for i, rv in enumerate(ref_series):
            tv = raw[i] if i < len(raw) else None
            if rv is not None and tv is not None:
                xs.append(signed(rv))
                ys.append(signed(tv))
        corr = pearson(xs, ys) if len(xs) >= 5 else 0.0

        moving.append((addr, lo, hi, len(set(vals)), corr, vals[0], vals[-1]))

    static = len(addrs) - len(moving)
    print("%d registers moved, %d stayed constant" % (len(moving), static))
    print()

    # Rank by correlation strength, then by range - the two things that make a
    # register worth investigating.
    moving.sort(key=lambda r: (-abs(r[4]), -(r[2] - r[1])))

    print("%-8s %-10s %8s %8s %6s %7s  %-12s %s"
          % ("addr", "first->last", "min", "max", "uniq", "corr", "as /10", "meaning"))
    print("-" * 100)
    for addr, lo, hi, uniq, corr, first, last in moving[: args.top]:
        meaning = KNOWN.get(addr, "")
        flag = ""
        if not meaning:
            if abs(corr) >= 0.8:
                flag = "<<< strong match to reference"
            elif abs(corr) >= 0.5:
                flag = "<< moves with reference"
        print("0x%04x  %5d->%-5d %8d %8d %6d %7.2f  %6.1f->%-6.1f %s%s"
              % (addr, first, last, lo, hi, uniq, corr,
                 first / 10, last / 10, meaning, flag))

    print()
    print("Scale reminder: SETTINGS voltages are raw x0.4; live READINGS are raw / 10.")
    print("A register that tracks the reference but is not listed as known is the")
    print("kind of thing worth naming - check it against the inverter's LCD.")


if __name__ == "__main__":
    main()
