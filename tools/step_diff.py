"""Diff register values across a known physical step change.

The strongest identification signal available: the user recorded the battery's
own readout at two timestamps one minute apart, across a large, known change
(wall charger removed - 19.78A charging drops to 0.53A). Any register that
tracks charge current must move sharply across that boundary; anything that
does not, is not it.

Usage:
    python step_diff.py LOG --before 2026-08-27T00:51 --after 2026-08-27T00:52
"""
import argparse

from logreader import load_rows


def signed(v):
    return v - 65536 if v > 32767 else v


def load(path):
    # Goes through logreader so delta records are reconstructed. Reading them
    # raw would make every unchanged register look absent.
    return load_rows(path)


def nearest(rows, prefix):
    """Last record whose timestamp starts with the given prefix."""
    hits = [r for r in rows if r[0].startswith(prefix)]
    return hits[-1] if hits else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--min-delta", type=int, default=1)
    args = ap.parse_args()

    rows = load(args.logfile)
    a = nearest(rows, args.before)
    b = nearest(rows, args.after)
    if not a:
        raise SystemExit("no record matching %s" % args.before)
    if not b:
        raise SystemExit("no record matching %s" % args.after)

    print("before: %s" % a[0])
    print("after:  %s" % b[0])
    print()

    changed = []
    for addr in sorted(set(a[1]) & set(b[1])):
        x, y = a[1][addr], b[1][addr]
        if x == y:
            continue
        sx, sy = signed(x), signed(y)
        if abs(sy - sx) < args.min_delta:
            continue
        changed.append((addr, x, y, sx, sy))

    print("%-8s %14s %14s %12s %12s" % ("addr", "raw before", "raw after", "signed /10", "delta"))
    print("-" * 68)
    for addr, x, y, sx, sy in changed:
        print("0x%04x %14d %14d %8.1f->%-6.1f %10.1f"
              % (addr, x, y, sx / 10, sy / 10, (sy - sx) / 10))

    print()
    print("%d registers changed across the step." % len(changed))


if __name__ == "__main__":
    main()
