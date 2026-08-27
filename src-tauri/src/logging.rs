//! Background register logger.
//!
//! Runs in Rust rather than the frontend on purpose: logging must not stop
//! because the UI is on a different tab, minimised, or throttled by the
//! webview. It shares the serial port with the UI poller through the same
//! mutex, so there is never a second process fighting for the COM port.
//!
//! Every readable register is captured, not just the decoded ones. Most of this
//! device's map is still unidentified and the entire point of logging is to
//! catch an unnamed register moving in step with something we *can* name.
//! Dropping the unknown columns would discard exactly the data worth having.
//!
//! # On-disk format
//!
//! JSON Lines. Two record shapes:
//!
//! ```text
//! {"t":"2026-08-27T02:13:36Z","full":true,"regs":{"1024":6,...}}   every register
//! {"t":"2026-08-27T02:13:46Z","regs":{"1281":65353}}               only what changed
//! ```
//!
//! Full dumps were costing 3.7 kB per record — 32 MB/day at a 10s interval,
//! which is not acceptable for something that runs unattended. In practice 343
//! of the 384 registers never move, so deltas cut that by well over an order of
//! magnitude. A full snapshot is re-emitted periodically so a rotated or
//! truncated file is still self-describing from its own start.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Re-emit a complete snapshot this often, so a file that gets rotated or
/// truncated can still be read from its own beginning without the previous one.
const FULL_SNAPSHOT_EVERY: u64 = 360;

/// Rotate at this size, keeping one previous generation.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

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
    pub bytes: u64,
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

fn encode(stamp: &str, regs: &BTreeMap<u16, u16>, full: bool) -> String {
    let mut line = String::with_capacity(regs.len() * 12 + 48);
    line.push_str("{\"t\":\"");
    line.push_str(stamp);
    line.push('"');
    if full {
        line.push_str(",\"full\":true");
    }
    line.push_str(",\"regs\":{");
    for (i, (addr, value)) in regs.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&format!("\"{addr}\":{value}"));
    }
    line.push_str("}}\n");
    line
}

/// Keep one previous generation, so a rotation never silently discards the only
/// copy of a state change someone is mid-way through investigating.
fn rotate_if_large(path: &Path) -> std::io::Result<bool> {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(false),
    };
    if size < MAX_BYTES {
        return Ok(false);
    }
    let previous = path.with_extension("jsonl.1");
    let _ = std::fs::remove_file(&previous);
    std::fs::rename(path, &previous)?;
    Ok(true)
}

pub fn spawn(
    link: Arc<Mutex<Option<crate::modbus::Rtu>>>,
    logger: Arc<Logger>,
    path: PathBuf,
    interval: Duration,
) {
    std::thread::spawn(move || {
        let mut previous: BTreeMap<u16, u16> = BTreeMap::new();
        let mut since_full: u64 = 0;

        while logger.running.load(Ordering::Relaxed) {
            let started = Instant::now();

            let mut values: BTreeMap<u16, u16> = BTreeMap::new();
            let mut connected = false;

            // Take the lock per block, not for the whole sweep.
            //
            // With the 50ms inter-frame gap a full 13-block sweep is ~1.6s of
            // bus time. Holding the port lock for all of it starves every UI
            // command behind it, and if one read ever wedges, the lock is held
            // forever and the app cannot even shut down — which is exactly the
            // hang seen in v0.4.0.
            //
            // Interleaving is safe: the inter-frame gap is enforced inside the
            // shared Rtu against its own last-transaction time, so a UI read
            // slipping between two logger reads still respects it.
            for (addr, count) in ALL_BLOCKS {
                if !logger.running.load(Ordering::Relaxed) {
                    break;
                }
                let mut guard = match link.lock() {
                    Ok(g) => g,
                    Err(_) => break, // poisoned: another thread panicked
                };
                match guard.as_mut() {
                    Some(rtu) => {
                        connected = true;
                        if let Ok(regs) = rtu.read_holding(*addr, *count) {
                            for (i, v) in regs.iter().enumerate() {
                                values.insert(addr + i as u16, *v);
                            }
                        }
                    }
                    None => break, // disconnected mid-sweep
                }
                drop(guard);
            }

            if connected && !values.is_empty() {
                let rotated = rotate_if_large(&path).unwrap_or(false);
                if rotated {
                    previous.clear();
                    since_full = 0;
                }

                // Full snapshot on the first record, periodically thereafter,
                // and whenever the set of readable registers changes — a delta
                // against a different key set would be ambiguous to replay.
                let key_set_changed = previous.len() != values.len()
                    || previous.keys().ne(values.keys());
                let full = previous.is_empty() || since_full >= FULL_SNAPSHOT_EVERY
                    || key_set_changed;

                let payload: BTreeMap<u16, u16> = if full {
                    values.clone()
                } else {
                    values
                        .iter()
                        .filter(|(addr, v)| previous.get(addr) != Some(v))
                        .map(|(a, v)| (*a, *v))
                        .collect()
                };

                // A delta with nothing in it still gets written: the timestamp
                // is evidence that the device was answering and simply did not
                // change, which is different from a gap in the log.
                let line = encode(&utc_now(), &payload, full);

                let write = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .and_then(|mut f| f.write_all(line.as_bytes()));

                match write {
                    Ok(()) => {
                        logger.records.fetch_add(1, Ordering::Relaxed);
                        *logger.last_error.lock().unwrap() = None;
                        previous = values;
                        since_full = if full { 0 } else { since_full + 1 };
                    }
                    Err(e) => {
                        *logger.last_error.lock().unwrap() = Some(e.to_string());
                    }
                }
            }

            // Sleep in slices so stopping — or quitting the app — is noticed
            // promptly instead of after up to a full interval.
            let elapsed = started.elapsed();
            let mut remaining = interval.saturating_sub(elapsed);
            let slice = Duration::from_millis(200);
            while remaining > Duration::ZERO && logger.running.load(Ordering::Relaxed) {
                let step = remaining.min(slice);
                std::thread::sleep(step);
                remaining -= step;
            }
        }
    });
}

pub fn status(logger: &Logger) -> LoggingStatus {
    let path = logger.path.lock().unwrap().clone();
    let bytes = path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    LoggingStatus {
        running: logger.running.load(Ordering::Relaxed),
        path: path.map(|p| p.display().to_string()),
        records: logger.records.load(Ordering::Relaxed),
        bytes,
        last_error: logger.last_error.lock().unwrap().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_is_iso8601_utc() {
        let stamp = utc_now();
        assert_eq!(stamp.len(), 20, "got {stamp}");
        assert!(stamp.ends_with('Z'), "got {stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
    }

    #[test]
    fn full_records_are_marked_and_deltas_are_not() {
        let mut regs = BTreeMap::new();
        regs.insert(0x0500u16, 541u16);
        assert!(encode("T", &regs, true).contains("\"full\":true"));
        assert!(!encode("T", &regs, false).contains("full"));
    }

    #[test]
    fn encoding_uses_decimal_addresses() {
        let mut regs = BTreeMap::new();
        regs.insert(0x0500u16, 541u16);
        assert!(encode("T", &regs, false).contains("\"1280\":541"));
    }
}
