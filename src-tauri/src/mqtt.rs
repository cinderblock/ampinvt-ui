//! Publish live register data to MQTT with Home Assistant discovery.
//!
//! Runs in Rust for the same reason the logger does: publishing must survive a
//! minimized or throttled webview. The frontend hands over an entity map built
//! from `registers.ts` once at configure time — names, scaling, units and HA
//! classes all come from there, because that file is the only device-specific
//! part of the app. This module applies the mechanical transform
//! `raw -> signed? -> *scale -> round` and nothing more.
//!
//! # Topics
//!
//! ```text
//! ampinvt/status                                  online/offline, retained (LWT)
//! ampinvt/state                                   one JSON object per sweep, retained
//! homeassistant/sensor/ampinvt_<key>/config       discovery, retained
//! ```
//!
//! Discovery configs are re-published on every ConnAck, so a broker that was
//! wiped (or Home Assistant restarted with a clean retained store) heals on
//! the next reconnect without anyone touching the app.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use rumqttc::{Client, Event, LastWill, MqttOptions, Packet, QoS};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MqttEntity {
    pub key: String,
    pub name: String,
    pub addr: u16,
    pub scale: f64,
    #[serde(default)]
    pub signed: bool,
    pub decimals: u32,
    pub unit: Option<String>,
    pub device_class: Option<String>,
    pub state_class: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub entities: Vec<MqttEntity>,
}

#[derive(Serialize)]
pub struct MqttStatus {
    pub running: bool,
    pub connected: bool,
    pub host: Option<String>,
    /// State messages actually handed to the client.
    pub published: u64,
    /// State messages dropped because the broker was unreachable and the
    /// outgoing buffer was full. Only the latest state matters, so dropping
    /// is correct — but it should be visible, not silent.
    pub dropped: u64,
    pub last_error: Option<String>,
}

struct Active {
    tx: mpsc::Sender<BTreeMap<u16, u16>>,
    client: Client,
    stop: Arc<AtomicBool>,
    host: String,
}

#[derive(Default)]
pub struct Mqtt {
    active: Mutex<Option<Active>>,
    connected: Arc<AtomicBool>,
    published: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
}

const STATUS_TOPIC: &str = "ampinvt/status";
const STATE_TOPIC: &str = "ampinvt/state";

fn discovery_topic(key: &str) -> String {
    format!("homeassistant/sensor/ampinvt_{key}/config")
}

fn discovery_payload(entity: &MqttEntity) -> String {
    let mut config = serde_json::json!({
        "name": entity.name,
        "unique_id": format!("ampinvt_{}", entity.key),
        "state_topic": STATE_TOPIC,
        "value_template": format!("{{{{ value_json.{} }}}}", entity.key),
        "availability_topic": STATUS_TOPIC,
        "device": {
            "identifiers": ["ampinvt_inverter"],
            "name": "AMPINVT Inverter",
            "manufacturer": "AMPINVT",
            "model": "TEL-48502M100",
        },
    });
    let obj = config.as_object_mut().unwrap();
    if let Some(unit) = &entity.unit {
        obj.insert("unit_of_measurement".into(), unit.as_str().into());
    }
    if let Some(class) = &entity.device_class {
        obj.insert("device_class".into(), class.as_str().into());
    }
    if let Some(class) = &entity.state_class {
        obj.insert("state_class".into(), class.as_str().into());
    }
    config.to_string()
}

fn decode(entity: &MqttEntity, raw: u16) -> f64 {
    let value = if entity.signed && raw > 32767 {
        raw as f64 - 65536.0
    } else {
        raw as f64
    };
    let scaled = value * entity.scale;
    let m = 10f64.powi(entity.decimals as i32);
    (scaled * m).round() / m
}

fn state_payload(entities: &[MqttEntity], values: &BTreeMap<u16, u16>) -> String {
    let mut state = serde_json::Map::new();
    for entity in entities {
        if let Some(&raw) = values.get(&entity.addr) {
            if let Some(n) = serde_json::Number::from_f64(decode(entity, raw)) {
                state.insert(entity.key.clone(), serde_json::Value::Number(n));
            }
        }
    }
    serde_json::Value::Object(state).to_string()
}

impl Mqtt {
    /// Hand a completed sweep to the publisher. Cheap no-op when disabled.
    /// Called by the logging thread, so it must never block.
    pub fn publish_sweep(&self, values: &BTreeMap<u16, u16>) {
        if let Ok(guard) = self.active.lock() {
            if let Some(active) = guard.as_ref() {
                let _ = active.tx.send(values.clone());
            }
        }
    }

    pub fn status(&self) -> MqttStatus {
        let guard = self.active.lock().unwrap();
        MqttStatus {
            running: guard.is_some(),
            connected: self.connected.load(Ordering::Relaxed),
            host: guard.as_ref().map(|a| a.host.clone()),
            published: self.published.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    pub fn disable(&self) {
        self.teardown(true);
    }

    fn teardown(&self, goodbye: bool) {
        let previous = self.active.lock().unwrap().take();
        if let Some(active) = previous {
            active.stop.store(true, Ordering::Relaxed);
            // From a throwaway thread: with the broker away the request
            // channel can be full, and blocking would hang whatever called
            // this — including window close. If the goodbye is lost, the
            // broker's last-will publishes "offline" anyway.
            let client = active.client;
            std::thread::spawn(move || {
                // No goodbye on reconfigure: the old session's retained
                // "offline" could land after the new session's "online" and
                // wedge HA at unavailable. A clean disconnect skips the will.
                if goodbye {
                    let _ = client.publish(STATUS_TOPIC, QoS::AtLeastOnce, true, "offline");
                }
                let _ = client.disconnect();
            });
        }
        self.connected.store(false, Ordering::Relaxed);
    }

    pub fn configure(&self, config: MqttConfig) {
        self.teardown(false);

        // Unique per session: reusing one id would make the broker treat a
        // reconfigure as a takeover and fire the OLD session's last will,
        // racing a retained "offline" against the new session's "online".
        let session = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut options = MqttOptions::new(
            format!("ampinvt-ui-{session}"),
            config.host.clone(),
            config.port,
        );
        options.set_keep_alive(Duration::from_secs(30));
        // The will makes an unclean death visible in HA: sensors go
        // unavailable instead of freezing at their last values.
        options.set_last_will(LastWill::new(STATUS_TOPIC, "offline", QoS::AtLeastOnce, true));
        if let (Some(user), Some(pass)) = (&config.username, &config.password) {
            if !user.is_empty() {
                options.set_credentials(user.clone(), pass.clone());
            }
        }

        // Sized for a discovery burst (~30 retained configs) plus state
        // traffic, so nothing has to block on the request channel.
        let (client, mut connection) = Client::new(options, 64);
        let (tx, rx) = mpsc::channel::<BTreeMap<u16, u16>>();
        let stop = Arc::new(AtomicBool::new(false));

        *self.active.lock().unwrap() = Some(Active {
            tx,
            client: client.clone(),
            stop: stop.clone(),
            host: config.host.clone(),
        });
        self.published.store(0, Ordering::Relaxed);
        self.dropped.store(0, Ordering::Relaxed);
        *self.last_error.lock().unwrap() = None;

        // Network pump. Owns the connection; everything else just queues
        // requests through cloned clients.
        {
            let stop = stop.clone();
            let connected = self.connected.clone();
            let last_error = self.last_error.clone();
            let client = client.clone();
            let entities = config.entities.clone();
            std::thread::spawn(move || {
                for event in connection.iter() {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match event {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            connected.store(true, Ordering::Relaxed);
                            *last_error.lock().unwrap() = None;
                            // Publish from a separate thread: the pump must
                            // keep consuming the request channel or a burst
                            // larger than its capacity would deadlock.
                            let client = client.clone();
                            let entities = entities.clone();
                            std::thread::spawn(move || {
                                let _ = client.publish(
                                    STATUS_TOPIC,
                                    QoS::AtLeastOnce,
                                    true,
                                    "online",
                                );
                                for entity in &entities {
                                    let _ = client.publish(
                                        discovery_topic(&entity.key),
                                        QoS::AtLeastOnce,
                                        true,
                                        discovery_payload(entity),
                                    );
                                }
                            });
                        }
                        Ok(_) => {}
                        Err(e) => {
                            connected.store(false, Ordering::Relaxed);
                            *last_error.lock().unwrap() = Some(e.to_string());
                            // The eventloop retries on the next iteration;
                            // don't spin while the broker is unreachable.
                            std::thread::sleep(Duration::from_secs(3));
                        }
                    }
                }
                connected.store(false, Ordering::Relaxed);
            });
        }

        // State publisher. Exits when the sender is dropped by disable() or
        // a reconfigure.
        {
            let entities = config.entities;
            let published = self.published.clone();
            let dropped = self.dropped.clone();
            std::thread::spawn(move || {
                while let Ok(values) = rx.recv() {
                    let payload = state_payload(&entities, &values);
                    // try_publish: when the broker is away and the buffer is
                    // full, drop the update — only the latest state matters,
                    // and blocking here would back the channel up forever.
                    match client.try_publish(STATE_TOPIC, QoS::AtMostOnce, true, payload) {
                        Ok(()) => {
                            published.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => {
                            dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(key: &str, addr: u16, scale: f64, signed: bool, decimals: u32) -> MqttEntity {
        MqttEntity {
            key: key.into(),
            name: key.into(),
            addr,
            scale,
            signed,
            decimals,
            unit: None,
            device_class: None,
            state_class: None,
        }
    }

    #[test]
    fn decodes_signed_and_scaled() {
        // 0xFF39 = -199 raw = -19.9 A: the battery-current encoding.
        assert_eq!(decode(&entity("i", 0x0501, 0.1, true, 1), 65337), -19.9);
        assert_eq!(decode(&entity("v", 0x0500, 0.1, false, 1), 541), 54.1);
        assert_eq!(decode(&entity("e", 0x070d, 0.1, false, 1), 23), 2.3);
    }

    #[test]
    fn state_payload_only_includes_present_registers() {
        let entities = vec![
            entity("batteryVoltage", 0x0500, 0.1, false, 1),
            entity("missing", 0x0999, 1.0, false, 0),
        ];
        let mut values = BTreeMap::new();
        values.insert(0x0500u16, 541u16);
        let payload = state_payload(&entities, &values);
        assert_eq!(payload, r#"{"batteryVoltage":54.1}"#);
    }

    #[test]
    fn discovery_payload_names_the_device() {
        let payload = discovery_payload(&entity("batteryVoltage", 0x0500, 0.1, false, 1));
        assert!(payload.contains(r#""unique_id":"ampinvt_batteryVoltage""#));
        assert!(payload.contains(r#""value_template":"{{ value_json.batteryVoltage }}""#));
        assert!(payload.contains(r#""identifiers":["ampinvt_inverter"]"#));
    }
}
