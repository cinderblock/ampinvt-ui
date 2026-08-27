"""Map the AMPINVT TEL holding-register blocks. READ-ONLY (function 0x03 only)."""
import sys
import time

import serial


def crc16(data):
    crc = 0xFFFF
    for ch in data:
        crc ^= ch
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def build(slave, fc, addr, count):
    body = bytes([slave, fc]) + addr.to_bytes(2, "big") + count.to_bytes(2, "big")
    return body + crc16(body)


def read_regs(ser, addr, count, slave=1):
    """Return ('ok', [values]) / ('exc', code) / None."""
    ser.reset_input_buffer()
    ser.write(build(slave, 3, addr, count))
    ser.flush()
    time.sleep(0.05)
    resp = ser.read(300)
    if not resp or len(resp) < 5 or resp[0] != slave:
        return None
    if resp[1] == 0x83:
        return ("exc", resp[2])
    if resp[1] != 3:
        return None
    nbytes = resp[2]
    end = 3 + nbytes
    if len(resp) < end + 2 or crc16(resp[:end]) != resp[end:end + 2]:
        return None
    return ("ok", [int.from_bytes(resp[3 + i:5 + i], "big") for i in range(0, nbytes, 2)])


BASES = [0x0400, 0x0500, 0x0600, 0x0700, 0x0800, 0x0900, 0x0A00,
         0x1000, 0x1100, 0x1200, 0x1800, 0x2000, 0x2100]


def main():
    port = sys.argv[1]
    ser = serial.Serial(port, 9600, 8, "N", 1, timeout=0.4)
    try:
        for base in BASES:
            span = 0
            for count in (64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1):
                got = read_regs(ser, base, count)
                if got and got[0] == "ok":
                    span = count
                    break
            if not span:
                print("0x%04x : no readable span" % base)
                continue
            got = read_regs(ser, base, span)
            print("=== 0x%04x  span=%d ===" % (base, span))
            cells = []
            for i, val in enumerate(got[1]):
                cells.append("  +%02d 0x%04x=%-6d" % (i, base + i, val))
                if len(cells) == 4:
                    print("".join(cells))
                    cells = []
            if cells:
                print("".join(cells))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
