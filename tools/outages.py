"""When did the inverter stop answering, and what was happening just before?

Two distinct things look the same in a log and must be told apart:

  * a run of FAILURE records - the app was polling and the device was mute
  * a GAP with no records at all - the app was not running, or the machine slept

The first is an inverter problem. The second is a host problem. Conflating them
sends you chasing the wrong fault, so this reports them separately.

For each outage it also prints the last few readings before it started, since
the goal is correlating stalls against operating conditions.

Usage:
    python outages.py LOGDIR [--interval 5] [--context 4]
"""
import argparse
from datetime import datetime, timedelta, timezone

from logreader import load_failures, load_rows

# Registers worth seeing in the run-up to a stall.
CONTEXT = [
    (0x0500, "battery V", 0.1),
    (0x0501, "battery A", 0.1),
    (0x0507, "PV V", 0.1),
    (0x061F, "AC in V", 0.1),
]


def parse_time(stamp):
    try:
        return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def signed(v):
    return v - 65536 if v > 32767 else v


def local(dt):
    """Render in the machine's local zone; logs are stored UTC deliberately."""
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def group_runs(times, interval, slack=3.0):
    """Collapse consecutive timestamps into (start, end, count) runs."""
    runs = []
    for t in times:
        if runs and (t - runs[-1][1]).total_seconds() <= interval * slack:
            start, _, n = runs[-1]
            runs[-1] = (start, t, n + 1)
        else:
            runs.append((t, t, 1))
    return runs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--context", type=int, default=4)
    args = ap.parse_args()

    good = [(parse_time(t), regs) for t, regs in load_rows(args.logdir)]
    good = [(t, r) for t, r in good if t]
    bad = [(parse_time(t), rec) for t, rec in load_failures(args.logdir)]
    bad = [(t, r) for t, r in bad if t]

    if not good and not bad:
        raise SystemExit("no records found in %s" % args.logdir)

    everything = sorted([t for t, _ in good] + [t for t, _ in bad])
    print("log spans %s .. %s" % (local(everything[0]), local(everything[-1])))
    print("%d good records, %d failure records" % (len(good), len(bad)))
    print()

    # --- device mute: runs of failure records -----------------------------
    print("=" * 70)
    print("DEVICE MUTE  (app polling, inverter not answering)")
    print("=" * 70)
    runs = group_runs([t for t, _ in bad], args.interval)
    if not runs:
        print("  none")
    for start, end, n in runs:
        dur = (end - start).total_seconds()
        print("\n  from %s" % local(start))
        print("  to   %s   (%.0f s, %d sweeps)" % (local(end), dur, n))
        reason = next((r.get("err") for t, r in bad if t == start), None)
        if reason:
            print("  reason: %s" % reason)
        for t, rec in bad:
            if start <= t <= end and rec.get("note"):
                print("  note:   %s  @ %s" % (rec["note"], local(t)))
                break

        before = [(t, r) for t, r in good if t < start][-args.context:]
        if before:
            print("  last readings before it stopped:")
            for t, regs in before:
                parts = []
                for addr, name, scale in CONTEXT:
                    if addr in regs:
                        parts.append("%s %.1f" % (name, signed(regs[addr]) * scale))
                print("    %s  %s" % (local(t), "  ".join(parts)))

    # --- host gaps: no records at all -------------------------------------
    print()
    print("=" * 70)
    print("LOGGING GAPS  (no records at all - app stopped, or machine asleep)")
    print("=" * 70)
    gaps = []
    for a, b in zip(everything, everything[1:]):
        delta = (b - a).total_seconds()
        if delta > max(60.0, args.interval * 6):
            gaps.append((a, b, delta))
    if not gaps:
        print("  none")
    for a, b, delta in gaps:
        print("  %s  ->  %s   (%s)" % (local(a), local(b), timedelta(seconds=int(delta))))


if __name__ == "__main__":
    main()
