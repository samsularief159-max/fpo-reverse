// Graph catalogue. Each graph turns one cycle into a Chart.js configuration.
import { decodeGear, hrciRating } from "./model.js";

const PH = {
  loaded: { modes: ["TravlLd"], label: "Travel Loaded" },
  empty: { modes: ["TravEmp"], label: "Travel Empty" },
  loading: { modes: ["LOADING"], label: "Loading Phase" },
};

const phaseRows = (c, ph) => c.rows.filter((r) => PH[ph].modes.includes(r.mode));

/** Aggregate rows on integer distance (metres). */
function byDistance(rows, fields, agg = "avg") {
  const m = new Map();
  for (const r of rows) {
    const d = r.dist ?? 0;
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, rs]) => {
      const o = { x: d };
      for (const [f, a] of Object.entries(fields)) {
        const vs = rs.map((r) => (typeof f === "string" && f.includes(".") ? r[f.split(".")[0]]?.[+f.split(".")[1]] : r[f])).filter((v) => v != null);
        const how = a || agg;
        o[f] = !vs.length ? null : how === "max" ? Math.max(...vs) : how === "min" ? Math.min(...vs) : vs.reduce((p, q) => p + q, 0) / vs.length;
      }
      return o;
    });
}

/** Rows against elapsed seconds from phase start. */
function byTime(rows, fields) {
  if (!rows.length) return [];
  const t0 = rows[0].t;
  return rows.map((r) => {
    const o = { x: (r.t - t0) / 1000 };
    for (const f of Object.keys(fields)) o[f] = f.includes(".") ? r[f.split(".")[0]]?.[+f.split(".")[1]] ?? null : r[f] ?? null;
    return o;
  });
}

const has = (rows, f) => rows.some((r) => (f.includes(".") ? r[f.split(".")[0]]?.[+f.split(".")[1]] != null : r[f] != null));

/* ---------- graph definitions ---------- */

const SPEED = { field: "speed", label: "Speed (km/h)", axis: "y2", color: "c5", dash: [4, 3] };
const STRUTS = [
  { field: "lf", label: "LF strut", color: "c1" },
  { field: "rf", label: "RF strut", color: "c2" },
  { field: "lr", label: "LR strut", color: "c3" },
  { field: "rr", label: "RR strut", color: "c4" },
];
const COMPOSITE = [
  { field: "rack", label: "Machine Rack", color: "c1" },
  { field: "pitch", label: "Machine Pitch", color: "c2" },
  { field: "bias", label: "Machine Bias", color: "c3" },
];
const BRAKES = [
  { field: "bt.0", label: "LF brake", color: "c1" },
  { field: "bt.1", label: "RF brake", color: "c2" },
  { field: "bt.2", label: "LR brake", color: "c3" },
  { field: "bt.3", label: "RR brake", color: "c4" },
];

function lineGraph({ id, title, phase, x, series, agg, y1, y2, limits, needs, note }) {
  return {
    id,
    title,
    group: phase === "loading" ? "Loading" : phase === "loaded" ? "Loaded" : "Empty",
    build(c, settings) {
      const rows = phaseRows(c, phase);
      const need = needs || series.filter((s) => s.axis !== "y2").map((s) => s.field);
      if (!rows.length || !need.some((f) => has(rows, f))) return null;
      const fields = Object.fromEntries(series.map((s) => [s.field, s.agg || agg]));
      const pts = x === "dist" ? byDistance(rows, fields, agg) : byTime(rows, fields);
      const tr = series.map((s) => ({ ...s, data: pts.map((p) => ({ x: p.x, y: s.map ? s.map(p[s.field]) : p[s.field] })) }));
      const lim = limits ? limits(settings, c) : [];
      return {
        kind: "line",
        xTitle: x === "dist" ? "Distance (m)" : "Time (s)",
        y1, y2: tr.some((s) => s.axis === "y2") ? y2 || SPEED.label : null,
        series: tr,
        limits: lim,
        xMax: pts.length ? pts[pts.length - 1].x : 0,
        subtitle: PH[phase].label,
        note: typeof note === "function" ? note(c, settings) : note,
      };
    },
  };
}

const hrciLimits = (s, c, phase) => {
  const L = s.limits;
  const ref = L.reference === "zero" ? { rack: 0, pitch: 0, bias: 0 } : c.stats[phase]?.mean || {};
  const out = [];
  for (const [f, name, col] of [["rack", "Rack", "c1"], ["pitch", "Pitch", "c2"], ["bias", "Bias", "c3"]]) {
    if (!L[f] || ref[f] == null) continue;
    out.push({ y: ref[f] + L[f], label: `${name} limit`, color: col });
    out.push({ y: ref[f] - L[f], label: null, color: col });
  }
  return out;
};

const hrci = (phase) => {
  const g = lineGraph({
    id: `hrci_${phase}`,
    title: `Haul Road Condition Index (${phase === "loaded" ? "Loaded" : "Empty"})`,
    phase, x: "dist", agg: "avg",
    series: [...COMPOSITE, SPEED],
    y1: "Composite strut pressures (kPa)",
    limits: (s, c) => hrciLimits(s, c, phase),
  });
  const base = g.build;
  g.build = (c, s) => {
    const r = base(c, s);
    if (!r) return r;
    const rt = hrciRating(c.stats, phase, s.limits);
    if (rt) {
      r.rating = rt;
      r.note = `Rating: ${rt.acceptable ? "ACCEPTABLE" : "UNACCEPTABLE"} — peak swing Rack ${rt.peaks.rack ?? "–"} / Pitch ${rt.peaks.pitch ?? "–"} / Bias ${rt.peaks.bias ?? "–"} kPa` + (rt.reasons.length ? ` (${rt.reasons.join("; ")})` : "");
    }
    return r;
  };
  return g;
};

const both = (fn) => [fn("loaded"), fn("empty")];
const cap = (p) => (p === "loaded" ? "Loaded" : "Empty");

const brakeTempLimit = (s) => (s.limits.brakeTemp ? [{ y: s.limits.brakeTemp, label: "Max temperature limit", color: "bad", axis: "y" }] : []);

export const GRAPHS = [
  {
    id: "payload",
    title: "Payload and Cycle Time",
    group: "Cycle",
    build(c) {
      const passes = new Map();
      for (const r of c.rows) {
        if (r.mode !== "LOADING" || !r.pass) continue;
        const p = passes.get(r.pass) || { t: 0, w: 0 };
        p.t += 1;
        p.w = Math.max(p.w, r.load || 0);
        passes.set(r.pass, p);
      }
      if (!passes.size) return null;
      const keys = [...passes.keys()].sort((a, b) => a - b);
      // weight shown at the end of pass n is the reading when pass n+1 starts (or the final payload)
      const wt = keys.map((k, i) => (i + 1 < keys.length ? passes.get(keys[i + 1]).w : c.stats.payload));
      return {
        kind: "bar",
        labels: keys.map((k) => `Pass ${k}`),
        series: [
          { label: "Cumulative payload (t)", data: wt, color: "c1", axis: "y" },
          { label: "Pass time (s)", data: keys.map((k) => passes.get(k).t), color: "c2", axis: "y2" },
        ],
        y1: "Cumulative payload (tonnes)",
        y2: "Cycle time (secs)",
        subtitle: "Tonnes per pass",
        note: `Payload ${c.stats.payload.toFixed(1)} t in ${keys.length} passes · loading ${fmtDur(c.stats.loadTime)} · cycle ${fmtDur(c.stats.totalTime)}`,
      };
    },
  },
  ...both(hrci),
  ...both((p) => lineGraph({ id: `comp_dist_${p}`, title: `Composite Pressures vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [...COMPOSITE, SPEED], y1: "Composite strut pressures (kPa)" })),
  ...both((p) => lineGraph({ id: `comp_time_${p}`, title: `Composite Pressures vs Time (${cap(p)})`, phase: p, x: "time", series: COMPOSITE, y1: "Composite strut pressures (kPa)" })),
  lineGraph({ id: "comp_loading", title: "Composite Pressures vs Loading Time", phase: "loading", x: "time", series: COMPOSITE, y1: "Composite strut pressures (kPa)" }),
  ...both((p) => lineGraph({ id: `strut_dist_${p}`, title: `Strut Pressures vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [...STRUTS, SPEED], y1: "Strut pressures (kPa)" })),
  lineGraph({ id: "strut_loading", title: "Strut Pressures vs Loading Time", phase: "loading", x: "time", series: STRUTS, y1: "Strut pressures (kPa)" }),
  ...both((p) => lineGraph({ id: `speed_brk_${p}`, title: `Speed, Brake Temp vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [...BRAKES, SPEED], y1: "Brake temperature (°C)", limits: brakeTempLimit })),
  ...both((p) => lineGraph({ id: `eng_brk_${p}`, title: `Engine Speed, Brake Temp vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [...BRAKES, { field: "eng", label: "Engine speed (rpm)", axis: "y2", color: "c5", dash: [4, 3] }], y1: "Brake temperature (°C)", y2: "Engine speed (rpm)", limits: brakeTempLimit })),
  ...both((p) => lineGraph({ id: `gear_brk_${p}`, title: `Gear, Brake Temp vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [...BRAKES, { field: "gear", label: "Transmission gear", axis: "y2", color: "c5", stepped: true, map: decodeGear }], y1: "Brake temperature (°C)", y2: "Transmission gear", limits: brakeTempLimit })),
  ...both((p) =>
    lineGraph({
      id: `brk_sev_${p}`, title: `Speed, Brake Severity vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max",
      series: [{ field: "brkSev", label: "Brake severity (km/h/s)", color: "c1" }, SPEED], needs: ["speed"],
      y1: "Braking (km/h/sec)",
      limits: (s) => (s.limits.brakeSeverity ? [{ y: s.limits.brakeSeverity, label: "Normal brake life limit", color: "bad" }] : []),
      note: "Brake severity = deceleration while the retarder/brake is applied.",
    })
  ),
  ...both((p) => lineGraph({ id: `speed_gear_${p}`, title: `Speed, Gear vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [{ field: "gear", label: "Transmission gear", color: "c1", stepped: true, map: decodeGear }, { field: "retarder", label: "Retarder (on)", color: "c3", stepped: true, map: (v) => (v ? 1 : 0) }, SPEED], needs: ["gear"], y1: "Gear / retarder" })),
  ...both((p) => lineGraph({ id: `fuel_inst_${p}`, title: `Speed, Instantaneous Fuel Rate vs Distance (${cap(p)})`, phase: p, x: "dist", series: [{ field: "fuel", label: "Inst. fuel rate (l/s)", color: "c1" }, SPEED], y1: "Fuel rate (l/sec)" })),
  ...both((p) => lineGraph({ id: `fuel_cum_${p}`, title: `Speed, Cumulative Fuel vs Distance (${cap(p)})`, phase: p, x: "dist", agg: "max", series: [{ field: "fuelCum", label: "Cumulative fuel (l)", color: "c1" }, SPEED], needs: ["fuel"], y1: "Cumulative fuel (litres)" })),
  ...both((p) => lineGraph({ id: `throttle_${p}`, title: `Speed, Throttle Position vs Distance (${cap(p)})`, phase: p, x: "dist", series: [{ field: "throttle", label: "Throttle position (%)", color: "c1" }, SPEED], y1: "Throttle position (%)" })),
];

export function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
