"""Find sweeps where only SOME blocks read successfully.

A partial read is the interesting middle ground between working and mute. The
logger emits a full snapshot whenever the set of readable registers changes, so
a sweep in which some blocks failed produces a snapshot holding only the blocks
that answered. Those are visible here as an unusually small "full" record.

If partials cluster before a total failure, the link degrades rather than
dropping dead - which points at something quite different from an inverter that
simply stops.

Usage:
    python partials.py LOGDIR
"""
import argparse
import json

from logreader import log_files

# A healthy sweep reads every block; anything much smaller lost some.
COMPLETE = 300


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    # A block is 32 registers, so "one block short" is 352 of 384. Defaulting
    # the threshold low enough to catch a single missing block matters — the
    # first pass used 300 and hid exactly that case.
    ap.add_argument("--complete", type=int, default=COMPLETE)
    args = ap.parse_args()

    full = []
    for path in log_files(args.logdir):
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("full"):
                    full.append((rec.get("t", ""), len(rec.get("regs", {}))))

    if not full:
        print("no full snapshots found")
        return

    partial = [(t, n) for t, n in full if n < args.complete]
    print("full snapshots: %d" % len(full))
    print("incomplete (<%d registers): %d" % (args.complete, len(partial)))
    print()

    if partial:
        print("incomplete sweeps - the link was dropping blocks:")
        for t, n in partial[-25:]:
            print("  %s  %3d registers" % (t, n))
    else:
        print("none - every sweep either read everything or nothing")

    sizes = [n for _, n in full]
    print()
    print("snapshot sizes: min %d, max %d, last %s"
          % (min(sizes), max(sizes), sizes[-3:]))


if __name__ == "__main__":
    main()
