// Core data model: normalised samples, cycle segmentation and cycle statistics.
// Pure functions only (no DOM) so they can be unit-tested in Node.

export const MODES = ["StopEmp", "TravEmp", "LOADING", "TravlLd", "StopdLd", "DUMPING"];
export const MODE_LABEL = {
  StopEmp: "Stopped Empty",
  TravEmp: "Travel Empty",
  LOADING: "Loading",
  TravlLd: "Travel Loaded",
  StopdLd: "Stopped Loaded",
  DUMPING: "Dumping",
};
const EMPTY_MODES = new Set(["StopEmp", "TravEmp"]);

// VIMS "Payload Status" channel codes -> operating mode.
const MODE_CODES = { 4: "DUMPING", 5: "StopEmp", 6: "TravEmp", 7: "StopdLd", 8: "TravlLd", 9: "LOADING" };

/** Normalise any operating-mode representation (code, VIMS text, ASA text) to a MODES value. */
export function normMode(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\s*\d+(\.0+)?\s*$/.test(String(v))) return MODE_CODES[Number(v)] || null;
  const s = String(v).toUpperCase().replace(/[^A-Z]/g, "");
  if (s.startsWith("DUMP")) return "DUMPING";
  if (s.startsWith("LOADING")) return "LOADING";
  if (s === "STOPEMP" || s === "STOPPEDEMPTY" || s === "STOPEMPTY") return "StopEmp";
  if (s === "TRAVEMP" || s === "TRAVELINGEMPTY" || s === "TRAVELLINGEMPTY" || s === "TRAVELEMPTY") return "TravEmp";
  if (s === "STOPDLD" || s === "STOPPEDLOADED" || s === "STOPLOADED") return "StopdLd";
  if (s === "TRAVLLD" || s === "TRAVELINGLOADED" || s === "TRAVELLINGLOADED" || s === "TRAVELLOADED") return "TravlLd";
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Decode a VIMS transmission gear code to a signed gear number (F=+n, R=-n, N=0). */
export function decodeGear(g) {
  if (g === null || g === undefined) return null;
  if (g >= 144 && g < 160) return g - 144;
  if (g >= 128 && g < 144) return -(g - 128);
  if (g === 64 || g === 0) return 0;
  if (g >= 0 && g <= 16) return g; // already a plain gear number
  return null;
}

/**
 * A Sample is one time-step for one truck:
 * { t (epoch ms), mode, speed (km/h), eng (rpm), gear (code), retarder (bool), fuel (l/s),
 *   bt: [LF,RF,LR,RR] brake temps (°C), load (t), lf, rf, lr, rr (strut kPa), throttle (%),
 *   pass, dist (m), fuelCum (l) }
 */

/**
 * Turn raw time-series samples for a single truck into cycles.
 * Fills in distance, cumulative fuel and pass number when they are not already present.
 */
export function segmentCycles(samples, { id, model = "", source = "" } = {}) {
  const rows = samples.filter((s) => s && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  if (!rows.length) return [];
  deriveModesIfMissing(rows);
  const cycles = [];
  let cur = null;
  let seenWork = false;
  let prevMode = null;
  for (const r of rows) {
    const enteringEmpty = EMPTY_MODES.has(r.mode) && !EMPTY_MODES.has(prevMode);
    if (!cur || (enteringEmpty && seenWork)) {
      cur = { rows: [] };
      cycles.push(cur);
      seenWork = false;
    }
    if (r.mode === "LOADING" || r.mode === "DUMPING" || r.mode === "TravlLd") seenWork = true;
    cur.rows.push(r);
    prevMode = r.mode;
  }
  const start = rows[0].t;
  return cycles.map((c, i) => finaliseCycle({ id, model, source, start, cycleNo: i + 1, rows: c.rows }));
}

/** If no mode channel was available, infer operating mode from payload and speed. */
function deriveModesIfMissing(rows) {
  if (rows.some((r) => r.mode)) {
    let last = rows.find((r) => r.mode).mode;
    for (const r of rows) r.mode ? (last = r.mode) : (r.mode = last);
    return;
  }
  const maxLoad = Math.max(0, ...rows.map((r) => r.load || 0));
  const thr = maxLoad * 0.25;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const moving = (r.speed || 0) > 0.5;
    const loaded = (r.load || 0) > thr && maxLoad > 0;
    const prevLoad = i > 0 ? rows[i - 1].load || 0 : 0;
    if (!loaded) r.mode = moving ? "TravEmp" : (r.load || 0) > prevLoad + 0.5 ? "LOADING" : "StopEmp";
    else if (moving) r.mode = "TravlLd";
    else if ((r.load || 0) > prevLoad + 0.5) r.mode = "LOADING";
    else r.mode = "StopdLd";
  }
}

/** Build a cycle object, computing derived per-row fields that are absent. */
export function finaliseCycle({ id, model, source, start, cycleNo, rows, keepDerived = false }) {
  const needDist = !keepDerived || rows.every((r) => r.dist == null);
  const needFuelCum = !keepDerived || rows.every((r) => r.fuelCum == null);
  const needPass = !keepDerived || rows.every((r) => r.pass == null);
  let dist = 0;
  let fuelCum = 0;
  let passCount = 0;
  let lastLoad = null;
  let loadedStarted = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dt = i > 0 ? Math.min(Math.max((r.t - rows[i - 1].t) / 1000, 0), 60) : 1;
    if (needDist) {
      if (r.mode === "TravlLd" && !loadedStarted) {
        loadedStarted = true;
        dist = 0;
      }
      if (i > 0) {
        // prefer an odometer/distance channel when present, else integrate speed
        const d = r.odo != null && rows[i - 1].odo != null ? r.odo - rows[i - 1].odo : null;
        dist += d != null && d >= 0 && d <= 30 * dt ? d : ((rows[i - 1].speed || 0) / 3.6) * dt;
      }
      r.dist = Math.round(dist);
    }
    if (needFuelCum) {
      fuelCum += (r.fuel || 0) * dt;
      r.fuelCum = fuelCum;
    }
    if (needPass) {
      if (r.mode === "LOADING") {
        const l = r.load || 0;
        if (lastLoad !== null && l > lastLoad + 0.5 && l > 0) passCount++;
        lastLoad = l;
        r.pass = Math.max(1, passCount);
      } else r.pass = null;
    }
    // composite strut pressures
    if (r.lf != null && r.rf != null && r.lr != null && r.rr != null) {
      if (r.rack == null) r.rack = Math.round(r.lf + r.rr - (r.rf + r.lr));
      if (r.pitch == null) r.pitch = Math.round(r.lf + r.rf - (r.rr + r.lr));
      if (r.bias == null) r.bias = Math.round(r.lf + r.lr - (r.rf + r.rr));
    }
  }
  // Brake severity: deceleration (km/h/s) while retarding.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i === 0) {
      r.brkSev = 0;
      continue;
    }
    const p = rows[i - 1];
    const dt = Math.max((r.t - p.t) / 1000, 1e-3);
    const dec = ((p.speed || 0) - (r.speed || 0)) / dt;
    r.brkSev = r.retarder ? dec : 0;
  }
  const cyc = {
    key: `${id}|${start}|${cycleNo}`,
    id: String(id || "Unknown"),
    model: model || "",
    source: source || "",
    start,
    cycleNo,
    date: rows[0].date ?? rows[0].t,
    rows,
  };
  cyc.stats = cycleStats(cyc);
  return cyc;
}

/** Summary statistics for one cycle (matches the old L-PRN cycle summary fields and more). */
export function cycleStats(c) {
  const rows = c.rows;
  const s = {
    emptyTravelTime: 0,
    emptyTravelDist: 0,
    emptyStopTime: 0,
    loadTime: 0,
    loadStopTime: 0,
    loadTravelTime: 0,
    loadTravelDist: 0,
    dumpTime: 0,
    totalTime: 0,
    payload: 0,
    passes: 0,
    fuel: 0,
    maxSpeedLoaded: 0,
    maxSpeedEmpty: 0,
    maxBrakeTemp: null,
    maxEngSpeed: null,
    hasStruts: false,
    hasBrakeTemps: false,
    hasFuel: false,
    hasThrottle: false,
    hasGear: false,
    hasEng: false,
  };
  const key = { StopEmp: "emptyStopTime", TravEmp: "emptyTravelTime", LOADING: "loadTime", TravlLd: "loadTravelTime", StopdLd: "loadStopTime", DUMPING: "dumpTime" };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dt = i + 1 < rows.length ? Math.min(Math.max((rows[i + 1].t - r.t) / 1000, 0), 60) : 1;
    s.totalTime += dt;
    if (key[r.mode]) s[key[r.mode]] += dt;
    if (r.mode === "TravEmp") s.emptyTravelDist = Math.max(s.emptyTravelDist, r.dist || 0);
    if (r.mode === "TravlLd") s.loadTravelDist = Math.max(s.loadTravelDist, r.dist || 0);
    if (r.mode === "TravlLd" || r.mode === "StopdLd" || r.mode === "DUMPING" || r.mode === "LOADING") s.payload = Math.max(s.payload, r.load || 0);
    if (r.pass) s.passes = Math.max(s.passes, r.pass);
    if (r.mode === "TravlLd") s.maxSpeedLoaded = Math.max(s.maxSpeedLoaded, r.speed || 0);
    if (r.mode === "TravEmp") s.maxSpeedEmpty = Math.max(s.maxSpeedEmpty, r.speed || 0);
    if (r.lf != null) s.hasStruts = true;
    if (r.fuel != null) s.hasFuel = true;
    if (r.throttle != null && r.throttle !== 0) s.hasThrottle = true;
    if (r.gear != null) s.hasGear = true;
    if (r.eng != null) {
      s.hasEng = true;
      s.maxEngSpeed = Math.max(s.maxEngSpeed ?? 0, r.eng);
    }
    if (r.bt && r.bt.some((x) => x != null)) {
      s.hasBrakeTemps = true;
      s.maxBrakeTemp = Math.max(s.maxBrakeTemp ?? -Infinity, ...r.bt.filter((x) => x != null));
    }
  }
  s.fuel = rows.length ? rows[rows.length - 1].fuelCum || 0 : 0;
  s.avgSpeedLoaded = s.loadTravelTime ? (s.loadTravelDist / s.loadTravelTime) * 3.6 : 0;
  s.avgSpeedEmpty = s.emptyTravelTime ? (s.emptyTravelDist / s.emptyTravelTime) * 3.6 : 0;
  s.tph = s.totalTime ? (s.payload / s.totalTime) * 3600 : 0;
  s.fuelPerTonne = s.payload ? s.fuel / s.payload : 0;
  s.complete = rows.some((r) => r.mode === "LOADING") && rows.some((r) => r.mode === "DUMPING");
  for (const phase of ["loaded", "empty"]) {
    const pr = rows.filter((r) => r.mode === (phase === "loaded" ? "TravlLd" : "TravEmp"));
    const vals = (f) => pr.map((r) => r[f]).filter((v) => v != null);
    const ext = (f) => (vals(f).length ? [Math.min(...vals(f)), Math.max(...vals(f))] : null);
    const mean = (f) => (vals(f).length ? vals(f).reduce((a, b) => a + b, 0) / vals(f).length : null);
    s[phase] = { rack: ext("rack"), pitch: ext("pitch"), bias: ext("bias"), mean: { rack: mean("rack"), pitch: mean("pitch"), bias: mean("bias") } };
  }
  return s;
}

/**
 * Haul Road Condition Index rating for a phase given management limits (kPa).
 * limits.reference = "mean" (default) measures the dynamic swing about the phase average,
 * "zero" measures absolute composite pressure.
 */
export function hrciRating(stats, phase, limits) {
  const p = stats[phase];
  if (!p || !p.rack) return null;
  const over = [];
  const peaks = {};
  const chk = (name, f, lim) => {
    const ext = p[f];
    if (!ext) return;
    const ref = limits.reference === "zero" ? 0 : p.mean?.[f] || 0;
    const peak = Math.round(Math.max(Math.abs(ext[0] - ref), Math.abs(ext[1] - ref)));
    peaks[f] = peak;
    if (lim && peak > lim) over.push(`${name} ${peak} kPa > ${lim} kPa`);
  };
  chk("Rack", "rack", limits.rack);
  chk("Pitch", "pitch", limits.pitch);
  chk("Bias", "bias", limits.bias);
  return { acceptable: over.length === 0, reasons: over, peaks };
}

/** Fleet-level aggregate over a set of cycles. */
export function fleetSummary(cycles) {
  // only complete (loaded and dumped) cycles count towards productivity
  let done = cycles.filter((c) => c.stats.complete && c.stats.payload > 0);
  if (!done.length) done = cycles.filter((c) => c.stats.payload > 0);
  const tot = (f) => done.reduce((a, c) => a + (c.stats[f] || 0), 0);
  const n = done.length || 1;
  const tonnes = tot("payload");
  const time = tot("totalTime");
  return {
    trucks: new Set(cycles.map((c) => c.id)).size,
    cycles: cycles.length,
    loadedCycles: done.length,
    tonnes,
    avgPayload: tonnes / n,
    avgCycleTime: time / n,
    tph: time ? (tonnes / time) * 3600 : 0,
    fuel: tot("fuel"),
    fuelPerTonne: tonnes ? tot("fuel") / tonnes : 0,
    avgPasses: tot("passes") / n,
    avgLoadTime: tot("loadTime") / n,
    avgHaulDist: tot("loadTravelDist") / n,
  };
}

/* ---------- Converters from the legacy ASA "Results" table ---------- */

const toMs = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v == null || v === "") return null;
  const d = parseDateTime(String(v));
  return d;
};

/** Parse common date/time strings ("12/30/99 16:32:13", ISO, "16:32:13"). Returns epoch ms (UTC-based). */
export function parseDateTime(s, dayFirst = false) {
  s = s.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7] ? Math.round(+m[7] * 1000) : 0);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(AM|PM)?)?$/i);
  if (m) {
    let [a, b] = [+m[1], +m[2]];
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    let mo = a, d = b;
    if (dayFirst || a > 12) [mo, d] = [b, a];
    let h = +(m[4] || 0);
    if (m[8]) h = (h % 12) + (m[8].toUpperCase() === "PM" ? 12 : 0);
    return Date.UTC(y, mo - 1, d, h, +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(+m[7] * 1000) : 0);
  }
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(AM|PM)?$/i);
  if (m) {
    let h = +m[1];
    if (m[5]) h = (h % 12) + (m[5].toUpperCase() === "PM" ? 12 : 0);
    return Date.UTC(1899, 11, 30, h, +m[2], +(m[3] || 0), m[4] ? Math.round(+m[4] * 1000) : 0);
  }
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : null;
}

/** Convert legacy ASA Results rows (from a work .mdb or a CSV export) into cycles, keeping their values. */
export function cyclesFromResultsRows(rows, { modelById = {}, source = "" } = {}) {
  const groups = new Map();
  for (const x of rows) {
    const k = `${x.ID}|${x.Start_Time instanceof Date ? x.Start_Time.getTime() : x.Start_Time}|${x.Cycle_No}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const out = [];
  for (const [, g] of groups) {
    const f = g[0];
    const cycleDate = toMs(f.Cycle_Date);
    let dayOffset = 0;
    const rows2 = g.map((x) => {
      let t = toMs(x.Cycle_Time);
      // legacy files store time-of-day only; anchor to Cycle_Date when present
      if (t != null && cycleDate != null && new Date(t).getUTCFullYear() < 1901) {
        t = cycleDate + (t - Date.UTC(1899, 11, 30)) + dayOffset;
      }
      return {
        t,
        date: cycleDate,
        mode: normMode(x.OP_Mode),
        speed: num(x.Speed),
        eng: num(x.Eng_Speed),
        gear: num(x.Gear),
        retarder: x.Retarder === true || num(x.Retarder) === 1 || num(x.Retarder) === -1,
        fuel: num(x.Fuel_Rate),
        fuelCum: num(x.Fuel_Rate_Cum),
        bt: [num(x.Lt_F_Brk_Temp), num(x.Rt_F_Brk_Temp), num(x.Lt_R_Brk_Temp), num(x.Rt_R_Brk_Temp)],
        load: num(x.Load_Wgt),
        pass: num(x.Pass),
        lf: num(x.LF),
        rf: num(x.RF),
        lr: num(x.LR),
        rr: num(x.RR),
        dist: num(x.Distance),
        rack: num(x.Mach_Rack),
        pitch: num(x.Mach_Pitch),
        bias: num(x.Load_Bias),
        throttle: num(x.Throttle_Pos),
        faults: x.Faults || null,
      };
    });
    rows2.sort((a, b) => a.t - b.t);
    // handle midnight roll-over for time-only data
    for (let i = 1; i < rows2.length; i++) {
      if (rows2[i].t < rows2[i - 1].t - 12 * 3600e3) {
        for (let j = i; j < rows2.length; j++) rows2[j].t += 86400e3;
      }
    }
    if (rows2.some((r) => r.bt.every((v) => v == null))) rows2.forEach((r) => r.bt.every((v) => v == null) && (r.bt = null));
    out.push(
      finaliseCycle({
        id: f.ID,
        model: modelById[f.ID] || "",
        source,
        start: toMs(f.Start_Time),
        cycleNo: num(f.Cycle_No),
        rows: rows2,
        keepDerived: true,
      })
    );
  }
  out.sort((a, b) => (a.id + "").localeCompare(b.id + "") || a.start - b.start || a.cycleNo - b.cycleNo);
  return out;
}

export const RESULTS_COLUMNS = [
  "ID", "Start_Time", "Cycle_No", "Cycle_Date", "Cycle_Time", "OP_Mode", "Speed", "Eng_Speed", "Gear", "Gear_Desc",
  "Retarder", "Fuel_Rate", "Fuel_Rate_Cum", "Lt_F_Brk_Temp", "Rt_F_Brk_Temp", "Lt_R_Brk_Temp", "Rt_R_Brk_Temp",
  "Load_Wgt", "Pass", "LF", "RF", "LR", "RR", "Faults", "Distance", "Mach_Rack", "Mach_Pitch", "Load_Bias", "Throttle_Pos",
];

const fmtTs = (ms) => (ms == null ? "" : new Date(ms).toISOString().replace("T", " ").slice(0, 19));

/** Export cycles back to the legacy Results column layout (CSV rows). */
export function cyclesToResultsRows(cycles) {
  const out = [];
  for (const c of cycles) {
    for (const r of c.rows) {
      out.push({
        ID: c.id, Start_Time: fmtTs(c.start), Cycle_No: c.cycleNo, Cycle_Date: fmtTs(c.date), Cycle_Time: fmtTs(r.t),
        OP_Mode: r.mode, Speed: r.speed, Eng_Speed: r.eng, Gear: r.gear, Gear_Desc: "", Retarder: r.retarder ? 1 : 0,
        Fuel_Rate: r.fuel, Fuel_Rate_Cum: r.fuelCum, Lt_F_Brk_Temp: r.bt?.[0], Rt_F_Brk_Temp: r.bt?.[1],
        Lt_R_Brk_Temp: r.bt?.[2], Rt_R_Brk_Temp: r.bt?.[3], Load_Wgt: r.load, Pass: r.pass, LF: r.lf, RF: r.rf, LR: r.lr,
        RR: r.rr, Faults: r.faults || "", Distance: r.dist, Mach_Rack: r.rack, Mach_Pitch: r.pitch, Load_Bias: r.bias,
        Throttle_Pos: r.throttle,
      });
    }
  }
  return out;
}
