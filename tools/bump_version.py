"""Set the version in all three places, then prove it.

There are three files that must agree, and CI refuses to build when the tag and
tauri.conf.json disagree. Bumping them with a search-and-replace on the *old*
version is fragile: if the file has drifted, the replace matches nothing,
silently does nothing, and the mistake only surfaces as a failed release build
several minutes later. That happened three releases running.

So this matches on the key rather than the old value, and re-reads every file
afterwards, exiting non-zero unless all three actually hold the target.

Usage:
    python tools/bump_version.py 0.8.1
    python tools/bump_version.py --check          # verify agreement, change nothing
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAURI_CONF = os.path.join(ROOT, "src-tauri", "tauri.conf.json")
PACKAGE_JSON = os.path.join(ROOT, "package.json")
CARGO_TOML = os.path.join(ROOT, "src-tauri", "Cargo.toml")


def read_json_version(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)["version"]


def read_cargo_version(path):
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            match = re.match(r'^version\s*=\s*"([^"]+)"', line)
            if match:
                return match.group(1)
    raise SystemExit("no version line in %s" % path)


def write_json_version(path, version):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    # Only the first "version" key, which is the package's own.
    updated, n = re.subn(r'("version"\s*:\s*)"[^"]*"', r'\1"%s"' % version, text, count=1)
    if n != 1:
        raise SystemExit("could not find a version key in %s" % path)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(updated)


def write_cargo_version(path, version):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    updated, n = re.subn(r'(?m)^version\s*=\s*"[^"]*"', 'version = "%s"' % version, text, count=1)
    if n != 1:
        raise SystemExit("could not find a version line in %s" % path)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(updated)


def current():
    return {
        "tauri.conf.json": read_json_version(TAURI_CONF),
        "package.json": read_json_version(PACKAGE_JSON),
        "Cargo.toml": read_cargo_version(CARGO_TOML),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version", nargs="?")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check or not args.version:
        found = current()
        for name, value in found.items():
            print("  %-18s %s" % (name, value))
        if len(set(found.values())) != 1:
            sys.exit("MISMATCH - these must agree before tagging")
        print("all agree: %s" % next(iter(found.values())))
        return

    target = args.version.lstrip("v")
    write_json_version(TAURI_CONF, target)
    write_json_version(PACKAGE_JSON, target)
    write_cargo_version(CARGO_TOML, target)

    # Re-read from disk. Never report success from the value we intended to
    # write - that is exactly the failure this script exists to prevent.
    found = current()
    for name, value in found.items():
        mark = "ok" if value == target else "WRONG"
        print("  %-18s %-10s %s" % (name, value, mark))
    if any(v != target for v in found.values()):
        sys.exit("bump failed - files do not all hold %s" % target)
    print("all three at %s; safe to tag v%s" % (target, target))


if __name__ == "__main__":
    main()
