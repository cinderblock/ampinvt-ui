"""Print the charge/discharge profile as currently set on the inverter.

Reads the last state from the log rather than the device, so it works while the
app holds the serial port.

Voltage SETTINGS are stored as 12V-equivalent tenths: volts = raw * 0.4. Live
readings are plain tenths. Confusing the two is the easiest mistake here.

Usage:
    python charge_profile.py LOGDIR
"""
import argparse

from logreader import load_rows

SETTING_V = 0.4
TENTHS = 0.1

BATTERY_TYPES = {
    0: "USE user-defined", 1: "SLd sealed lead-acid", 2: "FLd flooded lead-acid",
    3: "GEL lead-acid", 4: "L14 LiFePO4 14S", 5: "L15 LiFePO4 15S",
    6: "L16 LiFePO4 16S", 7: "N13 ternary 13S", 8: "N14 ternary 14S",
}

# (addr, label, scale, unit, per-cell divisor or None)
ROWS = [
    (0x1006, "Constant-charge voltage", SETTING_V, "V", 16),
    (0x1007, "[09] Boost (absorption)", SETTING_V, "V", 16),
    (0x1008, "[11] Float", SETTING_V, "V", 16),
    (0x101F, "[17] Equalization", SETTING_V, "V", 16),
    (0x1009, "Recovery point A", SETTING_V, "V", 16),
    (0x100A, "Recovery point B", SETTING_V, "V", 16),
    (0x100B, "[14] Under-voltage alarm", SETTING_V, "V", 16),
    (0x100C, "[12] Over-discharge", SETTING_V, "V", 16),
    (0x100D, "[15] Discharge limit", SETTING_V, "V", 16),
    (0x1018, "[04] Battery to Mains", SETTING_V, "V", 16),
    (0x1019, "[05] Mains to Battery", SETTING_V, "V", 16),
    (0x1003, "[07] Max charge current", TENTHS, "A", None),
    (0x1103, "[28] AC charge current", TENTHS, "A", None),
    (0x1106, "[36] Max PV charge current", TENTHS, "A", None),
    (0x1010, "Boost duration / AC out V", 1, "?", None),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    args = ap.parse_args()

    rows = load_rows(args.logdir)
    if not rows:
        raise SystemExit("no records")
    stamp, regs = rows[-1]
    print("state as of %s\n" % stamp)

    btype = regs.get(0x1002)
    print("battery type: %s (raw %s)\n" % (BATTERY_TYPES.get(btype, "?"), btype))

    print("%-30s %6s %9s %11s" % ("setting", "raw", "value", "per cell"))
    print("-" * 60)
    for addr, label, scale, unit, cells in ROWS:
        raw = regs.get(addr)
        if raw is None:
            print("%-30s %6s %9s" % (label, "-", "-"))
            continue
        value = raw * scale
        cell = "%9.3f V" % (value / cells) if cells else ""
        print("%-30s %6d %7.1f %s %s" % (label, raw, value, unit, cell))

    boost = regs.get(0x1007)
    float_v = regs.get(0x1008)
    if boost is not None and float_v is not None and boost == float_v:
        print()
        print("!! Float equals boost (%.1f V). The pack is held at full charge" % (boost * SETTING_V))
        print("   voltage indefinitely rather than being allowed to rest, which")
        print("   pushes the highest cell in an imbalanced pack into its own")
        print("   over-voltage cutoff even though the PACK voltage looks fine.")


if __name__ == "__main__":
    main()
