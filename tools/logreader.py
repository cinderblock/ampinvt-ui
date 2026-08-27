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
import glob
import json
import os


def log_files(path):
    """Resolve a path to an ordered list of log files.

    Accepts a single file, or a directory of daily logs
    (``ampinvt-registers-YYYY-MM-DD.jsonl``). Date-stamped names sort
    chronologically as strings, which is the order they must be replayed in.
    """
    if os.path.isdir(path):
        found = sorted(glob.glob(os.path.join(path, "ampinvt-registers-*.jsonl")))
        if found:
            return found
        # Fall back to the pre-daily single-file layout.
        legacy = os.path.join(path, "ampinvt-registers.jsonl")
        return [legacy] if os.path.exists(legacy) else []
    return [path]


def load_states(path):
    """Yield (timestamp, {addr: value}) with deltas already applied.

    Accepts a file or a directory of daily files. The dict is a fresh copy per
    record, so callers can retain them.
    """
    for one in log_files(path):
        # Each daily file starts with its own full snapshot, so state does not
        # carry across the boundary — reset rather than risk applying one day's
        # delta on top of another day's state.
        yield from _load_one(one)


def load_failures(path):
    """Yield (timestamp, record) for sweeps that produced no usable data.

    These carry ``"ok": false`` and no ``regs``. They are the evidence that the
    device went mute at a particular moment, as opposed to the app simply not
    running — a distinction the log could not make before failures were
    recorded.
    """
    for one in log_files(path):
        with open(one, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or '"ok":false' not in line.replace(" ", ""):
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                yield rec.get("t", ""), rec


def _load_one(path):
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

            # Failure records carry no register data. Skipping them here keeps
            # the reconstructed state honest — a mute sweep must not be read as
            # "every register held its previous value", which would invent data.
            if "regs" not in rec:
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
    """Summary line: files, records, span, and how much is delta."""
    files = log_files(path)
    rows = load_rows(path)
    if not rows:
        return "empty log"
    full = 0
    total = 0
    for one in files:
        total += os.path.getsize(one)
        with open(one, "r", encoding="utf-8") as handle:
            for line in handle:
                if '"full":true' in line:
                    full += 1
    return "%d file(s), %.1f MB  %d records  %s .. %s  (%d full, %d deltas)" % (
        len(files), total / 1048576, len(rows), rows[0][0], rows[-1][0],
        full, len(rows) - full,
    )
