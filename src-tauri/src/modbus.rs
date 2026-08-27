//! Generic Modbus RTU over a serial port.
//!
//! Nothing in this module knows anything about AMPINVT. All device-specific
//! knowledge — which registers exist, what they mean, how they scale — lives in
//! the frontend's register map (`src/registers.ts`). Keeping the split here is
//! what would make a second device a data change rather than a rewrite.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use serialport::SerialPort;

/// Modbus RTU CRC-16: polynomial 0xA001, init 0xFFFF, low byte transmitted first.
pub fn crc16(data: &[u8]) -> [u8; 2] {
    let mut crc: u16 = 0xFFFF;
    for &byte in data {
        crc ^= byte as u16;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    [(crc & 0xFF) as u8, (crc >> 8) as u8]
}

#[derive(Debug)]
pub enum ModbusError {
    /// The device replied with a Modbus exception. Code 2 (ILLEGAL DATA ADDRESS)
    /// is the common one here — this inverter's address space is sparse.
    Exception(u8),
    /// No reply within the timeout. Usually the wrong baud/slave, or a dead link.
    Timeout,
    /// A reply arrived but was malformed: bad CRC, wrong slave, wrong function.
    Malformed(String),
    Io(String),
}

impl ModbusError {
    /// Short tag for aggregating failures in the log.
    ///
    /// The distinction matters more than it looks. A **timeout** means the
    /// request was never answered — the device did not speak, which is what
    /// MCU starvation under load looks like. A **CRC mismatch** means it did
    /// speak and the bytes arrived damaged, which is line corruption. Those
    /// have different causes and different fixes, and counting them separately
    /// is the cheapest way to tell which one is happening.
    pub fn kind(&self) -> &'static str {
        match self {
            ModbusError::Exception(_) => "exception",
            ModbusError::Timeout => "timeout",
            ModbusError::Malformed(why) if why.contains("CRC") => "crc",
            ModbusError::Malformed(_) => "malformed",
            ModbusError::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for ModbusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModbusError::Exception(2) => {
                write!(f, "Modbus exception 2 (illegal data address)")
            }
            ModbusError::Exception(code) => write!(f, "Modbus exception {code}"),
            ModbusError::Timeout => write!(f, "no reply (timeout)"),
            ModbusError::Malformed(why) => write!(f, "malformed reply: {why}"),
            ModbusError::Io(why) => write!(f, "serial I/O error: {why}"),
        }
    }
}

impl From<ModbusError> for String {
    fn from(err: ModbusError) -> String {
        err.to_string()
    }
}

/// Minimum silence between the end of one reply and the start of the next
/// request.
///
/// Modbus RTU only requires 3.5 character times — about 3.65ms at 9600 8N1 —
/// but this inverter needs far longer to re-arm its receiver. Measured on the
/// real unit with `gap_threshold.py`, reading 0x1000 thirty times per step:
///
///   10ms 15/30   15ms 19/30   20ms 21/30   25ms 29/30   30ms 30/30   60ms 30/30
///
/// Below the threshold it answers roughly every *other* request — a burst at
/// 0ms gap scores exactly 13/25, which is a perfect alternating pattern. 50ms
/// gives comfortable margin over the observed 30ms threshold and matches what
/// the Python tooling used, which ran for hours without a single lost frame.
const INTER_FRAME: Duration = Duration::from_millis(50);

/// Extra quiet before retrying a failed exchange, on top of INTER_FRAME.
///
/// After a timeout the device may still be mid-reply — we gave up, it did not.
/// Those bytes are landing in the driver buffer, and although the buffer is
/// cleared before each request, a reply still arriving *during* that clear
/// would be read as the start of the next frame. Waiting longer than any
/// plausible late reply removes the race.
const RECOVERY_SILENCE: Duration = Duration::from_millis(250);

pub struct Rtu {
    port: Box<dyn SerialPort>,
    slave: u8,
    /// When the last transaction finished, so the gap is enforced without
    /// penalising a caller that was already slow.
    last_txn: Option<Instant>,
}

/// Windows needs the `\\.\` prefix for COM10 and above; COM1-9 work bare.
fn normalize(path: &str) -> String {
    if cfg!(windows) && path.to_uppercase().starts_with("COM") && !path.starts_with(r"\\") {
        if let Ok(n) = path[3..].parse::<u32>() {
            if n >= 10 {
                return format!(r"\\.\{path}");
            }
        }
    }
    path.to_string()
}

impl Rtu {
    pub fn open(path: &str, baud: u32, slave: u8) -> Result<Self, ModbusError> {
        let mut port = serialport::new(normalize(path), baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            // The longest legitimate reply is 32 registers = 69 bytes, ~72ms at
            // 9600 baud. 300ms is generous margin, and keeps a dead device from
            // stalling a poll cycle for seconds.
            .timeout(Duration::from_millis(300))
            .open()
            .map_err(|e| ModbusError::Io(e.to_string()))?;

        // pyserial asserts both of these on open and that configuration is the
        // one proven to work against this inverter; the serialport crate does
        // not, so assert them explicitly rather than rely on the default.
        // Failure is not fatal — plenty of adapters ignore the lines entirely.
        let _ = port.write_data_terminal_ready(true);
        let _ = port.write_request_to_send(true);
        // Let the CH340 settle after the control lines move before the first
        // frame goes out, or the opening request can be swallowed.
        std::thread::sleep(Duration::from_millis(50));

        Ok(Rtu {
            port,
            slave,
            last_txn: None,
        })
    }

    fn transact(&mut self, request: &[u8], expect_fc: u8) -> Result<Vec<u8>, ModbusError> {
        // Enforce the inter-frame gap. Without it this device answers only
        // every other request; see INTER_FRAME for the measurements.
        if let Some(last) = self.last_txn {
            let since = last.elapsed();
            if since < INTER_FRAME {
                std::thread::sleep(INTER_FRAME - since);
            }
        }

        let result = self.transact_inner(request, expect_fc);

        // Stamp on every path, including failures. A timed-out or malformed
        // exchange still leaves the device needing its recovery window — if
        // anything it needs it more, so retrying instantly is the worst move.
        self.last_txn = Some(Instant::now());
        result
    }

    fn transact_inner(&mut self, request: &[u8], expect_fc: u8) -> Result<Vec<u8>, ModbusError> {
        self.port
            .clear(serialport::ClearBuffer::Input)
            .map_err(|e| ModbusError::Io(e.to_string()))?;
        self.port
            .write_all(request)
            .map_err(|e| ModbusError::Io(e.to_string()))?;
        self.port
            .flush()
            .map_err(|e| ModbusError::Io(e.to_string()))?;

        // Read the 3-byte header first so we know how much payload to expect.
        let mut head = [0u8; 3];
        if let Err(e) = self.port.read_exact(&mut head) {
            return Err(match e.kind() {
                std::io::ErrorKind::TimedOut => ModbusError::Timeout,
                _ => ModbusError::Io(e.to_string()),
            });
        }
        if head[0] != self.slave {
            return Err(ModbusError::Malformed(format!(
                "reply from slave {}, expected {}",
                head[0], self.slave
            )));
        }
        if head[1] == expect_fc | 0x80 {
            return Err(ModbusError::Exception(head[2]));
        }
        if head[1] != expect_fc {
            return Err(ModbusError::Malformed(format!(
                "function {:#04x}, expected {:#04x}",
                head[1], expect_fc
            )));
        }

        // For 0x03 the third byte is a byte count; for 0x06 the frame is fixed
        // width and the third byte is already payload.
        let remaining = if expect_fc == 0x03 {
            head[2] as usize + 2
        } else {
            3 + 2
        };
        let mut rest = vec![0u8; remaining];
        self.port
            .read_exact(&mut rest)
            .map_err(|e| ModbusError::Io(e.to_string()))?;

        let mut frame = head.to_vec();
        frame.extend_from_slice(&rest);
        let split = frame.len() - 2;
        if crc16(&frame[..split]) != frame[split..] {
            return Err(ModbusError::Malformed("CRC mismatch".into()));
        }
        Ok(frame)
    }

    /// Read a block, retrying a few times before giving up.
    ///
    /// A Modbus master is expected to retry — frames get lost. This one loses
    /// them measurably: forensics on a real stall found 95 of 179 sweeps
    /// dropping at least one block, climbing for twenty minutes before the link
    /// failed altogether, while the inverter was converting hard. Whatever the
    /// cause (EMI coupled into the cable is the leading candidate now that
    /// ground offset is ruled out — the host is a floating laptop), the loss is
    /// transient, and a single retry recovers most of it.
    ///
    /// Exception replies are NOT retried. A Modbus exception is the device
    /// answering correctly to say the address does not exist, which it will say
    /// just as firmly the second time; retrying those would triple the cost of
    /// every block-discovery sweep for nothing.
    pub fn read_holding_retry(
        &mut self,
        addr: u16,
        count: u16,
        attempts: u8,
    ) -> Result<Vec<u16>, ModbusError> {
        let mut last = ModbusError::Timeout;
        for attempt in 0..attempts.max(1) {
            match self.read_holding(addr, count) {
                Ok(values) => return Ok(values),
                Err(ModbusError::Exception(code)) => return Err(ModbusError::Exception(code)),
                Err(e) => {
                    last = e;
                    // Give the line longer than the usual gap before retrying.
                    // A reply that arrived after we gave up is still on its way
                    // into the buffer; retrying immediately would read its tail
                    // as the head of the next frame. Silence is how RTU
                    // resynchronises, so the fix is simply more of it.
                    if attempt + 1 < attempts.max(1) {
                        std::thread::sleep(RECOVERY_SILENCE);
                    }
                }
            }
        }
        Err(last)
    }

    /// Function 0x03 — read holding registers. This device implements only 0x03;
    /// 0x04 (input registers) is silent on every address.
    pub fn read_holding(&mut self, addr: u16, count: u16) -> Result<Vec<u16>, ModbusError> {
        let mut req = vec![self.slave, 0x03];
        req.extend_from_slice(&addr.to_be_bytes());
        req.extend_from_slice(&count.to_be_bytes());
        req.extend_from_slice(&crc16(&req));

        let frame = self.transact(&req, 0x03)?;
        let nbytes = frame[2] as usize;
        Ok(frame[3..3 + nbytes]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect())
    }

    /// Function 0x06 — write single register. Verified working on the TEL-5KW-120V.
    pub fn write_single(&mut self, addr: u16, value: u16) -> Result<u16, ModbusError> {
        let mut req = vec![self.slave, 0x06];
        req.extend_from_slice(&addr.to_be_bytes());
        req.extend_from_slice(&value.to_be_bytes());
        req.extend_from_slice(&crc16(&req));

        let frame = self.transact(&req, 0x06)?;
        Ok(u16::from_be_bytes([frame[4], frame[5]]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_known_frame() {
        // Captured from the real inverter: read holding reg 0 count 1.
        assert_eq!(crc16(&[0x01, 0x03, 0x00, 0x00, 0x00, 0x01]), [0x84, 0x0a]);
    }

    #[test]
    fn crc_matches_known_write_frame() {
        // The verified 15 A write: 0x1103 <- 150.
        assert_eq!(crc16(&[0x01, 0x06, 0x11, 0x03, 0x00, 0x96]), [0xfc, 0x98]);
    }

    #[test]
    fn windows_high_com_ports_get_prefixed() {
        if cfg!(windows) {
            assert_eq!(normalize("COM10"), r"\\.\COM10");
            assert_eq!(normalize("COM3"), "COM3");
        }
    }
}
