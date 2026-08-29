//! Read back the delta-encoded daily logs as time series for charting.
//!
//! The frontend asks for a handful of register addresses over a window (e.g.
//! the last 48 hours) and gets one series per address. Replay happens here in
//! Rust because the files are megabytes of JSONL and each daily file must be
//! reconstructed from its own full snapshot — shipping raw lines to the
//! webview to parse in JS would be slower and duplicate the replay logic.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Record {
    t: String,
    /// Absent on failure records — those carry no register data.
    regs: Option<BTreeMap<String, u16>>,
    #[serde(default)]
    full: bool,
}

#[derive(Serialize)]
pub struct HistorySeries {
    pub addr: u16,
    /// `[unix_seconds, raw_value]` pairs. Emitted on change and at least once
    /// a minute, so a flat line still gets points — the frontend breaks the
    /// line where the spacing exceeds the heartbeat, which marks real outages.
    pub points: Vec<(i64, u16)>,
}

#[derive(Serialize)]
pub struct HistoryResult {
    pub from: i64,
    pub to: i64,
    pub series: Vec<HistorySeries>,
}

/// Emit a point at least this often even when the value has not changed.
/// Gives the frontend a way to tell "flat" from "not logging".
const HEARTBEAT_SECS: i64 = 60;

/// Days-from-civil, Howard Hinnant's algorithm — the inverse of the
/// civil-from-days used to write the timestamps in `logging.rs`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `"2026-08-27T02:13:36Z"` -> unix seconds. Rejects anything else; a log
/// line that does not parse is skipped rather than aborting the whole replay.
fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| s[range].parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    Some(days_from_civil(y, m, d) * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// Daily log files that could contain records at or after `cutoff`, oldest
/// first. Selected by the date in the filename, so nothing opens files that
/// cannot matter.
fn files_in_window(dir: &Path, cutoff: i64) -> Vec<std::path::PathBuf> {
    let mut days: Vec<(String, std::path::PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy().into_owned();
            let day = match name
                .strip_prefix("ampinvt-registers-")
                .and_then(|n| n.strip_suffix(".jsonl"))
            {
                Some(d) if d.len() == 10 => d.to_string(),
                _ => continue,
            };
            let start = {
                let num = |range: std::ops::Range<usize>| day[range].parse::<i64>().ok();
                match (num(0..4), num(5..7), num(8..10)) {
                    (Some(y), Some(m), Some(d)) => days_from_civil(y, m, d) * 86_400,
                    _ => continue,
                }
            };
            if start + 86_400 >= cutoff {
                days.push((day, entry.path()));
            }
        }
    }
    days.sort();
    days.into_iter().map(|(_, p)| p).collect()
}

struct Track {
    value: Option<u16>,
    last_emit: Option<i64>,
    points: Vec<(i64, u16)>,
}

pub fn read(dir: &Path, addrs: &[u16], hours: f64) -> HistoryResult {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let cutoff = now - (hours.max(0.0) * 3600.0) as i64;

    let keys: Vec<String> = addrs.iter().map(|a| a.to_string()).collect();
    let mut tracks: BTreeMap<u16, Track> = addrs
        .iter()
        .map(|&a| {
            (
                a,
                Track {
                    value: None,
                    last_emit: None,
                    points: Vec::new(),
                },
            )
        })
        .collect();
    let mut last_stamp: Option<i64> = None;

    for path in files_in_window(dir, cutoff) {
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        // Each daily file opens with a full snapshot, so per-file state resets
        // are already handled by the data itself.
        for line in std::io::BufReader::new(file).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break, // torn tail of a live file
            };
            let record: Record = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let regs = match record.regs {
                Some(r) => r,
                None => continue, // failure record; the gap it leaves is the signal
            };
            let ts = match parse_ts(&record.t) {
                Some(t) => t,
                None => continue,
            };

            for (i, addr) in addrs.iter().enumerate() {
                let track = tracks.get_mut(addr).unwrap();
                match regs.get(&keys[i]) {
                    Some(&v) => track.value = Some(v),
                    // In a full snapshot, absence means the register was not
                    // read this sweep; in a delta it just means "unchanged".
                    None if record.full => track.value = None,
                    None => {}
                }

                if ts < cutoff {
                    continue;
                }
                if let Some(v) = track.value {
                    let due = match track.last_emit {
                        None => true,
                        Some(prev) => ts - prev >= HEARTBEAT_SECS,
                    };
                    let changed = track.points.last().map(|&(_, pv)| pv != v).unwrap_or(true);
                    if due || changed {
                        track.points.push((ts, v));
                        track.last_emit = Some(ts);
                    }
                }
            }
            if ts >= cutoff {
                last_stamp = Some(ts);
            }
        }
    }

    // Extend every series to the final record so the chart reaches "now"
    // instead of stopping at the last change.
    if let Some(end) = last_stamp {
        for track in tracks.values_mut() {
            if let (Some(v), Some(last)) = (track.value, track.last_emit) {
                if last < end {
                    track.points.push((end, v));
                }
            }
        }
    }

    HistoryResult {
        from: cutoff,
        to: now,
        series: tracks
            .into_iter()
            .map(|(addr, t)| HistorySeries {
                addr,
                points: t.points,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_utc() {
        // 2026-08-27T02:13:36Z, cross-checked with an external converter.
        assert_eq!(parse_ts("2026-08-27T02:13:36Z"), Some(1_787_796_816));
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("not a stamp"), None);
    }

    #[test]
    fn replays_deltas_and_heartbeats() {
        let dir = std::env::temp_dir().join(format!("ampinvt-history-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ampinvt-registers-2026-08-27.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"t\":\"2026-08-27T00:00:00Z\",\"full\":true,\"regs\":{\"1280\":541,\"1281\":100}}\n",
                "{\"t\":\"2026-08-27T00:00:10Z\",\"regs\":{\"1281\":101}}\n",
                "{\"t\":\"2026-08-27T00:02:00Z\",\"regs\":{}}\n",
                "{\"t\":\"2026-08-27T00:02:10Z\",\"ok\":false,\"failed\":13,\"blocks\":13,\"err\":\"x\"}\n",
            ),
        )
        .unwrap();

        let result = read(&dir, &[0x0500, 0x0501], 24.0 * 365.0 * 10.0);
        std::fs::remove_dir_all(&dir).unwrap();

        let battery = result.series.iter().find(|s| s.addr == 0x0500).unwrap();
        // Initial value, then the 2-minute record via heartbeat. Unchanged
        // throughout, so no extra points.
        assert_eq!(battery.points.iter().map(|p| p.1).collect::<Vec<_>>(), vec![541, 541]);

        let current = result.series.iter().find(|s| s.addr == 0x0501).unwrap();
        assert_eq!(current.points[0], (parse_ts("2026-08-27T00:00:00Z").unwrap(), 100));
        assert_eq!(current.points[1], (parse_ts("2026-08-27T00:00:10Z").unwrap(), 101));
    }
}
