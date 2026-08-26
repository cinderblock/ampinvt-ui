mod modbus;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use modbus::{ModbusError, Rtu};

#[derive(Default)]
struct Link(Mutex<Option<Rtu>>);

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

#[tauri::command]
fn list_ports() -> Result<Vec<PortInfo>, String> {
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
fn connect(link: State<Link>, path: String, baud: u32, slave: u8) -> Result<(), String> {
    let rtu = Rtu::open(&path, baud, slave)?;
    *link.0.lock().unwrap() = Some(rtu);
    Ok(())
}

#[tauri::command]
fn disconnect(link: State<Link>) {
    *link.0.lock().unwrap() = None;
}

#[tauri::command]
fn is_connected(link: State<Link>) -> bool {
    link.0.lock().unwrap().is_some()
}

/// Read several blocks in one round trip from the UI's point of view.
/// A failed block does not abort the batch — its `error` is reported and the
/// rest still come back, because a sparse map means some blocks legitimately
/// do not exist.
#[tauri::command]
fn read_blocks(link: State<Link>, blocks: Vec<BlockSpec>) -> Result<Vec<BlockResult>, String> {
    let mut guard = link.0.lock().unwrap();
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
}

/// Guarded single-register write.
///
/// Refuses unless the register currently holds `expect`. That guard is the whole
/// safety model: much of this device's register map is inferred rather than
/// documented, and the guard turns "we mapped it wrong" from a destructive write
/// into a harmless error. Do not add a path that bypasses it.
#[tauri::command]
fn write_register(
    link: State<Link>,
    addr: u16,
    value: u16,
    expect: u16,
) -> Result<WriteReport, String> {
    let mut guard = link.0.lock().unwrap();
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
    std::thread::sleep(std::time::Duration::from_millis(200));

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
}

/// Sweep the whole 16-bit space at a stride to discover which blocks exist.
/// This is how the map was found in the first place; kept so a different unit
/// or firmware can be re-surveyed without leaving the app.
#[tauri::command]
fn discover_blocks(link: State<Link>, stride: u16) -> Result<Vec<u16>, String> {
    let mut guard = link.0.lock().unwrap();
    let rtu = guard.as_mut().ok_or("not connected")?;

    let mut found = Vec::new();
    let mut addr: u32 = 0;
    while addr <= 0xFFFF {
        if let Ok(_) = rtu.read_holding(addr as u16, 1) {
            found.push(addr as u16);
        }
        addr += stride.max(1) as u32;
    }
    Ok(found)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Link::default())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            connect,
            disconnect,
            is_connected,
            read_blocks,
            write_register,
            discover_blocks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Silence an unused-import warning when the error type is only used via `?`.
#[allow(dead_code)]
fn _assert_error_conversion(e: ModbusError) -> String {
    e.into()
}
