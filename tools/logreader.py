"""Read ampinvt-registers.jsonl, reconstructing full state from deltas.

The log is delta-encoded: a record carrying "full": true holds every register,
and the records after it hold only what changed. Reading a delta record as if
it were a complete snapshot is silently wrong - it looks like every unmentioned
register dropped out - so every consumer must go through here.

Older logs are entirely full records with no "full" key. Those still load
correctly: a record whose contents are a superset of nothing is just applied on
top of an empty state.

    from logreader import load_states
    for stamp, regs in load_states(path):
        ...   # regs is the complete register state at that moment
"""
import json


def load_states(path):
    """Yield (timestamp, {addr: value}) with deltas already applied.

    The dict is a fresh copy per record, so callers can retain them.
    """
    state = {}
    seen_full = False

    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            regs = {int(k): v for k, v in rec.get("regs", {}).items()}

            if rec.get("full"):
                state = dict(regs)
                seen_full = True
            else:
                # A pre-delta log has no "full" markers at all. Treat the first
                # record as the baseline rather than skipping the whole file.
                if not seen_full and not state:
                    seen_full = True
                state.update(regs)

            yield rec.get("t", ""), dict(state)


def load_rows(path):
    """All records as a list. Convenient when two passes are needed."""
    return list(load_states(path))


def describe(path):
    """Summary line for a log file: records, span, and how much is delta."""
    rows = load_rows(path)
    if not rows:
        return "empty log"
    full = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if '"full":true' in line:
                full += 1
    return "%d records  %s .. %s  (%d full snapshots, %d deltas)" % (
        len(rows), rows[0][0], rows[-1][0], full, len(rows) - full,
    )
