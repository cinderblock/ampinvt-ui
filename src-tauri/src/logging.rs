//! Background register logger.
//!
//! Runs in Rust rather than the frontend on purpose: logging must not stop
//! because the UI is on a different tab, minimised, or throttled by the
//! webview. It shares the serial port with the UI poller through the same
//! mutex, so there is never a second process fighting for COM3.
//!
//! Every readable register is written, not just the decoded ones. Most of this
//! device's map is still unidentified and the entire point of logging is to
//! catch an unnamed register moving in step with something we *can* name.
//! Dropping the unknown columns would discard exactly the data worth having.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Every block the survey found. Wider than the UI's poll set: the UI only
/// needs the blocks it decodes, the log wants everything.
pub const ALL_BLOCKS: &[(u16, u16)] = &[
    (0x0400, 32),
    (0x0500, 32),
    (0x0600, 32),
    (0x0700, 32),
    (0x0800, 32),
    (0x0900, 32),
    (0x0A00, 16),
    (0x1000, 32),
    (0x1100, 32),
    (0x1200, 32),
    (0x1800, 16),
    (0x2000, 32),
    (0x2100, 32),
];

#[derive(Default)]
pub struct Logger {
    pub running: Arc<AtomicBool>,
    pub records: Arc<AtomicU64>,
    pub path: Mutex<Option<PathBuf>>,
    pub last_error: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
pub struct LoggingStatus {
    pub running: bool,
    pub path: Option<String>,
    pub records: u64,
    pub last_error: Option<String>,
}

/// UTC, ISO-8601, second resolution. Stored absolute so it can be re-bucketed
/// losslessly; render it in local time at read time.
fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    // Civil-from-days, Howard Hinnant's algorithm. Avoids a date crate for one
    // timestamp format.
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

pub fn spawn(
    link: Arc<Mutex<Option<crate::modbus::Rtu>>>,
    logger: Arc<Logger>,
    path: PathBuf,
    interval: Duration,
) {
    std::thread::spawn(move || {
        while logger.running.load(Ordering::Relaxed) {
            let started = std::time::Instant::now();

            let mut values: Vec<(u16, u16)> = Vec::new();
            let mut connected = false;
            {
                let mut guard = link.lock().unwrap();
                if let Some(rtu) = guard.as_mut() {
                    connected = true;
                    for (addr, count) in ALL_BLOCKS {
                        if let Ok(regs) = rtu.read_holding(*addr, *count) {
                            for (i, v) in regs.iter().enumerate() {
                                values.push((addr + i as u16, *v));
                            }
                        }
                    }
                }
            } // lock released before any file I/O

            if connected && !values.is_empty() {
                let mut line = String::with_capacity(values.len() * 12 + 40);
                line.push_str("{\"t\":\"");
                line.push_str(&utc_now());
                line.push_str("\",\"regs\":{");
                for (i, (addr, value)) in values.iter().enumerate() {
                    if i > 0 {
                        line.push(',');
                    }
                    line.push_str(&format!("\"{addr}\":{value}"));
                }
                line.push_str("}}\n");

                let write = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .and_then(|mut f| f.write_all(line.as_bytes()));

                match write {
                    Ok(()) => {
                        logger.records.fetch_add(1, Ordering::Relaxed);
                        *logger.last_error.lock().unwrap() = None;
                    }
                    Err(e) => {
                        *logger.last_error.lock().unwrap() = Some(e.to_string());
                    }
                }
            }

            let elapsed = started.elapsed();
            if interval > elapsed {
                std::thread::sleep(interval - elapsed);
            }
        }
    });
}

pub fn status(logger: &Logger) -> LoggingStatus {
    LoggingStatus {
        running: logger.running.load(Ordering::Relaxed),
        path: logger
            .path
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.display().to_string()),
        records: logger.records.load(Ordering::Relaxed),
        last_error: logger.last_error.lock().unwrap().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::utc_now;

    #[test]
    fn timestamp_is_iso8601_utc() {
        let stamp = utc_now();
        assert_eq!(stamp.len(), 20, "got {stamp}");
        assert!(stamp.ends_with('Z'), "got {stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
    }
}
