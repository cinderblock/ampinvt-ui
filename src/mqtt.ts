import { mqttConfigure, mqttDisable, type MqttEntity } from './api';
import { REGISTERS, type RegisterDef } from './registers';

/**
 * Broker settings live in localStorage like the update prefs: they are this
 * machine's relationship to this broker, not device state.
 */
export interface MqttPrefs {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
}

const KEY = 'ampinvt-ui.mqtt-prefs';

export const DEFAULT_PREFS: MqttPrefs = {
  enabled: false,
  host: 'homeassistant.local',
  port: 1883,
  username: '',
  password: '',
};

export function loadMqttPrefs(): MqttPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<MqttPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveMqttPrefs(prefs: MqttPrefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

/**
 * Home Assistant classes, derived from the unit rather than annotated per
 * register — the unit already is the device knowledge.
 *
 * `total_increasing` on the energy counters is what makes them selectable in
 * HA's Energy dashboard; HA treats the device-midnight reset as a new cycle.
 */
function haClasses(def: RegisterDef): { deviceClass: string | null; stateClass: string | null } {
  if (def.kind === 'counter') {
    const deviceClass = def.unit === 'kWh' ? 'energy' : def.unit === 'h' ? 'duration' : null;
    return { deviceClass, stateClass: 'total_increasing' };
  }
  switch (def.unit) {
    case 'V':
      return { deviceClass: 'voltage', stateClass: 'measurement' };
    case 'A':
      return { deviceClass: 'current', stateClass: 'measurement' };
    case 'W':
      return { deviceClass: 'power', stateClass: 'measurement' };
    case '°C':
      return { deviceClass: 'temperature', stateClass: 'measurement' };
    case '%':
      return { deviceClass: 'battery', stateClass: 'measurement' };
    default:
      // Mode enum and the unit-unresolved load register: plain sensors.
      return { deviceClass: null, stateClass: null };
  }
}

/** Everything worth publishing: live telemetry plus the device's counters. */
export function buildEntities(): MqttEntity[] {
  return REGISTERS.filter((r) => r.kind === 'live' || r.kind === 'counter').map((def) => {
    const { deviceClass, stateClass } = haClasses(def);
    return {
      key: def.key,
      name: def.label,
      addr: def.addr,
      scale: def.scale,
      signed: def.signed ?? false,
      decimals: def.decimals,
      unit: def.unit ?? null,
      deviceClass,
      stateClass,
    };
  });
}

/** Push the current prefs to the backend: configure when enabled, tear down when not. */
export function applyMqtt(prefs: MqttPrefs) {
  if (!prefs.enabled || !prefs.host) return mqttDisable();
  return mqttConfigure({
    host: prefs.host,
    port: prefs.port,
    username: prefs.username || null,
    password: prefs.password || null,
    entities: buildEntities(),
  });
}
