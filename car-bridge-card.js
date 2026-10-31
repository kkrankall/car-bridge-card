/*
 * Car Bridge card: a Home Assistant dashboard card for a car that the Car Bridge app sends to Home
 * Assistant. Point it at any of the car's entities (its battery level, say) and it finds the rest on
 * the same device: battery and range, charging, the last 7 or 30 days from history, the last charge
 * and trip, tires and where the car is.
 *
 *   type: custom:car-bridge-card
 *   entity: sensor.my_car_battery_level
 *   name: My car               # optional, defaults to the device's name
 *   show_stats: true           # optional, these five default to true
 *   show_charge: true
 *   show_trip: true
 *   show_tires: true
 *   show_chips: true
 *   stats_period: week         # or month (30 days)
 *   price: 0.158               # optional, per kWh from the wall, or:
 *   price_entity: sensor.electricity_price
 *   charge_efficiency: 0.9     # optional: share of the wall's energy that reaches the battery
 */
const VERSION = "1.1.0";

// Car Bridge's sensor keys by domain: entity IDs are <device>_<key> unless renamed.
const KEYS = {
  sensor: [
    "battery_level", "battery_energy", "battery_power", "range", "odometer", "speed", "gear", "ignition",
    "charge_state", "charge_time_remaining", "charge_limit", "charge_current_limit", "outside_temperature",
    "battery_temperature", "tire_pressure_front_left", "tire_pressure_front_right", "tire_pressure_rear_left",
    "tire_pressure_rear_right", "fuel_level", "fuel_remaining", "energy_charged", "charge_session",
    "last_trip_distance", "last_trip_efficiency", "battery_capacity", "usable_battery_capacity", "last_update",
    "parked_loss",
  ],
  binary_sensor: ["charging", "plugged_in", "charge_port", "fuel_low", "fuel_door", "driving", "parking_brake"],
};
const ALL_KEYS = [...KEYS.sensor, ...KEYS.binary_sensor];
// Car Bridge sends Last update at least every 5 minutes while the car is awake.
const ASLEEP_AFTER_MS = 20 * 60_000;
// Home Assistant's number format settings, as locales.
const NUMBER_LOCALES = { comma_decimal: "en-US", decimal_comma: "de", space_comma: "fr" };
// History for the summary: the 30 days shown and the 30 before, to compare. Fetched again after a new
// trip or charge, and at most every 10 minutes otherwise.
const HISTORY_DAYS = 61;
const HISTORY_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const DEFAULTS = {
  show_stats: true, show_charge: true, show_trip: true, show_tires: true, show_chips: true,
  stats_period: "week",
  // A home (level 2) charger delivers about 90% of what the meter bills to the battery.
  charge_efficiency: 0.9,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (values) => values.reduce((total, v) => total + (v ?? 0), 0);
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** History rows come compressed ({s, a, lu}) from the WebSocket API; this reads either form. */
const row = (r) => ({ state: r.s ?? r.state, attributes: r.a ?? r.attributes ?? {}, at: r.lu != null ? r.lu * 1000 : Date.parse(r.last_updated) });

/** Every trip in the Last trip distance sensor's history, once each (keyed by its start). */
function parseTrips(rows) {
  const trips = new Map();
  for (const r of rows.map(row)) {
    const a = r.attributes;
    const distance = num(r.state);
    if (!a.started || distance == null) continue;
    trips.set(a.started, {
      end: Date.parse(a.ended ?? "") || r.at, distance, energy: num(a.energy_used_kwh), minutes: num(a.duration_min),
    });
  }
  return [...trips.values()];
}

/** Every charging session in the Charge session sensor's history, at its final value. */
function parseCharges(rows) {
  const charges = new Map();
  for (const r of rows.map(row)) {
    const a = r.attributes;
    const kwh = num(r.state);
    if (!a.started || kwh == null) continue;
    charges.set(a.started, { end: Date.parse(a.ended ?? "") || r.at, kwh });
  }
  return [...charges.values()].filter((c) => c.kwh >= 0.05);
}

/** The Car Bridge key an entity ID ends with, longest first (usable_battery_capacity before battery_capacity). */
function keyOf(objectId) {
  return ALL_KEYS.filter((k) => objectId === k || objectId.endsWith("_" + k)).sort((a, b) => b.length - a.length)[0];
}

/** Finds the car's entities from one of them: the same device in the entity registry, else the same prefix. */
function findEntities(hass, entityId) {
  const registry = hass.entities ?? {};
  const deviceId = registry[entityId]?.device_id;
  const siblings = deviceId
    ? Object.values(registry).filter((e) => e.device_id === deviceId).map((e) => e.entity_id)
    : [];
  const objectId = entityId.split(".")[1] ?? "";
  const own = keyOf(objectId);
  const prefix = own ? objectId.slice(0, objectId.length - own.length).replace(/_$/, "") : objectId;
  const ids = {};
  for (const [domain, keys] of Object.entries(KEYS)) {
    for (const key of keys) {
      const exact = `${domain}.${prefix ? prefix + "_" : ""}${key}`;
      if (hass.states[exact] && (!siblings.length || siblings.includes(exact))) {
        ids[key] = exact;
        continue;
      }
      // Renamed entities: the shortest same-device ID ending in the key.
      const renamed = siblings
        .filter((id) => id.startsWith(domain + ".") && keyOf(id.split(".")[1]) === key)
        .sort((a, b) => a.length - b.length)[0];
      if (renamed) ids[key] = renamed;
    }
  }
  ids.tracker =
    siblings.find((id) => id.startsWith("device_tracker.")) ??
    (hass.states[`device_tracker.${prefix}`] ? `device_tracker.${prefix}` : undefined);
  return { ids, device: deviceId ? hass.devices?.[deviceId] : undefined };
}

const STYLES = `
  :host { display: block; }
  ha-card {
    --cb-surface: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    --cb-track: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    padding: 16px;
    overflow: hidden;
    container-type: inline-size;
    background: linear-gradient(160deg,
      color-mix(in srgb, var(--cb-accent) 9%, var(--ha-card-background, var(--card-background-color, #fff))) 0%,
      var(--ha-card-background, var(--card-background-color, #fff)) 55%);
  }
  .warning { padding: 8px; color: var(--error-color, #db4437); }
  .header { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .avatar {
    flex: none; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
    background: color-mix(in srgb, var(--cb-accent) 16%, transparent); color: var(--cb-accent);
  }
  .avatar ha-icon { --mdc-icon-size: 24px; }
  .heading { min-width: 0; flex: 1; }
  .title {
    font-size: 16px; font-weight: 600; line-height: 1.3; color: var(--primary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .subtitle {
    font-size: 13px; line-height: 1.4; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pill {
    flex: none; display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px 0 8px;
    border-radius: 13px; font-size: 12px; font-weight: 600; white-space: nowrap;
    background: color-mix(in srgb, var(--cb-accent) 15%, transparent); color: var(--cb-accent);
  }
  .pill ha-icon { --mdc-icon-size: 16px; }
  .hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin: 20px 0 12px; }
  .hero > div { min-width: 0; }
  .big {
    font-size: 42px; font-weight: 600; line-height: 1; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums; color: var(--primary-text-color); white-space: nowrap;
  }
  .big .unit { font-size: 18px; font-weight: 500; letter-spacing: 0; color: var(--secondary-text-color); margin-left: 3px; }
  .sub { font-size: 13px; color: var(--secondary-text-color); margin-top: 6px; white-space: nowrap; }
  .range { text-align: right; }
  .bar { position: relative; height: 12px; border-radius: 6px; background: var(--cb-track); }
  .bar.thin { height: 6px; border-radius: 3px; margin-top: 10px; }
  .fill {
    position: absolute; inset: 0 auto 0 0; width: var(--level); max-width: 100%; border-radius: inherit;
    background: var(--cb-bar); transition: width 0.6s ease; overflow: hidden;
  }
  .fill.charging::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent) no-repeat;
    background-size: 40% 100%; animation: sheen 2.4s ease-in-out infinite;
  }
  @keyframes sheen { from { background-position: -60% 0; } to { background-position: 160% 0; } }
  .mark {
    position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px;
    background: var(--primary-text-color); opacity: 0.5;
  }
  .mark.start { opacity: 0.25; }
  .legend { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--secondary-text-color); }
  .legend span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tiles { display: grid; grid-template-columns: repeat(var(--count, 4), minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
  .tile { min-width: 0; padding: 10px 12px; border-radius: 12px; background: var(--cb-surface); }
  .tile ha-icon { --mdc-icon-size: 18px; color: var(--tile-color, var(--secondary-text-color)); }
  .value {
    font-size: 15px; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tile .value { margin-top: 6px; }
  .label { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--divider-color); }
  .section-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 10px;
    font-size: 13px; font-weight: 600; color: var(--primary-text-color);
  }
  .section-head span { font-size: 12px; font-weight: 400; color: var(--secondary-text-color); white-space: nowrap; }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .tires { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6px 12px; align-items: center; }
  .tires .car { grid-row: 1 / 3; grid-column: 2; color: var(--secondary-text-color); --mdc-icon-size: 40px; opacity: 0.6; }
  .tires .right { text-align: right; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border-radius: 14px;
    font-size: 12px; font-weight: 500; color: var(--primary-text-color); background: var(--cb-surface); white-space: nowrap;
  }
  .chip ha-icon { --mdc-icon-size: 16px; color: var(--chip-color, var(--secondary-text-color)); }
  .detail { font-size: 12px; color: var(--secondary-text-color); margin-top: 8px; }
  .period { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--cb-surface); }
  .period button {
    all: unset; cursor: pointer; padding: 3px 9px; border-radius: 7px;
    font-size: 11px; font-weight: 600; color: var(--secondary-text-color);
  }
  .period button[aria-pressed="true"] {
    background: var(--ha-card-background, var(--card-background-color, #fff)); color: var(--primary-text-color);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  }
  .period button:focus-visible { outline: 2px solid var(--primary-color); }
  .delta { font-size: 11px; font-weight: 600; margin-left: 4px; color: var(--secondary-text-color); }
  .delta.good { color: var(--success-color, #43a047); }
  .delta.bad { color: var(--warning-color, #ffa600); }
  .bars { display: flex; align-items: flex-end; gap: 6px; height: 66px; margin-top: 14px; }
  .bars.month { gap: 2px; height: 54px; }
  .bars .col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
  .bars .b { width: 100%; max-width: 30px; min-height: 3px; border-radius: 4px 4px 2px 2px; background: color-mix(in srgb, var(--primary-color) 55%, transparent); }
  .bars .b.none { background: var(--cb-track); }
  .bars .b.today { background: var(--primary-color); }
  .bars .col span { font-size: 10px; line-height: 1; color: var(--secondary-text-color); }
  [data-entity] { cursor: pointer; }
  [data-entity]:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 8px; }
  .tile[data-entity]:hover, .chip[data-entity]:hover { background: color-mix(in srgb, var(--primary-text-color) 9%, transparent); }
  @container (max-width: 430px) {
    .tiles, .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tile:last-child:nth-child(odd) { grid-column: 1 / -1; }
    .big { font-size: 36px; }
    .pill-detail { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill { transition: none; }
    .fill.charging::after { animation: none; }
  }
`;

class CarBridgeCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("car-bridge-card-editor");
  }

  /** Picks the battery (or fuel) level of the first Car Bridge car: a mobile_app device with a gear or charge state. */
  static getStubConfig(hass) {
    const registry = Object.values(hass.entities ?? {});
    const car = registry.find(
      (e) => e.platform === "mobile_app" && e.device_id && /_(gear|charge_state)$/.test(e.entity_id),
    );
    const level = car && registry.find(
      (e) => e.device_id === car.device_id && /^sensor\..+_(battery|fuel)_level$/.test(e.entity_id),
    );
    return { entity: level?.entity_id ?? car?.entity_id ?? "" };
  }

  setConfig(config) {
    if (!config?.entity) throw new Error("Choose one of the car's entities, such as its battery level");
    this._config = { ...DEFAULTS, ...config };
    this._period = this._config.stats_period === "month" ? "month" : "week";
    this._found = null;
    this._history = null;
    this._signature = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    // Keeps "updated 3 min ago" and the charge finish time current between state changes.
    this._timer = setInterval(() => {
      this._signature = null;
      this._render();
    }, 60_000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  // Entity helpers

  _state(key) {
    const id = this._ids?.[key];
    return id ? this._hass.states[id] : undefined;
  }

  _num(key) {
    const s = this._state(key);
    if (!s || s.state === "" || s.state === "unknown" || s.state === "unavailable") return null;
    const n = Number(s.state);
    return Number.isFinite(n) ? n : null;
  }

  _on(key) {
    return this._state(key)?.state === "on";
  }

  _unit(key) {
    return this._state(key)?.attributes.unit_of_measurement ?? "";
  }

  /** The state as Home Assistant shows it (units, translations); null when there's nothing to show. */
  _display(key) {
    const s = this._state(key);
    if (!s || s.state === "unknown" || s.state === "unavailable") return null;
    if (this._hass.formatEntityState) return this._hass.formatEntityState(s);
    const unit = s.attributes.unit_of_measurement;
    return unit ? `${s.state} ${unit}` : s.state;
  }

  // Formatting, following the user's number and time settings

  get _lang() {
    return this._hass.locale?.language ?? this._hass.language ?? "en";
  }

  _fmt(n, digits = 0) {
    const format = this._hass.locale?.number_format;
    const locale = format === "system" ? undefined : NUMBER_LOCALES[format] ?? this._lang;
    return new Intl.NumberFormat(locale, { maximumFractionDigits: digits, useGrouping: format !== "none" }).format(n);
  }

  _time(date) {
    const format = this._hass.locale?.time_format;
    const hour12 = format === "12" ? true : format === "24" ? false : undefined;
    return date.toLocaleTimeString(this._lang, { hour: "numeric", minute: "2-digit", hour12 });
  }

  _day(date) {
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString(this._lang, { weekday: "long" });
    return date.toLocaleDateString(this._lang, { month: "short", day: "numeric" });
  }

  _ago(ms) {
    const seconds = (Date.now() - ms) / 1000;
    if (seconds < 60) return "just now";
    const rtf = new Intl.RelativeTimeFormat(this._lang, { numeric: "auto" });
    if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
    if (seconds < 86_400) return rtf.format(-Math.round(seconds / 3600), "hour");
    return rtf.format(-Math.round(seconds / 86_400), "day");
  }

  _duration(minutes) {
    const m = Math.round(minutes);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }

  _energy(kwh) {
    return `${this._fmt(kwh, Math.abs(kwh) < 10 ? 2 : 1)} kWh`;
  }

  _money(amount) {
    return new Intl.NumberFormat(this._lang, { style: "currency", currency: this._hass.config?.currency || "USD" }).format(amount);
  }

  /** What energy put into the battery cost at the wall: the charger loses some (10% by default). */
  _cost(kwh) {
    const id = this._config.price_entity;
    const price = num(id ? this._hass.states[id]?.state : this._config.price);
    if (price == null || price <= 0 || kwh == null) return null;
    return (kwh / (num(this._config.charge_efficiency) || DEFAULTS.charge_efficiency)) * price;
  }

  // State of the car

  _status() {
    const lastUpdate = Date.parse(this._state("last_update")?.state ?? "");
    const asleep = Number.isFinite(lastUpdate) && Date.now() - lastUpdate > ASLEEP_AFTER_MS;
    const chargeState = this._state("charge_state")?.state;
    const limit = this._num("charge_limit");
    const remaining = this._num("charge_time_remaining");
    // Nothing new for a while: the head unit slept, so the last charge or drive state is stale.
    if (asleep) {
      const wasCharging = chargeState === "Charging" || this._on("charging");
      return {
        label: "Asleep", icon: "mdi:sleep", accent: "var(--secondary-text-color)", plugged: this._on("plugged_in"),
        detail: wasCharging ? "was charging" : null,
      };
    }
    if (this._on("driving")) {
      const speed = this._num("speed");
      return {
        label: "Driving", icon: "mdi:car-arrow-right", accent: "var(--info-color, #039be5)",
        detail: speed != null ? `${this._fmt(speed)} ${this._unit("speed")}` : null, driving: true,
      };
    }
    if (chargeState === "Charging" || this._on("charging")) {
      return {
        label: "Charging", icon: "mdi:lightning-bolt", accent: "var(--success-color, #43a047)", charging: true,
        detail: remaining > 0 ? `${this._duration(remaining)}${limit ? ` to ${this._fmt(limit)}%` : ""}` : null,
      };
    }
    if (chargeState === "Error") {
      return { label: "Charge error", icon: "mdi:alert-circle", accent: "var(--error-color, #db4437)", plugged: true };
    }
    if (chargeState === "Fully charged") {
      return {
        label: "Charged", icon: "mdi:battery-check", accent: "var(--success-color, #43a047)", plugged: true,
        detail: limit ? `to ${this._fmt(limit)}%` : null,
      };
    }
    if (this._on("plugged_in")) {
      return { label: "Plugged in", icon: "mdi:ev-plug-type1", accent: "var(--primary-color)", plugged: true, detail: "Not charging" };
    }
    return { label: "Parked", icon: "mdi:parking", accent: "var(--primary-color)" };
  }

  _location() {
    const tracker = this._ids?.tracker && this._hass.states[this._ids.tracker];
    if (!tracker || tracker.state === "unknown" || tracker.state === "unavailable") return null;
    return this._hass.formatEntityState ? this._hass.formatEntityState(tracker) : tracker.state;
  }

  // Rendering

  _render() {
    if (!this._config || !this._hass) return;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (e) => {
        const period = e.composedPath().find((n) => n.dataset?.period);
        if (!period) return this._open(e);
        this._period = period.dataset.period;
        this._signature = null;
        this._render();
      });
      this.shadowRoot.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this._open(e);
      });
    }
    if (!this._found || this._found.registry !== this._hass.entities) {
      this._found = { registry: this._hass.entities, ...findEntities(this._hass, this._config.entity) };
      this._ids = this._found.ids;
    }
    this._fetchHistory();
    // Re-render only when one of the car's entities, the price, the history or the config changed.
    const watched = [...Object.values(this._ids), this._config.price_entity].map((id) => this._hass.states[id]?.last_updated);
    const signature = JSON.stringify([
      watched, this._config, this._period, this._history?.at, this._hass.themes?.darkMode, this._hass.locale,
    ]);
    if (signature === this._signature) return;
    this._signature = signature;

    if (!this._hass.states[this._config.entity]) {
      this.shadowRoot.innerHTML = `<style>${STYLES}</style><ha-card><div class="warning">Entity not found: ${esc(this._config.entity)}</div></ha-card>`;
      return;
    }
    const status = this._status();
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card style="--cb-accent: ${status.accent}">
        ${this._header(status)}
        ${this._hero(status)}
        ${this._tiles(status)}
        ${this._config.show_stats ? this._summary() : ""}
        ${this._config.show_charge ? this._lastCharge(status) : ""}
        ${this._config.show_trip ? this._trip() : ""}
        ${this._config.show_tires ? this._tires() : ""}
        ${this._config.show_chips ? this._chips(status) : ""}
      </ha-card>`;
  }

  /** Loads the trips and charges of the last [HISTORY_DAYS] for the summary, when they may have changed. */
  _fetchHistory() {
    if (!this._config.show_stats || !this._hass.callWS || this._fetching) return;
    const ids = [this._ids.last_trip_distance, this._ids.charge_session].filter(Boolean);
    if (!ids.length) return;
    const key = ids.map((id) => this._hass.states[id]?.last_changed).join("|");
    if (this._history && this._history.key === key && Date.now() - this._history.at < HISTORY_TTL_MS) return;
    this._fetching = true;
    const end = Date.now();
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(end - HISTORY_DAYS * DAY_MS).toISOString(),
      end_time: new Date(end).toISOString(),
      entity_ids: ids,
      minimal_response: false,
      no_attributes: false,
      significant_changes_only: false,
    }).then(
      (result) => {
        this._history = {
          at: Date.now(), key,
          trips: parseTrips(result[this._ids.last_trip_distance] ?? []),
          charges: parseCharges(result[this._ids.charge_session] ?? []),
        };
      },
      // No history (recorder off, say): the summary stays hidden until the next try.
      () => {
        this._history = { at: Date.now(), key, trips: [], charges: [] };
      },
    ).finally(() => {
      this._fetching = false;
      this._signature = null;
      this._render();
    });
  }

  _open(e) {
    const target = e.composedPath().find((n) => n.dataset?.entity);
    if (!target) return;
    e.preventDefault();
    const event = new Event("hass-more-info", { bubbles: true, composed: true });
    event.detail = { entityId: target.dataset.entity };
    this.dispatchEvent(event);
  }

  _attrs(key) {
    const id = this._ids[key];
    return id ? `data-entity="${esc(id)}" tabindex="0" role="button"` : "";
  }

  _header(status) {
    const device = this._found.device;
    const name = this._config.name || device?.name_by_user || device?.name || "Car";
    const lastUpdate = Date.parse(this._state("last_update")?.state ?? "");
    const parts = [];
    if (!status.driving) parts.push(this._location());
    if (Number.isFinite(lastUpdate)) parts.push(`${status.label === "Asleep" ? "Last seen" : "Updated"} ${this._ago(lastUpdate)}`);
    const subtitle = parts.filter(Boolean).join(" · ");
    // Narrow cards drop the detail; the tiles below repeat it.
    const pill = `${esc(status.label)}${status.detail ? `<span class="pill-detail"> · ${esc(status.detail)}</span>` : ""}`;
    return `
      <div class="header" ${this._ids.tracker ? `data-entity="${esc(this._ids.tracker)}" tabindex="0" role="button"` : ""}>
        <div class="avatar"><ha-icon icon="${this._hasBattery() ? "mdi:car-electric" : "mdi:car"}"></ha-icon></div>
        <div class="heading">
          <div class="title">${esc(name)}</div>
          ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ""}
        </div>
        <div class="pill"><ha-icon icon="${status.icon}"></ha-icon>${pill}</div>
      </div>`;
  }

  _hasBattery() {
    return Boolean(this._ids.battery_level);
  }

  _barColor(level, status) {
    if (status.charging || status.label === "Charged") return "var(--success-color, #43a047)";
    if (level <= 10) return "var(--error-color, #db4437)";
    if (level <= 20) return "var(--warning-color, #ffa600)";
    return "var(--primary-color)";
  }

  _hero(status) {
    const electric = this._hasBattery();
    const levelKey = electric ? "battery_level" : "fuel_level";
    const level = this._num(levelKey);
    const range = this._num("range");
    const energy = electric ? this._num("battery_energy") : this._num("fuel_remaining");
    const levelText = level == null ? "—" : this._fmt(level, Number.isInteger(level) ? 0 : 1);
    const contents = energy != null
      ? `${electric ? this._energy(energy) : `${this._fmt(energy, 1)} ${this._unit("fuel_remaining")}`} ${electric ? "in battery" : "in tank"}`
      : electric ? "Battery" : "Fuel";
    const limit = electric ? this._num("charge_limit") : null;
    const session = this._state("charge_session");
    const start = status.charging ? session?.attributes.start_level : null;
    const started = Date.parse(session?.attributes.started ?? "");

    const legendLeft = status.charging && start != null
      ? `From ${this._fmt(start)}%${Number.isFinite(started) ? ` at ${this._time(new Date(started))}` : ""}`
      : status.charging && this._num("charge_time_remaining") > 0
        ? `Done about ${this._time(new Date(Date.now() + this._num("charge_time_remaining") * 60_000))}`
        : "";
    const legendRight = limit != null && limit < 100 ? `Limit ${this._fmt(limit)}%` : "";
    // A hybrid also shows its fuel under the battery.
    const fuel = electric ? this._num("fuel_level") : null;

    return `
      <div class="hero">
        <div ${this._attrs(levelKey)}>
          <div class="big">${levelText}<span class="unit">%</span></div>
          <div class="sub">${esc(contents)}</div>
        </div>
        ${range != null ? `
          <div class="range" ${this._attrs("range")}>
            <div class="big">${this._fmt(range)}<span class="unit">${esc(this._unit("range"))}</span></div>
            <div class="sub">Range</div>
          </div>` : ""}
      </div>
      <div class="bar" style="--level: ${Math.max(0, Math.min(100, level ?? 0))}%; --cb-bar: ${this._barColor(level ?? 0, status)}">
        <div class="fill${status.charging ? " charging" : ""}"></div>
        ${start != null ? `<div class="mark start" style="left: ${start}%"></div>` : ""}
        ${limit != null && limit < 100 ? `<div class="mark" style="left: ${limit}%"></div>` : ""}
      </div>
      ${fuel != null ? `
        <div class="bar thin" style="--level: ${fuel}%; --cb-bar: var(--warning-color, #ffa600)"><div class="fill"></div></div>` : ""}
      ${legendLeft || legendRight || fuel != null ? `
        <div class="legend">
          <span>${esc(fuel != null ? `Fuel ${this._fmt(fuel)}%` : legendLeft)}</span>
          <span>${esc(legendRight)}</span>
        </div>` : ""}`;
  }

  _tiles(status) {
    const tiles = [];
    const add = (key, icon, label, value, color) => {
      if (value == null || tiles.length >= 4 || tiles.some((t) => t.key === key)) return;
      tiles.push({ key, icon, label, value, color });
    };
    const power = this._num("battery_power");
    const remaining = this._num("charge_time_remaining");
    const session = this._num("charge_session");
    if (status.charging || status.plugged) {
      add("charge_session", "mdi:battery-plus", status.charging ? "Added so far" : "Last charge",
        session > 0.005 ? `+${this._energy(session)}` : null, "var(--success-color, #43a047)");
      if (status.charging && remaining > 0) {
        add("charge_time_remaining", "mdi:timer-outline",
          `Done ${this._time(new Date(Date.now() + remaining * 60_000))}`, this._duration(remaining));
      }
      if (power != null && power > 0.05) add("battery_power", "mdi:flash", "Charging power", `${this._fmt(power, 1)} kW`, "var(--success-color, #43a047)");
      add("charge_current_limit", "mdi:current-ac", "Current limit", this._display("charge_current_limit"));
    }
    if (status.driving) {
      if (power != null && Math.abs(power) > 0.05) {
        add("battery_power", power < 0 ? "mdi:flash" : "mdi:recycle", power < 0 ? "Using" : "Regenerating",
          `${this._fmt(Math.abs(power), 1)} kW`, power < 0 ? "var(--info-color, #039be5)" : "var(--success-color, #43a047)");
      }
      add("gear", "mdi:car-shift-pattern", "Gear", this._display("gear"));
    }
    add("outside_temperature", "mdi:thermometer", "Outside", this._display("outside_temperature"));
    add("battery_temperature", "mdi:thermometer-lines", "Battery", this._display("battery_temperature"));
    if (!status.charging && !status.driving) {
      // Shown as a daily rate once parked long enough for one (Car Bridge 0.2.2 and later).
      const lost = this._num("parked_loss");
      const perDay = num(this._state("parked_loss")?.attributes.per_day_kwh);
      if (lost != null) {
        add("parked_loss", "mdi:battery-minus-outline", perDay != null ? "Parked loss/day" : "Parked loss",
          this._energy(perDay ?? lost));
      }
    }
    add("odometer", "mdi:counter", "Odometer", this._num("odometer") != null ? `${this._fmt(this._num("odometer"))} ${this._unit("odometer")}` : null);
    add("energy_charged", "mdi:battery-plus", "Total charged", this._num("energy_charged") > 0 ? this._energy(this._num("energy_charged")) : null);
    add("usable_battery_capacity", "mdi:car-battery", "Usable capacity", this._display("usable_battery_capacity"));
    add("battery_capacity", "mdi:car-battery", "Capacity", this._display("battery_capacity"));
    if (!tiles.length) return "";
    return `
      <div class="tiles" style="--count: ${tiles.length}">
        ${tiles.map((t) => `
          <div class="tile" ${this._attrs(t.key)} style="${t.color ? `--tile-color: ${t.color}` : ""}">
            <ha-icon icon="${t.icon}"></ha-icon>
            <div class="value">${esc(t.value)}</div>
            <div class="label">${esc(t.label)}</div>
          </div>`).join("")}
      </div>`;
  }

  /** Trips and charges that ended in the [days] up to [daysAgo] days ago. */
  _periodStats(days, daysAgo) {
    const end = Date.now() - daysAgo * DAY_MS;
    const start = end - days * DAY_MS;
    const trips = this._history.trips.filter((t) => t.end > start && t.end <= end);
    const charges = this._history.charges.filter((c) => c.end > start && c.end <= end);
    // Efficiency only from trips with a measured energy, so a trip without one doesn't inflate it.
    const measured = trips.filter((t) => t.energy > 0.05);
    const used = sum(measured.map((t) => t.energy));
    return {
      trips, charges, used,
      distance: sum(trips.map((t) => t.distance)),
      efficiency: used >= 0.3 ? sum(measured.map((t) => t.distance)) / used : null,
      charged: sum(charges.map((c) => c.kwh)),
      minutes: sum(trips.map((t) => t.minutes)),
    };
  }

  /** The last 7 or 30 days: distance, efficiency, energy used and charged, against the period before. */
  _summary() {
    const history = this._history;
    if (!history || (!history.trips.length && !history.charges.length)) return "";
    const days = this._period === "month" ? 30 : 7;
    const now = this._periodStats(days, 0);
    const before = this._periodStats(days, days);
    const distanceUnit = this._unit("last_trip_distance");
    const efficiencyUnit = this._unit("last_trip_efficiency") || `${distanceUnit}/kWh`;
    // Change against the period before, when there was one to compare with.
    const change = (value, previous, higherIsBetter) => {
      if (value == null || !previous) return "";
      const percent = Math.round(((value - previous) / previous) * 100);
      if (!percent) return "";
      const tone = higherIsBetter == null ? "" : (percent > 0) === higherIsBetter ? " good" : " bad";
      return `<span class="delta${tone}">${percent > 0 ? "▲" : "▼"} ${Math.abs(percent)}%</span>`;
    };
    const cost = this._cost(now.charged);
    const stats = [
      [`${this._fmt(now.distance, now.distance < 100 ? 1 : 0)} ${distanceUnit}`, change(now.distance, before.distance), "Distance", "last_trip_distance"],
      [now.efficiency != null ? `${this._fmt(now.efficiency, 1)} ${efficiencyUnit}` : "—", change(now.efficiency, before.efficiency, true), "Efficiency", "last_trip_efficiency"],
      [this._energy(now.used), change(now.used, before.used), "Energy used", "last_trip_distance"],
      cost != null
        ? [this._money(cost), "", `Charging · ${this._energy(now.charged)}`, "charge_session"]
        : [this._energy(now.charged), "", "Charged", "charge_session"],
    ];
    const counts = [
      `${now.trips.length} ${now.trips.length === 1 ? "trip" : "trips"}`,
      now.minutes ? `${this._duration(now.minutes)} driving` : null,
      `${now.charges.length} ${now.charges.length === 1 ? "charge" : "charges"}`,
    ].filter(Boolean);
    return `
      <div class="section">
        <div class="section-head">
          ${days === 7 ? "Last 7 days" : "Last 30 days"}
          <div class="period" role="group" aria-label="Period">
            <button data-period="week" aria-pressed="${days === 7}">7 days</button>
            <button data-period="month" aria-pressed="${days === 30}">30 days</button>
          </div>
        </div>
        <div class="stats">
          ${stats.map(([value, delta, label, key]) => `
            <div ${this._attrs(key)}><div class="value">${esc(value)}${delta}</div><div class="label">${esc(label)}</div></div>`).join("")}
        </div>
        ${this._bars(days, now.trips)}
        <div class="detail">${esc(counts.join(" · "))}</div>
      </div>`;
  }

  /** Distance per day, today on the right. */
  _bars(days, trips) {
    const today = startOfDay(Date.now());
    const totals = new Array(days).fill(0);
    for (const t of trips) {
      const index = days - 1 - Math.round((today - startOfDay(t.end)) / DAY_MS);
      if (index >= 0 && index < days) totals[index] += t.distance;
    }
    const most = Math.max(...totals);
    const tall = days === 7 ? 48 : 50;
    const unit = this._unit("last_trip_distance");
    const columns = totals.map((total, i) => {
      const day = new Date(today - (days - 1 - i) * DAY_MS);
      const label = day.toLocaleDateString(this._lang, { weekday: "narrow" });
      const height = most > 0 ? Math.max(3, (total / most) * tall) : 3;
      const kind = i === days - 1 ? " today" : total ? "" : " none";
      const title = `${day.toLocaleDateString(this._lang, { weekday: "short", month: "short", day: "numeric" })}: ${this._fmt(total, 1)} ${unit}`;
      return `<div class="col" title="${esc(title)}"><div class="b${kind}" style="height: ${height}px"></div>${days === 7 ? `<span>${esc(label)}</span>` : ""}</div>`;
    });
    return `<div class="bars${days === 7 ? "" : " month"}">${columns.join("")}</div>`;
  }

  /** The last finished charge: what it added, from and to which level, range gained, power and cost. */
  _lastCharge(status) {
    if (status.charging) return "";
    const session = this._state("charge_session");
    const kwh = this._num("charge_session");
    if (!session || kwh == null || kwh < 0.05 || session.attributes.in_progress) return "";
    const a = session.attributes;
    const ended = Date.parse(a.ended ?? "");
    const cost = this._cost(kwh);
    const level = a.start_level != null && a.end_level != null
      ? [`${this._fmt(a.start_level)} → ${this._fmt(a.end_level)}%`, "Battery"]
      : a.end_level != null ? [`${this._fmt(a.end_level)}%`, "Charged to"] : null;
    const stats = [
      [`+${this._energy(kwh)}`, "Added", "charge_session"],
      level && [...level, "battery_level"],
      a.range_gained != null ? [`+${this._fmt(a.range_gained)} ${this._unit("range")}`, "Range added", "range"] : null,
      cost != null
        ? [this._money(cost), "Cost", "charge_session"]
        : a.duration_min != null ? [this._duration(a.duration_min), "Time", "charge_session"] : null,
    ].filter(Boolean);
    const details = [
      a.average_power_kw != null ? `Average ${this._fmt(a.average_power_kw, 1)} kW` : null,
      a.peak_power_kw != null ? `peak ${this._fmt(a.peak_power_kw, 1)} kW` : null,
      cost != null && a.duration_min != null ? this._duration(a.duration_min) : null,
      a.while_asleep ? "while the car slept" : null,
    ].filter(Boolean);
    const when = Number.isFinite(ended) ? `${this._day(new Date(ended))}, ${this._time(new Date(ended))}` : "";
    return `
      <div class="section">
        <div class="section-head">Last charge<span>${esc(when)}</span></div>
        <div class="stats">
          ${stats.map(([value, label, key]) => `
            <div ${this._attrs(key)}><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`).join("")}
        </div>
        ${details.length ? `<div class="detail">${esc(details.join(" · "))}</div>` : ""}
      </div>`;
  }

  _trip() {
    const distance = this._num("last_trip_distance");
    if (distance == null) return "";
    const a = this._state("last_trip_distance").attributes;
    const ended = Date.parse(a.ended ?? "");
    const efficiency = this._num("last_trip_efficiency") ?? a.efficiency;
    const stats = [
      [`${this._fmt(distance, 1)} ${this._unit("last_trip_distance")}`, "Distance", "last_trip_distance"],
      [a.duration_min != null ? this._duration(a.duration_min) : null, "Time", "last_trip_distance"],
      [efficiency != null ? `${this._fmt(efficiency, 1)} ${this._unit("last_trip_efficiency") || ""}`.trim() : null, "Efficiency", "last_trip_efficiency"],
      [a.energy_used_kwh != null ? this._energy(a.energy_used_kwh) : a.average_speed != null ? `${this._fmt(a.average_speed)}` : null,
        a.energy_used_kwh != null ? "Energy used" : "Average speed", "last_trip_distance"],
    ].filter(([value]) => value != null);
    const speed = this._unit("speed") || "";
    const cost = a.energy_used_kwh > 0 ? this._cost(a.energy_used_kwh) : null;
    const details = [
      a.average_speed != null && a.energy_used_kwh != null ? `Average ${this._fmt(a.average_speed)} ${speed}`.trim() : null,
      a.max_speed != null ? `top ${this._fmt(a.max_speed)} ${speed}`.trim() : null,
      a.outside_temperature != null ? `${this._fmt(a.outside_temperature)} ${this._unit("outside_temperature")}`.trim() : null,
      cost != null ? `about ${this._money(cost)}` : null,
    ].filter(Boolean);
    const when = Number.isFinite(ended) ? `${this._day(new Date(ended))}, ${this._time(new Date(ended))}` : "";
    return `
      <div class="section">
        <div class="section-head">Last trip<span>${esc(when)}</span></div>
        <div class="stats">
          ${stats.map(([value, label, key]) => `
            <div ${this._attrs(key)}><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`).join("")}
        </div>
        ${details.length ? `<div class="detail">${esc(details.join(" · "))}</div>` : ""}
      </div>`;
  }

  _tires() {
    const wheels = [["front_left", "Front left"], ["front_right", "Front right"], ["rear_left", "Rear left"], ["rear_right", "Rear right"]];
    const values = wheels.map(([w, label]) => ({ key: `tire_pressure_${w}`, label, value: this._num(`tire_pressure_${w}`) }));
    if (values.every((v) => v.value == null)) return "";
    const unit = this._unit(values.find((v) => v.value != null).key);
    const cell = (v, right) => `
      <div class="${right ? "right" : ""}" ${this._attrs(v.key)}>
        <div class="value">${v.value == null ? "—" : `${this._fmt(v.value)} ${esc(unit)}`}</div>
        <div class="label">${v.label}</div>
      </div>`;
    return `
      <div class="section">
        <div class="section-head">Tires</div>
        <div class="tires">
          ${cell(values[0])}<ha-icon class="car" icon="mdi:car-outline"></ha-icon>${cell(values[1], true)}
          ${cell(values[2])}${cell(values[3], true)}
        </div>
      </div>`;
  }

  _chips(status) {
    const chips = [];
    const location = this._location();
    if (location) {
      const home = this._hass.states[this._ids.tracker]?.state === "home";
      chips.push({ entity: this._ids.tracker, icon: home ? "mdi:home" : "mdi:map-marker", text: location });
    }
    const gear = this._display("gear");
    if (gear && !status.driving) chips.push({ entity: this._ids.gear, icon: "mdi:car-shift-pattern", text: gear });
    if (this._ids.plugged_in) {
      const plugged = this._on("plugged_in");
      chips.push({
        entity: this._ids.plugged_in, icon: plugged ? "mdi:ev-plug-type1" : "mdi:power-plug-off-outline",
        text: plugged ? "Plugged in" : "Unplugged", color: plugged ? "var(--success-color, #43a047)" : null,
      });
    }
    if (this._on("charge_port") && !this._on("plugged_in")) {
      chips.push({ entity: this._ids.charge_port, icon: "mdi:ev-plug-ccs1", text: "Charge port open", color: "var(--warning-color, #ffa600)" });
    }
    if (this._on("fuel_door")) chips.push({ entity: this._ids.fuel_door, icon: "mdi:gas-station", text: "Fuel door open", color: "var(--warning-color, #ffa600)" });
    if (this._on("fuel_low") && this._ids.fuel_level) chips.push({ entity: this._ids.fuel_low, icon: "mdi:gas-station-off", text: "Fuel low", color: "var(--error-color, #db4437)" });
    const ignition = this._state("ignition")?.state;
    if (ignition && !["Off", "Lock", "unknown", "unavailable"].includes(ignition) && !status.driving) {
      chips.push({ entity: this._ids.ignition, icon: "mdi:key", text: `Ignition ${ignition.toLowerCase()}` });
    }
    if (!chips.length) return "";
    return `
      <div class="chips">
        ${chips.map((c) => `
          <div class="chip" data-entity="${esc(c.entity)}" tabindex="0" role="button" style="${c.color ? `--chip-color: ${c.color}` : ""}">
            <ha-icon icon="${c.icon}"></ha-icon>${esc(c.text)}
          </div>`).join("")}
      </div>`;
  }
}

const SCHEMA = [
  { name: "entity", required: true, selector: { entity: { filter: [{ integration: "mobile_app", domain: "sensor" }] } } },
  { name: "name", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "show_stats", selector: { boolean: {} } },
      { name: "show_charge", selector: { boolean: {} } },
      { name: "show_trip", selector: { boolean: {} } },
      { name: "show_tires", selector: { boolean: {} } },
      { name: "show_chips", selector: { boolean: {} } },
    ],
  },
  {
    name: "stats_period",
    selector: { select: { mode: "dropdown", options: [{ value: "week", label: "7 days" }, { value: "month", label: "30 days" }] } },
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "price", selector: { number: { min: 0, step: 0.001, mode: "box" } } },
      { name: "price_entity", selector: { entity: { filter: [{ domain: ["sensor", "input_number"] }] } } },
    ],
  },
  { name: "charge_efficiency", selector: { number: { min: 0.5, max: 1, step: 0.01, mode: "box" } } },
];

const LABELS = {
  entity: "Car (any of its sensors, such as the battery level)",
  name: "Name (optional)",
  show_stats: "7 and 30 day summary",
  show_charge: "Last charge",
  show_trip: "Last trip",
  show_tires: "Tire pressures",
  show_chips: "Status chips",
  stats_period: "Summary shows first",
  price: "Electricity price per kWh (optional)",
  price_entity: "…or a price sensor",
  charge_efficiency: "Charger efficiency (0.9 = 90% reaches the battery)",
};

class CarBridgeCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => LABELS[schema.name] ?? schema.name;
      this._form.addEventListener("value-changed", (e) => {
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: e.detail.value }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = { ...DEFAULTS, ...this._config };
    this._form.schema = SCHEMA;
  }
}

// A second copy of the resource (an old URL still registered, say) must not throw on define.
if (!customElements.get("car-bridge-card")) {
  customElements.define("car-bridge-card", CarBridgeCard);
  customElements.define("car-bridge-card-editor", CarBridgeCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "car-bridge-card",
    name: "Car Bridge",
    description: "Battery, range, charging, 7 and 30 day summaries, the last charge and trip, and tires for a car that Car Bridge sends to Home Assistant.",
    preview: true,
  });
  console.info(`%c CAR-BRIDGE-CARD %c ${VERSION} `, "color: white; background: #039be5; font-weight: 700", "color: #039be5; background: white");
}
