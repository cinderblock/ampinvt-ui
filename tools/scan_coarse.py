
import sys, time, serial

def crc16(d):
    c=0xFFFF
    for ch in d:
        c^=ch
        for _ in range(8):
            c=(c>>1)^0xA001 if c&1 else c>>1
    return bytes([c&0xFF,(c>>8)&0xFF])

def req(sl,fc,ad,ct=1):
    b=bytes([sl,fc])+ad.to_bytes(2,"big")+ct.to_bytes(2,"big")
    return b+crc16(b)

def talk(ser,fr):
    ser.reset_input_buffer(); ser.write(fr); ser.flush()
    time.sleep(0.04)
    return ser.read(64)

def classify(r,sl,fc):
    if not r: return ("silence",None)
    if len(r)<5: return ("short:"+r.hex(),None)
    if r[0]!=sl: return ("badslave:"+r.hex(),None)
    if r[1]==(fc|0x80): return ("exc%d"%r[2],None)
    if r[1]!=fc: return ("badfc:"+r.hex(),None)
    n=r[2]; end=3+n
    if len(r)<end+2: return ("trunc:"+r.hex(),None)
    if crc16(r[:end])!=r[end:end+2]: return ("crcerr:"+r.hex(),None)
    vals=[int.from_bytes(r[3+i:5+i],"big") for i in range(0,n,2)]
    return ("OK",vals)

port=sys.argv[1]
ser=serial.Serial(port,9600,8,"N",1,timeout=0.35)
print("coarse scan: fc=0x03 and 0x04, stride 256 across 0x0000-0xFFFF")
hits=[]
for fc in (0x03,0x04):
    kinds={}
    for base in range(0,0x10000,256):
        k,v=classify(talk(ser,req(1,fc,base)),1,fc)
        kinds[k]=kinds.get(k,0)+1
        if k=="OK":
            hits.append((fc,base,v))
            print("  OK   fc=%02x addr=%d (0x%04x) -> %s" % (fc,base,base,v))
    print("  fc=%02x summary: %s" % (fc, kinds))
ser.close()
print("total OK hits:", len(hits))
