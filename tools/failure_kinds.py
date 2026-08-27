"""Separate starvation from corruption in the failure record.

Two failure kinds have different causes and different fixes:

  timeout  - the request was never answered. The device did not speak. This is
             what an MCU too busy converting to service its UART looks like.
  crc      - it did speak, and the bytes arrived damaged. That is corruption on
             the line.

Guessing between them wastes effort on the wrong fix, so the logger records
which one occurred and this counts them, bucketed by hour so a correlation with
load or with time-into-a-session is visible.

Usage:
    python failure_kinds.py LOGDIR
"""
import argparse
import json
from collections import Counter, defaultdict

from logreader import log_files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    args = ap.parse_args()

    kinds = Counter()
    by_hour = defaultdict(Counter)
    unlabelled = 0

    for path in log_files(args.logdir):
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or '"failed"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not rec.get("failed"):
                    continue
                kind = rec.get("kind")
                if kind is None:
                    # Written before failure kinds were recorded.
                    unlabelled += 1
                    continue
                kinds[kind] += 1
                by_hour[rec.get("t", "")[:13]][kind] += 1

    if not kinds and not unlabelled:
        print("no failures recorded - nothing to explain")
        return

    print("failure kinds")
    print("-" * 40)
    for kind, n in kinds.most_common():
        print("  %-10s %5d" % (kind, n))
    if unlabelled:
        print("  %-10s %5d  (logged before kinds were recorded)" % ("unlabelled", unlabelled))

    if by_hour:
        print()
        print("by hour (UTC)")
        print("-" * 40)
        for hour in sorted(by_hour):
            parts = " ".join("%s=%d" % kv for kv in sorted(by_hour[hour].items()))
            print("  %s  %s" % (hour, parts))

    print()
    if kinds.get("timeout", 0) > 3 * kinds.get("crc", 0):
        print("Mostly timeouts: the device is not answering rather than answering")
        print("badly. Consistent with the MCU being too busy to service its UART.")
        print("Retrying and polling less often are the levers; line quality is not.")
    elif kinds.get("crc", 0) > 3 * kinds.get("timeout", 0):
        print("Mostly CRC errors: the device answers and the bytes arrive damaged.")
        print("That is corruption, so line quality is the lever - shorter cable,")
        print("ferrites, routing away from the power runs.")
    elif kinds:
        print("Mixed timeouts and CRC errors - no single cause dominates yet.")


if __name__ == "__main__":
    main()
