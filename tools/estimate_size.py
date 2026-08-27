"""Estimate delta-encoded log size from an existing full-dump log.

Answers the only question that matters before a long unattended capture: will
it fit? Replays a real log, re-encodes it the way the delta logger would, and
projects forward.

Usage:
    python estimate_size.py LOG [--interval 10] [--days 14]
"""
import argparse

from logreader import load_states


def encode_len(stamp, regs, full):
    """Byte length of a record as the Rust logger would write it."""
    body = ",".join('"%d":%d' % (a, v) for a, v in sorted(regs.items()))
    marker = ',"full":true' if full else ""
    return len('{"t":"%s"%s,"regs":{%s}}\n' % (stamp, marker, body))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--days", type=float, default=14.0)
    ap.add_argument("--full-every", type=int, default=360)
    args = ap.parse_args()

    rows = list(load_states(args.logfile))
    if len(rows) < 2:
        raise SystemExit("need at least two records")

    full_bytes = 0
    delta_bytes = 0
    previous = None
    since_full = 0
    changed_counts = []

    for stamp, regs in rows:
        full_bytes += encode_len(stamp, regs, True)

        is_full = previous is None or since_full >= args.full_every
        if is_full:
            delta_bytes += encode_len(stamp, regs, True)
            since_full = 0
        else:
            changed = {a: v for a, v in regs.items() if previous.get(a) != v}
            changed_counts.append(len(changed))
            delta_bytes += encode_len(stamp, changed, False)
            since_full += 1
        previous = regs

    n = len(rows)
    avg_changed = sum(changed_counts) / len(changed_counts) if changed_counts else 0

    print("%d records replayed" % n)
    print()
    print("  full dumps : %9.1f kB total  %7.0f B/record" % (full_bytes / 1024, full_bytes / n))
    print("  delta      : %9.1f kB total  %7.0f B/record" % (delta_bytes / 1024, delta_bytes / n))
    print("  saving     : %9.1f%%" % (100 * (1 - delta_bytes / full_bytes)))
    print("  avg registers changed per record: %.1f of 384" % avg_changed)
    print()

    per_record = delta_bytes / n
    per_day = per_record * (86400 / args.interval)
    print("projected at a %.0fs interval:" % args.interval)
    print("  per day    : %8.1f MB" % (per_day / 1024 / 1024))
    print("  %.0f days    : %8.1f MB" % (args.days, per_day * args.days / 1024 / 1024))
    print()
    print("(full-dump equivalent for %.0f days: %.1f MB)"
          % (args.days, (full_bytes / n) * (86400 / args.interval) * args.days / 1024 / 1024))


if __name__ == "__main__":
    main()
