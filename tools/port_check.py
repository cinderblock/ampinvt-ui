"""Report whether the serial port can be opened, and by implication who holds it.

Usage:
    python port_check.py COM3
"""
import sys

import serial


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "COM3"
    try:
        handle = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
        handle.close()
        print("%s is FREE" % port)
    except Exception as exc:
        print("%s is BUSY: %s" % (port, exc))


if __name__ == "__main__":
    main()
