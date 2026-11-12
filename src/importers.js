// File importers: legacy ASA work databases, VIMS text exports, generic CSV and VIMS databases.
import { normMode, parseDateTime, segmentCycles, cyclesFromResultsRows, RESULTS_COLUMNS } from "./model.js";

/* ---------------- delimited text ---------------- */

export function detectDelimiter(lines) {
  const cands = [",", "\t", ";", "|"];
  let best = ",", bestScore = -1;
  for (const d of cands) {
    const counts = lines.slice(0, 20).map((l) => splitLine(l, d).length);
    const mode = counts.sort((a, b) => b - a)[Math.floor(counts.length / 2)] || 0;
    if (mode > bestScore) [best, bestScore] = [d, mode];
  }
  if (bestScore <= 1) return "ws";
  return best;
}

export function splitLine(line, d) {
  if (d === "ws") return line.trim().split(/\s{2,}|\t/);
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse delimited text; finds the header row (first row with mostly non-numeric cells). */
export function parseDelimited(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const d = detectDelimiter(lines);
  const rows = lines.map((l) => splitLine(l, d));
  const widest = Math.max(...rows.slice(0, 50).map((r) => r.length));
  let h = rows.findIndex((r) => r.length >= Math.max(2, widest * 0.6) && r.filter((c) => c && isNaN(Number(c))).length >= r.length * 0.6);
  if (h < 0) h = 0;
  const header = rows[h].map((c, i) => c || `Column ${i + 1}`);
  const preamble = lines.slice(0, h);
  const data = rows.slice(h + 1).filter((r) => r.length >= header.length * 0.5 && r.some((c) => c !== ""));
  return { header, data, preamble, delimiter: d };
}

/* ---------------- column mapping ---------------- */

// Target fields for raw time-series import, with header patterns (VIMS channel names, ASA names, generic).
export const FIELDS = [
  { key: "date", label: "Date", pats: [/^vimstime_date$/i, /^date$/i, /download.?date/i, /^cycle_date$/i] },
  { key: "time", label: "Time (or Date+Time)", pats: [/^vimstime_time$/i, /^vimstime$/i, /^time$/i, /timestamp/i, /^cycle_time$/i, /date.?time/i] },
  { key: "mode", label: "Payload Status / Op mode", pats: [/payload\s*status/i, /^op_?mode$/i, /operating\s*mode/i, /status/i] },
  { key: "speed", label: "Ground speed (km/h)", pats: [/ground\s*sp/i, /^speed$/i, /veh.*speed/i] },
  { key: "eng", label: "Engine speed (rpm)", pats: [/eng(ine)?\s*sp/i, /^eng_speed$/i, /rpm/i] },
  { key: "gear", label: "Actual gear", pats: [/actual\s*gear/i, /^gear$/i, /trans.*gear/i] },
  { key: "retarder", label: "Retarder", pats: [/retard/i] },
  { key: "fuel", label: "Engine fuel rate", pats: [/fuel\s*rate/i, /^fuel_rate$/i] },
  { key: "bt0", label: "LF brake temp (°C)", pats: [/^l(ef)?t\s*f(ront)?\s*br/i, /lt_f_brk/i] },
  { key: "bt1", label: "RF brake temp (°C)", pats: [/^r(igh)?t\s*f(ront)?\s*br/i, /rt_f_brk/i] },
  { key: "bt2", label: "LR brake temp (°C)", pats: [/^l(ef)?t\s*r(ear)?\s*br/i, /lt_r_brk/i] },
  { key: "bt3", label: "RR brake temp (°C)", pats: [/^r(igh)?t\s*r(ear)?\s*br/i, /rt_r_brk/i] },
  { key: "load", label: "Payload (t)", pats: [/^payload(?!\s*status)/i, /^load_?wgt$/i, /^load\s*weight/i] },
  { key: "lf", label: "LF strut pressure (kPa)", pats: [/susp\s*cyl\s*ltf/i, /^lt\s*f\s*susp/i, /^lf$/i] },
  { key: "rf", label: "RF strut pressure (kPa)", pats: [/susp\s*cyl\s*rtf/i, /^rt\s*f\s*susp/i, /^rf$/i] },
  { key: "lr", label: "LR strut pressure (kPa)", pats: [/susp\s*cyl\s*ltr/i, /^lt\s*r\s*susp/i, /^lr$/i] },
  { key: "rr", label: "RR strut pressure (kPa)", pats: [/susp\s*cyl\s*rtr/i, /^rt\s*r\s*susp/i, /^rr$/i] },
  { key: "odo", label: "Distance / odometer (m)", pats: [/^distance/i, /odometer/i, /^odo/i] },
  { key: "throttle", label: "Throttle position (%)", pats: [/throttle/i] },
  { key: "id", label: "Truck ID column (optional)", pats: [/^id$/i, /eqpt/i, /truck/i, /machine/i] },
];

export function guessMapping(header) {
  const map = {};
  const used = new Set();
  for (const f of FIELDS) {
    for (const p of f.pats) {
      const i = header.findIndex((h, idx) => !used.has(idx) && p.test(h.trim()));
      if (i >= 0) { map[f.key] = i; used.add(i); break; }
    }
  }
  return map;
}

/** Guess units from a header like "Ground Spd (mph)" so values can be converted to metric. */
function unitFactor(h, key) {
  const u = (h.match(/\(([^)]+)\)/) || [])[1]?.toLowerCase() || "";
  if (key === "speed" && /mph/.test(u)) return (v) => v * 1.609344;
  if (key === "load" && /(ton|tn)s?$/.test(u) && /short|us|^ton/.test(u) && !/tonne|metric|^t$/.test(u)) return (v) => v * 0.9071847;
  if ((key === "lf" || key === "rf" || key === "lr" || key === "rr") && /psi/.test(u)) return (v) => v * 6.894757;
  if (key.startsWith("bt") && /°?f$|deg\s*f/.test(u)) return (v) => ((v - 32) * 5) / 9;
  if (key === "odo" && /^km$/.test(u)) return (v) => v * 1000;
  if (key === "odo" && /mile|^mi$/.test(u)) return (v) => v * 1609.344;
  if (key === "fuel" && /l\/?h|lph|litres?\/h/.test(u)) return (v) => v / 3600;
  if (key === "fuel" && /gal/.test(u)) return (v) => (v * 3.785411784) / 3600;
  if (key === "fuel" && !u) return (v) => (v > 0.5 ? v / 3600 : v); // VIMS reports l/h; small values are already l/s
  return (v) => v;
}

const n = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === "" || /^(n\/?a|null|-+|\*+)$/i.test(t)) return null;
  const v = parseFloat(t.replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

/** Build samples from parsed delimited data and a column mapping. */
export function samplesFromTable(header, data, map, { dayFirst = false } = {}) {
  const conv = {};
  for (const k of Object.keys(map)) conv[k] = unitFactor(header[map[k]] || "", k);
  const get = (row, k) => (map[k] == null || map[k] === "" ? undefined : row[map[k]]);
  const out = [];
  let lastT = null;
  for (const row of data) {
    let t = null;
    const ts = get(row, "time");
    const ds = get(row, "date");
    if (ts !== undefined && ds !== undefined && ds !== ts) t = parseDateTime(`${ds} ${ts}`, dayFirst);
    if (t == null && ts !== undefined) {
      t = parseDateTime(String(ts), dayFirst);
      if (t == null && n(ts) != null) t = n(ts) * 1000; // seconds counter
    }
    if (t == null) t = lastT == null ? 0 : lastT + 1000; // assume 1 Hz
    lastT = t;
    const val = (k) => {
      const v = n(get(row, k));
      return v == null ? null : conv[k](v);
    };
    const modeRaw = get(row, "mode");
    const ret = get(row, "retarder");
    const s = {
      t,
      mode: normMode(modeRaw),
      speed: val("speed"),
      eng: val("eng"),
      gear: val("gear"),
      retarder: ret === undefined ? false : /^(on|yes|true|1|-1)$/i.test(String(ret).trim()) || (n(ret) != null && n(ret) !== 0 && n(ret) !== 32767),
      fuel: val("fuel"),
      bt: ["bt0", "bt1", "bt2", "bt3"].some((k) => map[k] != null) ? ["bt0", "bt1", "bt2", "bt3"].map(val) : null,
      load: val("load"),
      lf: val("lf"),
      rf: val("rf"),
      lr: val("lr"),
      rr: val("rr"),
      throttle: val("throttle"),
      odo: val("odo"),
      _id: get(row, "id"),
    };
    out.push(s);
  }
  return out;
}

/** Split samples by truck id column (if any) and segment into cycles. */
export function cyclesFromSamples(samples, { id, model, source }) {
  const byId = new Map();
  for (const s of samples) {
    const k = s._id ? String(s._id).trim() : id;
    delete s._id;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(s);
  }
  const out = [];
  for (const [tid, ss] of byId) out.push(...segmentCycles(ss, { id: tid || id || "Truck", model, source }));
  return out;
}

/** Is this delimited table already in the legacy ASA Results layout? */
export function isResultsLayout(header) {
  const h = new Set(header.map((x) => x.trim().toLowerCase()));
  return ["id", "cycle_no", "cycle_time", "op_mode", "speed"].every((k) => h.has(k));
}

export function resultsRowsFromTable(header, data) {
  return data.map((r) => Object.fromEntries(header.map((h, i) => [RESULTS_COLUMNS.find((c) => c.toLowerCase() === h.trim().toLowerCase()) || h, r[i]])));
}

/** Try to read machine id / model from a VIMS export preamble ("Machine: 793D  S/N: ..."). */
export function guessIdentity(preamble, fileName) {
  const txt = preamble.join("\n");
  const model = (txt.match(/\b(7[0-9]{2}[A-Z]?|79[0-9][A-Z]?)\b/) || [])[1] || (fileName.match(/\b(7\d\d[A-Z]?)\b/) || [])[1] || "";
  const id = (txt.match(/(?:machine|equip(?:ment)?|eqpt|unit)\s*(?:id|no|number|#)?\s*[:=]\s*([\w-]+)/i) || [])[1] || fileName.replace(/\.[^.]+$/, "");
  return { id, model };
}

/* ---------------- Access databases ---------------- */

let MDBReaderCtor = null;
async function getMDB() {
  if (!MDBReaderCtor) {
    const mod = await import("mdb-reader");
    MDBReaderCtor = mod.default;
  }
  return MDBReaderCtor;
}

export async function openAccess(arrayBuffer) {
  const MDBReader = await getMDB();
  const { Buffer } = await import("buffer");
  return new MDBReader(Buffer.from(arrayBuffer));
}

const findTable = (names, want) => names.find((n) => n.toLowerCase() === want.toLowerCase());

/** Classify an opened Access db: legacy ASA work file, VIMS database, or unknown. */
export function classifyAccess(db) {
  const names = db.getTableNames();
  if (findTable(names, "DataLogger_Detail") && findTable(names, "ChannelConfig")) return { kind: "vims", names };
  if (findTable(names, "Results") || findTable(names, "Truck Data VIMS")) return { kind: "asa", names };
  return { kind: "unknown", names };
}

/** Read cycles from a legacy ASA work .mdb (Results table, falling back to Truck Data VIMS). */
export function cyclesFromAsaDb(db, source) {
  const names = db.getTableNames();
  const modelById = {};
  const ti = findTable(names, "Truck Info");
  if (ti) for (const r of db.getTable(ti).getData()) if (r.ID) modelById[r.ID] = r.Model || "";
  let rows = [];
  for (const t of ["Results", "Truck Data VIMS"]) {
    const tn = findTable(names, t);
    if (tn) {
      rows = db.getTable(tn).getData();
      if (rows.length) break;
    }
  }
  return cyclesFromResultsRows(rows, { modelById, source });
}

/* ---- VIMS database (MACHINE / MODEL / DataLogger / DataLogger_Detail / ChannelConfig) ---- */

export function vimsLoggers(db) {
  const names = db.getTableNames();
  const machines = findTable(names, "MACHINE") ? db.getTable(findTable(names, "MACHINE")).getData() : [];
  const bySerial = Object.fromEntries(machines.map((m) => [m.Serial_Number, m]));
  const loggers = db.getTable(findTable(names, "DataLogger")).getData();
  return loggers
    .map((l) => {
      const m = bySerial[l.Serial_Number] || {};
      return { ...l, EqptNo: m.EqptNo || l.Serial_Number, Model_Code: m.Model_Code || l.Model_Code || "" };
    })
    .sort((a, b) => String(a.EqptNo).localeCompare(String(b.EqptNo)) || (b.DownloadDate || 0) - (a.DownloadDate || 0));
}

/** Channel positions configured for a model, with a best-guess field mapping. */
export function vimsChannels(db, modelCode) {
  const names = db.getTableNames();
  const cc = db.getTable(findTable(names, "ChannelConfig")).getData().filter((r) => !modelCode || r.Model_Code === modelCode);
  return cc
    .map((r) => {
      const desc = Object.entries(r)
        .filter(([k, v]) => typeof v === "string" && !/model_code/i.test(k))
        .map(([, v]) => v)
        .join(" ");
      let guess = r.Channel_ID === 729 ? "mode" : "";
      if (!guess && desc) {
        for (const f of FIELDS) if (f.key !== "id" && f.key !== "date" && f.key !== "time" && f.pats.some((p) => p.test(desc))) { guess = f.key; break; }
      }
      return { channel: r.Channel_ID, position: r.Position, desc, guess };
    })
    .sort((a, b) => a.position - b.position);
}

/** Convert one DataLogger download to samples using a {position -> field} mapping. */
export function vimsSamples(db, loggerId, posMap) {
  const names = db.getTableNames();
  const detail = db.getTable(findTable(names, "DataLogger_Detail")).getData().filter((r) => r.DataLoggerID === loggerId);
  detail.sort((a, b) => +a.VIMSTime - +b.VIMSTime);
  const fields = Object.entries(posMap).filter(([, f]) => f);
  return detail.map((r) => {
    const s = { t: r.VIMSTime instanceof Date ? r.VIMSTime.getTime() : parseDateTime(String(r.VIMSTime)), bt: null };
    for (const [pos, f] of fields) {
      let v = r[`DataValue${pos}`];
      if (v === undefined) v = r[`DataValue_${pos}`];
      if (v === undefined || v === null) continue;
      v = Number(v);
      if (f === "mode") s.mode = normMode(v);
      else if (f === "retarder") s.retarder = v !== 0 && v !== 32767;
      else if (f === "fuel") s.fuel = v / 3600;
      else if (f.startsWith("bt")) { s.bt = s.bt || [null, null, null, null]; s.bt[+f.slice(2)] = v; }
      else if (f === "gear") s.gear = v === 32767 ? null : v;
      else s[f] = v;
    }
    return s;
  });
}
