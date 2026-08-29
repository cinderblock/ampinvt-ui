import { useEffect, useState } from 'react';

import { mqttStatus, type MqttStatus } from '../api';
import { applyMqtt, loadMqttPrefs, saveMqttPrefs, type MqttPrefs } from '../mqtt';

export default function MqttPanel() {
  const [prefs, setPrefs] = useState<MqttPrefs>(() => loadMqttPrefs());
  const [status, setStatus] = useState<MqttStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Edits not yet pushed to the backend. */
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const refresh = () => void mqttStatus().then(setStatus).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const edit = (patch: Partial<MqttPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const apply = async (next: MqttPrefs) => {
    setError(null);
    saveMqttPrefs(next);
    setPrefs(next);
    try {
      setStatus(await applyMqtt(next));
      setDirty(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const running = Boolean(status?.running);

  return (
    <section>
      <h2>Home Assistant (MQTT)</h2>
      <p className="desc">
        Publishes every decoded register to the local MQTT broker with Home Assistant
        discovery — an "AMPINVT Inverter" device appears in HA on its own, and{' '}
        <strong>PV energy today</strong> can be added to the Energy dashboard as solar
        production. Publishing rides on the register logger, so it only flows while
        logging is running.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`status ${status?.connected ? 'good' : 'idle'}`}>
          <span className="dot" aria-hidden="true" />
          {status?.connected ? 'Connected' : running ? 'Connecting…' : 'Off'}
        </span>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(e) => void apply({ ...prefs, enabled: e.target.checked })}
          />
          Publish to MQTT
        </label>
        {status && running && (
          <span className="subtitle">
            {status.published.toLocaleString()} updates sent
            {status.dropped > 0 && <> · {status.dropped.toLocaleString()} dropped</>}
          </span>
        )}
      </div>

      <div
        style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}
      >
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Broker
          <input
            type="text"
            value={prefs.host}
            placeholder="homeassistant.local"
            style={{ width: 180 }}
            onChange={(e) => edit({ host: e.target.value })}
          />
        </label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={prefs.port}
            style={{ width: 80 }}
            onChange={(e) => edit({ port: Number(e.target.value) || 1883 })}
          />
        </label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          User
          <input
            type="text"
            value={prefs.username}
            style={{ width: 120 }}
            onChange={(e) => edit({ username: e.target.value })}
          />
        </label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Password
          <input
            type="password"
            value={prefs.password}
            style={{ width: 120 }}
            onChange={(e) => edit({ password: e.target.value })}
          />
        </label>
        {dirty && (
          <button className="primary" onClick={() => void apply(prefs)}>
            Apply
          </button>
        )}
      </div>

      {(error || status?.last_error) && (
        <p className="err" style={{ marginTop: 10 }}>
          {error ?? status?.last_error}
        </p>
      )}
    </section>
  );
}
