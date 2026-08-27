"""Compare register means between two time windows.

A single-sample diff across a transition is noisy: solar moves, currents ripple,
and a register can appear to step when it merely wobbled. Averaging over the
whole of each period suppresses that, which matters when the signal being looked
for (a ~140W load) is smaller than the noise source competing with it (cloud).

Reports the difference in means alongside the within-period spread, because a
shift smaller than the noise is not a finding no matter how neat it looks.

Usage:
    python period_compare.py LOG --a 21:27 21:36 --b 21:37 21:45
"""
import argparse
from statistics import mean, pstdev

from logreader import load_rows


def signed(v):
    return v - 65536 if v > 32767 else v


def in_window(stamp, start, end):
    time_part = stamp[11:19]
    return start <= time_part[: len(start)] and time_part[: len(end)] <= end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--a", nargs=2, required=True, metavar=("START", "END"))
    ap.add_argument("--b", nargs=2, required=True, metavar=("START", "END"))
    ap.add_argument("--label-a", default="A")
    ap.add_argument("--label-b", default="B")
    args = ap.parse_args()

    rows = load_rows(args.logfile)
    bucket_a, bucket_b = {}, {}
    n_a = n_b = 0

    for stamp, regs in rows:
        clock = stamp[11:19]
        if args.a[0] <= clock <= args.a[1]:
            target, n_a = bucket_a, n_a + 1
        elif args.b[0] <= clock <= args.b[1]:
            target, n_b = bucket_b, n_b + 1
        else:
            continue
        for addr, value in regs.items():
            target.setdefault(addr, []).append(signed(value))

    if not bucket_a or not bucket_b:
        raise SystemExit("one of the windows caught no records")

    print("%s: %d samples   %s: %d samples\n" % (args.label_a, n_a, args.label_b, n_b))
    print("%-8s %10s %10s %10s %10s %8s" %
          ("addr", args.label_a, args.label_b, "delta", "noise", "signal"))
    print("-" * 62)

    findings = []
    for addr in sorted(set(bucket_a) & set(bucket_b)):
        va, vb = bucket_a[addr], bucket_b[addr]
        if len(va) < 3 or len(vb) < 3:
            continue
        ma, mb = mean(va), mean(vb)
        delta = mb - ma
        # Pooled spread. A shift buried inside the within-period noise is not a
        # finding, however tidy the means look.
        noise = max(pstdev(va), pstdev(vb), 0.5)
        ratio = abs(delta) / noise
        if abs(delta) < 0.5:
            continue
        findings.append((ratio, addr, ma, mb, delta, noise))

    findings.sort(reverse=True)
    for ratio, addr, ma, mb, delta, noise in findings[:25]:
        flag = "  <<<" if ratio >= 3 else ("  <<" if ratio >= 2 else "")
        print("0x%04x %10.1f %10.1f %+10.1f %10.1f %8.1f%s"
              % (addr, ma, mb, delta, noise, ratio, flag))

    print()
    print("signal = |delta| / noise. Below ~2 the shift is inside the ordinary")
    print("variation of the period and should not be treated as a step.")


if __name__ == "__main__":
    main()
