mod logging;
mod modbus;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use logging::{Logger, LoggingStatus};
use modbus::Rtu;

/// What `connect` was called with, kept so the logger can reopen the port
/// itself after a sustained failure without a human present to press Connect.
#[derive(Clone)]
pub struct ConnParams {
    pub path: String,
    pub baud: u32,
    pub slave: u8,
}

/// Shared so the background logger thread can use the same port as the UI
/// poller. One process, one open handle, no contention over the COM port.
#[derive(Default)]
pub struct Link {
    pub rtu: Arc<Mutex<Option<Rtu>>>,
    pub params: Arc<Mutex<Option<ConnParams>>>,
}

#[derive(Serialize)]
struct PortInfo {
    path: String,
    label: String,
    /// True for VID 1A86 / PID 7523 — the CH340 the inverter presents.
    likely_inverter: bool,
}

#[derive(Serialize)]
struct BlockResult {
    addr: u16,
    /// Present when the read succeeded.
    values: Option<Vec<u16>>,
    /// Present when it failed. A Modbus exception 2 here just means the block
    /// does not exist, which is normal for this device's sparse address space.
    error: Option<String>,
}

#[derive(Deserialize)]
struct BlockSpec {
    addr: u16,
    count: u16,
}

#[derive(Serialize)]
struct WriteReport {
    addr: u16,
    previous: u16,
    written: u16,
    /// Value read back after the write. Authoritative — the UI shows this.
    readback: u16,
    ok: bool,
}

/// Run blocking serial work off the main thread.
///
/// Tauri executes non-async commands on the **main thread**, which is also the
/// UI event loop. Blocking serial I/O there makes the window stop responding to
/// drags and clicks — and with a 500ms timeout per block, a failing read stalls
/// the loop for seconds. Every command that touches the port must go through
/// here. Do not "simplify" one of these back into a sync `fn`.
async fn off_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("worker thread failed: {e}"))?
}

#[tauri::command]
async fn list_ports() -> Result<Vec<PortInfo>, String> {
    off_thread(list_ports_blocking).await
}

fn list_ports_blocking() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (label, likely_inverter) = match &p.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    let name = usb
                        .product
                        .clone()
                        .unwrap_or_else(|| format!("{:04x}:{:04x}", usb.vid, usb.pid));
                    (
                        format!("{} ({})", name, p.port_name),
                        usb.vid == 0x1a86 && usb.pid == 0x7523,
                    )
                }
                _ => (p.port_name.clone(), false),
            };
            PortInfo {
                path: p.port_name,
                label,
                likely_inverter,
            }
        })
        .collect())
}

#[tauri::command]
async fn connect(
    link: State<'_, Link>,
    path: String,
    baud: u32,
    slave: u8,
) -> Result<(), String> {
    let port = link.rtu.clone();
    let params = link.params.clone();
    off_thread(move || {
        let rtu = Rtu::open(&path, baud, slave)?;
        *port.lock().unwrap() = Some(rtu);
        // Remembered so the logger can reopen the port on its own after a
        // sustained failure, with nobody present to press Connect.
        *params.lock().unwrap() = Some(ConnParams { path, baud, slave });
        Ok(())
    })
    .await
}

#[tauri::command]
async fn disconnect(link: State<'_, Link>) -> Result<(), String> {
    let port = link.rtu.clone();
    off_thread(move || {
        *port.lock().unwrap() = None;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn is_connected(link: State<'_, Link>) -> Result<bool, String> {
    let port = link.rtu.clone();
    off_thread(move || Ok(port.lock().unwrap().is_some())).await
}

/// Read several blocks in one round trip from the UI's point of view.
/// A failed block does not abort the batch — its `error` is reported and the
/// rest still come back, because a sparse map means some blocks legitimately
/// do not exist.
#[tauri::command]
async fn read_blocks(
    link: State<'_, Link>,
    blocks: Vec<BlockSpec>,
) -> Result<Vec<BlockResult>, String> {
    let port = link.rtu.clone();
    off_thread(move || {
        let mut guard = port.lock().unwrap();
        let rtu = guard.as_mut().ok_or("not connected")?;

        Ok(blocks
            .into_iter()
            .map(|spec| match rtu.read_holding(spec.addr, spec.count) {
                Ok(values) => BlockResult {
                    addr: spec.addr,
                    values: Some(values),
                    error: None,
                },
                Err(err) => BlockResult {
                    addr: spec.addr,
                    values: None,
                    error: Some(err.to_string()),
                },
            })
            .collect())
    })
    .await
}

/// Guarded single-register write.
///
/// Refuses unless the register currently holds `expect`. That guard is the whole
/// safety model: much of this device's register map is inferred rather than
/// documented, and the guard turns "we mapped it wrong" from a destructive write
/// into a harmless error. Do not add a path that bypasses it.
#[tauri::command]
async fn write_register(
    link: State<'_, Link>,
    addr: u16,
    value: u16,
    expect: u16,
) -> Result<WriteReport, String> {
    let port = link.rtu.clone();
    off_thread(move || {
        let mut guard = port.lock().unwrap();
        let rtu = guard.as_mut().ok_or("not connected")?;

        let current = *rtu
            .read_holding(addr, 1)?
            .first()
            .ok_or("empty read before write")?;

        if current != expect {
            return Err(format!(
                "refusing to write: register {addr:#06x} holds {current}, expected {expect}. \
                 Re-read the device before retrying."
            ));
        }

        rtu.write_single(addr, value)?;
        std::thread::sleep(Duration::from_millis(200));

        let readback = *rtu
            .read_holding(addr, 1)?
            .first()
            .ok_or("empty read after write")?;

        Ok(WriteReport {
            addr,
            previous: current,
            written: value,
            readback,
            ok: readback == value,
        })
    })
    .await
}

/// Sweep the whole 16-bit space at a stride to discover which blocks exist.
/// This is how the map was found in the first place; kept so a different unit
/// or firmware can be re-surveyed without leaving the app.
#[tauri::command]
async fn discover_blocks(link: State<'_, Link>, stride: u16) -> Result<Vec<u16>, String> {
    let port = link.rtu.clone();
    off_thread(move || {
        let mut guard = port.lock().unwrap();
        let rtu = guard.as_mut().ok_or("not connected")?;

        let mut found = Vec::new();
        let mut addr: u32 = 0;
        while addr <= 0xFFFF {
            if rtu.read_holding(addr as u16, 1).is_ok() {
                found.push(addr as u16);
            }
            addr += stride.max(1) as u32;
        }
        Ok(found)
    })
    .await
}

#[tauri::command]
fn start_logging(
    app: tauri::AppHandle,
    link: State<Link>,
    logger: State<Arc<Logger>>,
    interval_secs: u64,
) -> Result<LoggingStatus, String> {
    if logger.running.load(Ordering::Relaxed) {
        return Ok(logging::status(&logger));
    }

    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    // One file per UTC day inside this directory; nothing is ever deleted.
    let dir = dir.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    *logger.path.lock().unwrap() = Some(dir.clone());
    logger.running.store(true, Ordering::Relaxed);

    logging::spawn(
        link.rtu.clone(),
        link.params.clone(),
        logger.inner().clone(),
        dir,
        Duration::from_secs(interval_secs.clamp(2, 3600)),
    );

    Ok(logging::status(&logger))
}

#[tauri::command]
fn stop_logging(logger: State<Arc<Logger>>) -> LoggingStatus {
    logger.running.store(false, Ordering::Relaxed);
    logging::status(&logger)
}

#[tauri::command]
fn logging_status(logger: State<Arc<Logger>>) -> LoggingStatus {
    logging::status(&logger)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Link::default())
        .manage(Arc::new(Logger::default()))
        // Stop the logger thread when the app is closing. Without this the
        // process can linger holding the serial port, which looks like a hang
        // and needs Task Manager to clear.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(logger) = window.try_state::<Arc<Logger>>() {
                    logger.running.store(false, Ordering::Relaxed);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            connect,
            disconnect,
            is_connected,
            read_blocks,
            write_register,
            discover_blocks,
            start_logging,
            stop_logging,
            logging_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
