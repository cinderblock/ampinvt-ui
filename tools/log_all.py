"""Continuously log every readable AMPINVT register to JSONL for later analysis.

READ-ONLY (function 0x03 only).

Why full dumps rather than only the decoded fields: most of this device's map is
still unidentified, and the whole point of logging is to catch the registers we
cannot yet name moving in correlation with something we can. Throwing away the
"unknown" columns would discard exactly the data worth having.

Timestamps are stored as UTC ISO-8601 so they can be re-bucketed losslessly;
render them in local time at read time.

Usage:
    python log_all.py COM3 [interval_seconds] [outfile]
"""
import json
import sys
import time
from datetime import datetime, timezone

import serial

from scan_blocks import BASES, read_regs

# Widths found by the block survey. 0x0a00 and 0x1800 are short.
SPANS = {base: (16 if base in (0x0A00, 0x1800) else 32) for base in BASES}


def snapshot(ser):
    values = {}
    errors = {}
    for base, span in SPANS.items():
        got = read_regs(ser, base, span)
        if got and got[0] == "ok":
            for i, value in enumerate(got[1]):
                values[base + i] = value
        else:
            errors[hex(base)] = "exc%s" % (got[1] if got else "none")
    return values, errors


def main():
    port = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    outfile = sys.argv[3] if len(sys.argv) > 3 else "ampinvt_log.jsonl"

    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    previous = None
    written = 0
    print("logging %s every %.1fs -> %s" % (port, interval, outfile), flush=True)

    try:
        while True:
            started = time.time()
            values, errors = snapshot(ser)
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

            record = {
                "t": stamp,
                "regs": {str(k): v for k, v in sorted(values.items())},
            }
            if errors:
                record["errors"] = errors

            with open(outfile, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
            written += 1

            # Print only what moved, so the console stays readable over hours.
            if previous is None:
                print("%s  baseline: %d registers" % (stamp, len(values)), flush=True)
            else:
                moved = {a: (previous[a], v) for a, v in values.items()
                         if a in previous and previous[a] != v}
                if moved:
                    parts = ["0x%04x %d->%d" % (a, o, n) for a, (o, n) in sorted(moved.items())]
                    print("%s  %s" % (stamp, "  ".join(parts)), flush=True)
            previous = values

            time.sleep(max(0.0, interval - (time.time() - started)))
    except KeyboardInterrupt:
        print("stopped after %d records" % written, flush=True)
    finally:
        ser.close()


if __name__ == "__main__":
    main()
