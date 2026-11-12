// Application shell: views, import flow, branding and printing.
import { fleetSummary, hrciRating, cyclesFromResultsRows, cyclesToResultsRows, RESULTS_COLUMNS, MODE_LABEL } from "./model.js";
import {
  parseDelimited, isResultsLayout, resultsRowsFromTable, guessMapping, samplesFromTable, cyclesFromSamples,
  guessIdentity, FIELDS, openAccess, classifyAccess, cyclesFromAsaDb, vimsLoggers, vimsChannels, vimsSamples,
} from "./importers.js";
import { GRAPHS, fmtDur } from "./graphs.js";
import { renderChart } from "./charts.js";
import { loadSettings, saveSettings, loadDatasets, putDataset, deleteDataset, DEFAULT_LIMITS } from "./store.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const f1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (ms) => {
  if (ms == null) return "";
  const d = new Date(ms);
  if (d.getUTCFullYear() < 1901) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const state = {
  settings: loadSettings(),
  datasets: [],
  cycles: [],
  errors: [],
  current: null,
  charts: [],
  selected: new Set(readLS("fpa.graphs", ["payload", "hrci_loaded", "hrci_empty", "speed_brk_loaded"])),
};

function readLS(k, def) {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? def;
  } catch {
    return def;
  }
}
function writeLS(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

function toast(msg, ms = 3500) {
  let box = $("#toasts");
  if (!box) {
    box = Object.assign(document.createElement("div"), { id: "toasts", className: "toasts" });
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------------- branding ---------------- */

function applyBranding() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty("--accent", s.accent || "#d38b00");
  root.style.setProperty("--accent-text", contrastText(s.accent || "#d38b00"));
  if (s.theme) root.setAttribute("data-theme", s.theme);
  else root.removeAttribute("data-theme");
  const name = s.company || "Your Company";
  $("#brand-company").textContent = name;
  $("#brand-logo").innerHTML = s.logo
    ? `<img src="${esc(s.logo)}" alt="${esc(name)} logo">`
    : `<span class="logo-ph" title="Add your logo in Settings">${esc(name.trim()[0] || "F")}</span>`;
  document.title = `${s.company ? s.company + " – " : ""}Fleet Productivity Analyzer`;
  $("#app-footer").textContent = `${s.company ? s.company + " · " : ""}Fleet Productivity Analyzer · runs offline · no licence expiry`;
}

function contrastText(hex) {
  const m = hex.replace("#", "").match(/.{2}/g);
  if (!m) return "#fff";
  const [r, g, b] = m.map((x) => parseInt(x, 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#111" : "#fff";
}

function bindSettings() {
  const s = state.settings;
  const set = (id, v) => ($(id).value = v ?? "");
  set("#s-company", s.company);
  set("#s-accent", s.accent);
  set("#s-site", s.site);
  set("#s-footer", s.footer);
  set("#s-theme", s.theme);
  set("#s-dayfirst", s.dayFirst ? "1" : "0");
  const L = s.limits;
  set("#s-ref", L.reference);
  set("#s-rack", L.rack);
  set("#s-pitch", L.pitch);
  set("#s-bias", L.bias);
  set("#s-bt", L.brakeTemp);
  set("#s-bs", L.brakeSeverity);
  const prev = $("#s-logo-preview");
  prev.classList.toggle("hidden", !s.logo);
  if (s.logo) prev.src = s.logo;
}

function persistSettings() {
  if (!saveSettings(state.settings)) toast("Settings could not be saved in this browser (storage blocked); they apply until you close the page.");
  applyBranding();
}

function wireSettings() {
  const txt = { "#s-company": "company", "#s-site": "site", "#s-footer": "footer" };
  for (const [id, k] of Object.entries(txt)) $(id).addEventListener("input", (e) => { state.settings[k] = e.target.value; persistSettings(); });
  $("#s-accent").addEventListener("input", (e) => { state.settings.accent = e.target.value; persistSettings(); refreshCharts(); });
  $("#s-theme").addEventListener("change", (e) => { state.settings.theme = e.target.value; persistSettings(); refreshCharts(); });
  $("#s-dayfirst").addEventListener("change", (e) => { state.settings.dayFirst = e.target.value === "1"; persistSettings(); });
  $("#s-ref").addEventListener("change", (e) => { state.settings.limits.reference = e.target.value; persistSettings(); refreshAll(); });
  const lim = { "#s-rack": "rack", "#s-pitch": "pitch", "#s-bias": "bias", "#s-bt": "brakeTemp", "#s-bs": "brakeSeverity" };
  for (const [id, k] of Object.entries(lim)) {
    $(id).addEventListener("change", (e) => {
      const v = parseFloat(e.target.value);
      state.settings.limits[k] = Number.isFinite(v) && v > 0 ? v : null;
      persistSettings();
      refreshAll();
    });
  }
  $("#s-reset").addEventListener("click", () => {
    state.settings.limits = { ...DEFAULT_LIMITS };
    persistSettings();
    bindSettings();
    refreshAll();
  });
  $("#s-logo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      state.settings.logo = await imageToDataUrl(f);
      persistSettings();
      bindSettings();
      toast("Logo updated");
    } catch (err) {
      toast("Could not read that image: " + err.message);
    }
  });
  $("#s-logo-remove").addEventListener("click", () => {
    state.settings.logo = (window.__BRAND_DEFAULT__ || {}).logo || "";
    persistSettings();
    bindSettings();
  });
}

function imageToDataUrl(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onerror = () => rej(rd.error);
    rd.onload = () => {
      const url = rd.result;
      if (/svg/.test(file.type)) return res(url);
      const img = new Image();
      img.onload = () => {
        const max = 600;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/png"));
      };
      img.onerror = () => rej(new Error("unsupported image"));
      img.src = url;
    };
    rd.readAsDataURL(file);
  });
}

/* ---------------- datasets ---------------- */

function rebuildCycles() {
  state.cycles = state.datasets.flatMap((d) => d.cycles.map((c) => ((c.dataset = d.id), c)));
  state.cycles.sort((a, b) => a.id.localeCompare(b.id) || (a.rows[0]?.t ?? 0) - (b.rows[0]?.t ?? 0) || a.cycleNo - b.cycleNo);
  if (!state.cycles.find((c) => c.key === state.current)) state.current = state.cycles[0]?.key || null;
}

async function addDataset(name, kind, cycles) {
  if (!cycles.length) {
    logError(name, "", "No truck cycles were found in this file.");
    toast(`${name}: no cycles found`);
    return;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  for (const c of cycles) c.key = `${id}|${c.key}`;
  const ds = { id, name, kind, importedAt: Date.now(), cycles };
  state.datasets.push(ds);
  await putDataset(ds);
  rebuildCycles();
  refreshAll();
  toast(`${name}: imported ${cycles.length} cycle${cycles.length > 1 ? "s" : ""} for ${new Set(cycles.map((c) => c.id)).size} truck(s)`);
}

function logError(file, line, error) {
  state.errors.push({ file, line, error });
  renderErrors();
}

function renderErrors() {
  const el = $("#error-log");
  if (!state.errors.length) return (el.textContent = "No errors.");
  el.innerHTML = `<div class="table-wrap" style="max-height:240px"><table><thead><tr><th class="l">File</th><th class="l">Line</th><th class="l">Error</th></tr></thead><tbody>${state.errors
    .map((e) => `<tr><td class="l">${esc(e.file)}</td><td class="l">${esc(e.line)}</td><td class="l">${esc(e.error)}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split(".").pop().toLowerCase();
    try {
      if (ext === "json") await importWorkspace(f);
      else if (ext === "mdb" || ext === "accdb") await importAccess(f);
      else await importText(f);
    } catch (err) {
      console.error(err);
      logError(f.name, "", err.message || String(err));
      toast(`${f.name}: ${err.message || err}`);
    }
  }
}

async function importAccess(f) {
  const db = await openAccess(await f.arrayBuffer());
  const cls = classifyAccess(db);
  if (cls.kind === "asa") return addDataset(f.name, "ASA work file", cyclesFromAsaDb(db, f.name));
  if (cls.kind === "vims") return vimsDialog(f.name, db);
  throw new Error(`Not a recognised database (tables: ${cls.names.join(", ")})`);
}

async function importText(f) {
  const text = await f.text();
  const p = parseDelimited(text);
  if (!p.data.length) throw new Error("No data rows found");
  if (isResultsLayout(p.header)) {
    return addDataset(f.name, "ASA results (text)", cyclesFromResultsRows(resultsRowsFromTable(p.header, p.data), { source: f.name }));
  }
  const ident = guessIdentity(p.preamble, f.name);
  const res = await mappingDialog(f.name, p, ident);
  if (!res) return;
  const samples = samplesFromTable(p.header, p.data, res.map, { dayFirst: state.settings.dayFirst });
  const bad = samples.filter((s) => s.speed == null && s.load == null && s.mode == null).length;
  if (bad) logError(f.name, "", `${bad} row(s) had no usable speed, payload or mode values`);
  return addDataset(f.name, "Data logger export", cyclesFromSamples(samples, { id: res.id, model: res.model, source: f.name }));
}

function mappingDialog(name, p, ident) {
  const dlg = $("#dlg-map");
  $("#map-title").textContent = `Map columns – ${name}`;
  $("#map-sub").textContent = `${p.data.length.toLocaleString()} rows, ${p.header.length} columns. Columns were matched automatically; check and adjust as needed.`;
  $("#map-id").value = ident.id;
  $("#map-model").value = ident.model;
  const guess = guessMapping(p.header);
  const opts = `<option value="">— not in file —</option>` + p.header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join("");
  $("#map-rows").innerHTML = FIELDS.map((fl) => `<tr><td>${esc(fl.label)}</td><td><select data-k="${fl.key}">${opts}</select></td><td class="small muted" data-prev="${fl.key}"></td></tr>`).join("");
  const preview = (sel) => {
    const i = sel.value;
    $(`[data-prev="${sel.dataset.k}"]`).textContent = i === "" ? "" : p.data.slice(0, 4).map((r) => r[i]).join(" · ");
  };
  $$("#map-rows select").forEach((sel) => {
    if (guess[sel.dataset.k] != null) sel.value = String(guess[sel.dataset.k]);
    preview(sel);
    sel.onchange = () => preview(sel);
  });
  return new Promise((res) => {
    const done = (v) => {
      dlg.close();
      res(v);
    };
    $("#map-cancel").onclick = () => done(null);
    dlg.oncancel = () => res(null);
    $("#map-ok").onclick = () => {
      const map = {};
      $$("#map-rows select").forEach((sel) => sel.value !== "" && (map[sel.dataset.k] = +sel.value));
      if (map.speed == null && map.load == null && map.mode == null) return toast("Map at least ground speed, payload or payload status.");
      done({ map, id: $("#map-id").value.trim() || name, model: $("#map-model").value.trim() });
    };
    dlg.showModal();
  });
}

function vimsDialog(name, db) {
  const dlg = $("#dlg-vims");
  const loggers = vimsLoggers(db);
  $("#vims-sub").textContent = `${name} – ${loggers.length} data logger download(s)`;
  $("#vims-loggers").innerHTML = loggers
    .map((l, i) => `<tr><td><input type="checkbox" data-i="${i}" ${i === 0 ? "checked" : ""}></td><td>${esc(l.EqptNo)}</td><td>${esc(l.Model_Code)}</td><td>${esc(l.Serial_Number)}</td><td>${esc(fmtDate(+l.DownloadDate))}</td><td>${esc(l.DataLoggerID)}</td></tr>`)
    .join("");
  const fieldOpts = `<option value="">— ignore —</option>` + FIELDS.filter((f) => !["id", "date", "time"].includes(f.key)).map((f) => `<option value="${f.key}">${esc(f.label)}</option>`).join("");
  const maps = {};
  const showChannels = (model) => {
    const ch = vimsChannels(db, model);
    $("#vims-channels").innerHTML = ch.map((c) => `<tr><td>${c.position}</td><td>${c.channel}</td><td>${esc(c.desc)}</td><td><select data-pos="${c.position}">${fieldOpts}</select></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No channel configuration for model ${esc(model)}</td></tr>`;
    $$("#vims-channels select").forEach((sel) => {
      const c = ch.find((x) => String(x.position) === sel.dataset.pos);
      sel.value = maps[model]?.[sel.dataset.pos] ?? c.guess;
      sel.onchange = () => ((maps[model] = maps[model] || {}), (maps[model][sel.dataset.pos] = sel.value));
    });
    $("#vims-channels").dataset.model = model;
  };
  const firstModel = loggers[0]?.Model_Code || "";
  showChannels(firstModel);
  $("#vims-loggers").onchange = (e) => {
    const l = loggers[+e.target.dataset.i];
    if (e.target.checked && l && l.Model_Code !== $("#vims-channels").dataset.model) showChannels(l.Model_Code);
  };
  return new Promise((res) => {
    $("#vims-cancel").onclick = () => (dlg.close(), res());
    dlg.oncancel = () => res();
    $("#vims-ok").onclick = async () => {
      const model = $("#vims-channels").dataset.model;
      maps[model] = Object.fromEntries($$("#vims-channels select").map((s) => [s.dataset.pos, s.value]));
      const chosen = $$("#vims-loggers input:checked").map((x) => loggers[+x.dataset.i]);
      if (!chosen.length) return toast("Select at least one download");
      dlg.close();
      const cycles = [];
      for (const l of chosen) {
        const pm = maps[l.Model_Code] || Object.fromEntries(vimsChannels(db, l.Model_Code).map((c) => [c.position, c.guess]));
        const samples = vimsSamples(db, l.DataLoggerID, pm);
        if (!samples.length) logError(name, `Logger ${l.DataLoggerID}`, "No data rows for this download");
        cycles.push(...cyclesFromSamples(samples, { id: String(l.EqptNo), model: l.Model_Code, source: name }));
      }
      await addDataset(name, "VIMS database", cycles);
      res();
    };
    dlg.showModal();
  });
}

/* ---------------- workspace ---------------- */

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stripCycle(c) {
  const { dataset, ...rest } = c;
  return rest;
}

function saveWorkspace() {
  if (!state.datasets.length) return toast("Nothing to save yet – import some data first.");
  const ws = { app: "fleet-productivity-analyzer", version: 1, savedAt: Date.now(), datasets: state.datasets.map((d) => ({ ...d, cycles: d.cycles.map(stripCycle) })) };
  download(`workspace-${new Date().toISOString().slice(0, 10)}.fpa.json`, JSON.stringify(ws), "application/json");
}

async function importWorkspace(f) {
  const ws = JSON.parse(await f.text());
  if (ws.app !== "fleet-productivity-analyzer" || !Array.isArray(ws.datasets)) throw new Error("Not a Fleet Productivity Analyzer workspace");
  for (const d of ws.datasets) {
    if (state.datasets.some((x) => x.id === d.id)) continue;
    state.datasets.push(d);
    await putDataset(d);
  }
  rebuildCycles();
  refreshAll();
  toast(`Workspace opened: ${ws.datasets.length} work file(s)`);
}

function toCsv(rows, cols) {
  const q = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\r\n");
}

/* ---------------- views ---------------- */

function summaryRows(cycles) {
  const L = state.settings.limits;
  return cycles.map((c) => {
    const s = c.stats;
    const rl = hrciRating(s, "loaded", L);
    const re = hrciRating(s, "empty", L);
    return {
      c,
      Truck: c.id, Model: c.model, Cycle: c.cycleNo, Start: fmtDate(c.rows[0]?.t),
      "Payload (t)": s.payload, Passes: s.passes, "Cycle time": fmtDur(s.totalTime), "Load time": fmtDur(s.loadTime),
      "Empty haul (m)": s.emptyTravelDist, "Loaded haul (m)": s.loadTravelDist,
      "Avg spd loaded (km/h)": s.avgSpeedLoaded, "Avg spd empty (km/h)": s.avgSpeedEmpty,
      "Fuel (l)": s.hasFuel ? s.fuel : null, "Fuel (l/t)": s.hasFuel && s.payload ? s.fuelPerTonne : null,
      "t/h": s.tph, "Max brake (°C)": s.maxBrakeTemp,
      "Road loaded": rl ? (rl.acceptable ? "Acceptable" : "Unacceptable") : "", "Road empty": re ? (re.acceptable ? "Acceptable" : "Unacceptable") : "",
    };
  });
}

function renderDashboard() {
  const sel = $("#dash-truck");
  const trucks = [...new Set(state.cycles.map((c) => c.id))];
  const cur = sel.value;
  sel.innerHTML = `<option value="">All trucks</option>` + trucks.map((t) => `<option ${t === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  const cycles = state.cycles.filter((c) => !sel.value || c.id === sel.value);
  const s = fleetSummary(cycles);
  const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $("#kpis").innerHTML = cycles.length
    ? [
        kpi(s.trucks, "Trucks"), kpi(s.loadedCycles, "Loaded cycles"), kpi(f1(s.tonnes, 0), "Tonnes hauled"),
        kpi(f1(s.avgPayload), "Avg payload (t)"), kpi(fmtDur(s.avgCycleTime), "Avg cycle time"), kpi(f1(s.tph, 0), "Tonnes / hour (per truck)"),
        kpi(f1(s.avgPasses), "Avg passes"), kpi(s.fuel ? f1(s.fuelPerTonne, 3) : "–", "Fuel (l/t)"),
      ].join("")
    : "";
  if (!cycles.length) {
    $("#dash-table").innerHTML = `<div class="card empty">No data yet. Go to <b>Work Files</b> and import your truck data (old ASA/FPO .mdb work files, VIMS databases or VIMS/TPMS text exports).</div>`;
    return;
  }
  const rows = summaryRows(cycles);
  const cols = Object.keys(rows[0]).filter((k) => k !== "c");
  const cell = (k, v) => {
    if (k.startsWith("Road")) return v ? `<span class="pill ${v === "Acceptable" ? "good" : "bad"}">${v}</span>` : `<span class="pill na">n/a</span>`;
    if (typeof v === "number") return f1(v, /\(t\)|km\/h|l\)$/.test(k) ? 1 : /l\/t/.test(k) ? 3 : 0);
    return esc(v ?? "–");
  };
  $("#dash-table").innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th class="${i < 4 ? "l" : ""}">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr class="clickable" data-key="${esc(r.c.key)}" title="Open graphs for this cycle">${cols.map((c, i) => `<td class="${i < 4 ? "l" : ""}">${cell(c, r[c])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div><p class="small muted">Click a cycle to open its graphs. Tonnes/hour = payload ÷ cycle time for each truck.</p>`;
  $$("#dash-table tr[data-key]").forEach((tr) => tr.addEventListener("click", () => {
    state.current = tr.dataset.key;
    show("graphs");
  }));
}

function renderFiles() {
  const el = $("#files-list");
  if (!state.datasets.length) {
    el.innerHTML = `<div class="empty">No work files imported.</div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th class="l">File</th><th class="l">Type</th><th class="l">Trucks</th><th>Cycles</th><th class="l">Imported</th><th></th></tr></thead><tbody>${state.datasets
    .map((d) => `<tr><td class="l">${esc(d.name)}</td><td class="l">${esc(d.kind)}</td><td class="l">${esc([...new Set(d.cycles.map((c) => c.id))].join(", "))}</td><td>${d.cycles.length}</td><td class="l">${esc(new Date(d.importedAt).toLocaleString())}</td><td><button class="link" data-exp="${d.id}">Export CSV</button> · <button class="link" data-del="${d.id}" style="color:var(--bad)">Remove</button></td></tr>`)
    .join("")}</tbody></table></div>`;
  $$("[data-del]", el).forEach((b) => b.addEventListener("click", async () => {
    const d = state.datasets.find((x) => x.id === b.dataset.del);
    if (!confirm(`Remove "${d.name}" from the workspace?`)) return;
    state.datasets = state.datasets.filter((x) => x !== d);
    await deleteDataset(d.id);
    rebuildCycles();
    refreshAll();
  }));
  $$("[data-exp]", el).forEach((b) => b.addEventListener("click", () => {
    const d = state.datasets.find((x) => x.id === b.dataset.exp);
    download(d.name.replace(/\.[^.]+$/, "") + "-results.csv", toCsv(cyclesToResultsRows(d.cycles), RESULTS_COLUMNS), "text/csv");
  }));
}

function cycleLabel(c) {
  return `${c.id}${c.model ? " (" + c.model + ")" : ""} – cycle ${c.cycleNo} – ${fmtDate(c.rows[0]?.t)}`;
}

function renderGraphs() {
  const sel = $("#g-cycle");
  sel.innerHTML = state.cycles.map((c) => `<option value="${esc(c.key)}" ${c.key === state.current ? "selected" : ""}>${esc(cycleLabel(c))}</option>`).join("");
  const c = state.cycles.find((x) => x.key === state.current);
  for (const ch of state.charts) ch.destroy();
  state.charts = [];
  if (!c) {
    $("#g-list").innerHTML = "";
    $("#g-info").innerHTML = "No data imported yet.";
    $("#charts").innerHTML = "";
    return;
  }
  const order = ["Cycle", "Loaded", "Empty", "Loading"];
  const built = GRAPHS.map((g) => ({ g, spec: g.build(c, state.settings) })).sort((a, b) => order.indexOf(a.g.group) - order.indexOf(b.g.group));
  let grp = null;
  $("#g-list").innerHTML = built
    .map(({ g, spec }) => {
      const head = g.group !== grp ? `<div class="grp">${esc((grp = g.group))}</div>` : "";
      return `${head}<label class="${spec ? "" : "na"}" title="${spec ? "" : "No data for this graph in the selected cycle"}"><input type="checkbox" data-g="${g.id}" ${state.selected.has(g.id) ? "checked" : ""}> <span>${esc(g.title)}</span></label>`;
    })
    .join("");
  $$("#g-list input").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? state.selected.add(cb.dataset.g) : state.selected.delete(cb.dataset.g);
    writeLS("fpa.graphs", [...state.selected]);
    renderGraphs();
  }));
  const s = c.stats;
  const modeTimes = ["StopEmp", "TravEmp", "LOADING", "TravlLd", "StopdLd", "DUMPING"]
    .map((m) => `${MODE_LABEL[m]} ${fmtDur(s[{ StopEmp: "emptyStopTime", TravEmp: "emptyTravelTime", LOADING: "loadTime", TravlLd: "loadTravelTime", StopdLd: "loadStopTime", DUMPING: "dumpTime" }[m]])}`)
    .join(" · ");
  $("#g-info").innerHTML = `<b>${esc(cycleLabel(c))}</b><br>Payload <b>${f1(s.payload)} t</b> in ${s.passes} passes · cycle ${fmtDur(s.totalTime)} · empty haul ${f1(s.emptyTravelDist, 0)} m · loaded haul ${f1(s.loadTravelDist, 0)} m${s.hasFuel ? ` · fuel ${f1(s.fuel)} l` : ""}${s.complete ? "" : ` · <span style="color:var(--bad)">incomplete cycle</span>`}<br><span class="muted">${modeTimes}</span>`;
  const wanted = built.filter(({ g }) => state.selected.has(g.id));
  const holder = $("#charts");
  holder.innerHTML = "";
  if (!wanted.length) holder.innerHTML = `<div class="card empty">Tick one or more graphs on the left.</div>`;
  for (const { g, spec } of wanted) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<div class="hd"><h3>${esc(g.title)}</h3>${spec ? `<button class="link small" data-png>Save PNG</button>` : ""}</div><div class="sub">${esc(spec?.subtitle || "")}</div>`;
    if (!spec) {
      card.innerHTML += `<div class="empty small">No data for this graph in this cycle (the file may not contain the required channel).</div>`;
    } else {
      const box = document.createElement("div");
      box.className = "box";
      const cv = document.createElement("canvas");
      box.appendChild(cv);
      card.appendChild(box);
      if (spec.note) card.insertAdjacentHTML("beforeend", `<div class="note ${spec.rating ? (spec.rating.acceptable ? "good" : "bad") : "muted"}">${esc(spec.note)}</div>`);
      holder.appendChild(card);
      const chart = renderChart(cv, spec);
      state.charts.push(chart);
      $("[data-png]", card).addEventListener("click", async () => {
        const url = await chartImage(g, spec, c);
        const a = Object.assign(document.createElement("a"), { href: url, download: `${c.id}-cycle${c.cycleNo}-${g.id}.png` });
        a.click();
      });
      continue;
    }
    holder.appendChild(card);
  }
}

/* ---------------- printing ---------------- */

/** Render a chart offscreen at print resolution and return a PNG data URL. */
function chartImage(g, spec, c) {
  const cv = document.createElement("canvas");
  cv.width = 1600;
  cv.height = 760;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-99999px;top:0;width:1600px;height:760px";
  wrap.appendChild(cv);
  document.body.appendChild(wrap);
  const ch = renderChart(cv, spec, { print: true });
  const ctx = cv.getContext("2d");
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const url = cv.toDataURL("image/png");
  ch.destroy();
  wrap.remove();
  return Promise.resolve(url);
}

function reportHeader(title, sub) {
  const s = state.settings;
  return `<div class="rpt-head">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ""}<div class="t"><b>${esc(title)}</b><span>${esc(sub || "")}</span></div><div class="meta">${esc(s.company || "")}${s.site ? "<br>" + esc(s.site) : ""}<br>Printed ${esc(new Date().toLocaleString())}</div></div>`;
}
const reportFooter = () => `<div class="rpt-foot">${esc(state.settings.footer || "")} ${state.settings.footer ? "· " : ""}Fleet Productivity Analyzer</div>`;

async function printGraphs() {
  const c = state.cycles.find((x) => x.key === state.current);
  if (!c) return toast("No cycle selected");
  const pages = [];
  for (const g of GRAPHS.filter((x) => state.selected.has(x.id))) {
    const spec = g.build(c, state.settings);
    if (!spec) continue;
    const img = await chartImage(g, spec, c);
    pages.push(`<div class="rpt-page">${reportHeader(g.title, `${cycleLabel(c)} · ${spec.subtitle || ""}`)}<img class="rpt-chart" src="${img}" alt="">${spec.note ? `<div class="rpt-note">${esc(spec.note)}</div>` : ""}${reportFooter()}</div>`);
  }
  if (!pages.length) return toast("None of the selected graphs have data for this cycle.");
  $("#print-root").innerHTML = pages.join("");
  await waitImages($("#print-root"));
  window.print();
}

async function printSummary() {
  const sel = $("#dash-truck").value;
  const cycles = state.cycles.filter((c) => !sel || c.id === sel);
  if (!cycles.length) return toast("No data to print");
  const rows = summaryRows(cycles);
  const cols = Object.keys(rows[0]).filter((k) => k !== "c");
  const s = fleetSummary(cycles);
  const fmt = (v) => (typeof v === "number" ? f1(v, Math.abs(v) < 10 ? 2 : 0) : esc(v ?? "–"));
  $("#print-root").innerHTML = `<div class="rpt-page">${reportHeader("Fleet Productivity Summary", sel ? `Truck ${sel}` : "All trucks")}
    <p>${s.trucks} truck(s) · ${s.loadedCycles} loaded cycles · ${f1(s.tonnes, 0)} t hauled · avg payload ${f1(s.avgPayload)} t · avg cycle ${fmtDur(s.avgCycleTime)} · ${f1(s.tph, 0)} t/h per truck</p>
    <table class="rpt-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${fmt(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>${reportFooter()}</div>`;
  await waitImages($("#print-root"));
  window.print();
}

function waitImages(el) {
  return Promise.all($$("img", el).map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
}

/* ---------------- navigation ---------------- */

function show(view) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$("section.view").forEach((s) => s.classList.toggle("active", s.id === `view-${view}`));
  if (view === "graphs") renderGraphs();
  writeLS("fpa.view", view);
}

function refreshCharts() {
  if ($("#view-graphs").classList.contains("active")) renderGraphs();
}

function refreshAll() {
  renderDashboard();
  renderFiles();
  refreshCharts();
}

async function init() {
  applyBranding();
  bindSettings();
  wireSettings();
  $("#about").innerHTML = `Fleet Productivity Analyzer is a fresh, independent application for analysing haul-truck cycle data: payload and passes, cycle times,
    haul road condition (rack / pitch / bias), strut pressures, brake temperatures and severity, gear, fuel and throttle. It reads legacy ASA/FPO work databases,
    VIMS databases and VIMS/TPMS text exports. It runs entirely in your browser, works offline, stores data only on this computer, and has no licence or run-time expiry.`;
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  $("#file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await importFiles(files);
  });
  $("#ws-open").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await importFiles(files);
  });
  $("#ws-save").addEventListener("click", saveWorkspace);
  $("#log-clear").addEventListener("click", () => ((state.errors = []), renderErrors()));
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over"))));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove("over"))));
  document.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      show("files");
      importFiles([...e.dataTransfer.files]);
    }
  });
  $("#dash-truck").addEventListener("change", renderDashboard);
  $("#dash-export").addEventListener("click", () => {
    const rows = summaryRows(state.cycles.filter((c) => !$("#dash-truck").value || c.id === $("#dash-truck").value));
    if (!rows.length) return toast("No data to export");
    const cols = Object.keys(rows[0]).filter((k) => k !== "c");
    download("fleet-summary.csv", toCsv(rows, cols), "text/csv");
  });
  $("#dash-print").addEventListener("click", printSummary);
  $("#g-cycle").addEventListener("change", (e) => ((state.current = e.target.value), renderGraphs()));
  const step = (d) => {
    const i = state.cycles.findIndex((c) => c.key === state.current);
    const n = state.cycles[i + d];
    if (n) ((state.current = n.key), renderGraphs());
  };
  $("#g-prev").addEventListener("click", () => step(-1));
  $("#g-next").addEventListener("click", () => step(1));
  $("#g-print").addEventListener("click", printGraphs);
  const pick = (fn) => {
    const c = state.cycles.find((x) => x.key === state.current);
    state.selected = new Set(GRAPHS.filter((g) => fn(g) && (!c || g.build(c, state.settings))).map((g) => g.id));
    writeLS("fpa.graphs", [...state.selected]);
    renderGraphs();
  };
  $("#g-all").addEventListener("click", () => pick(() => true));
  $("#g-none").addEventListener("click", () => pick(() => false));
  $("#g-hrci").addEventListener("click", () => pick((g) => g.id.startsWith("hrci") || g.id.startsWith("comp_dist")));
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", refreshCharts);

  state.datasets = await loadDatasets();
  state.datasets.sort((a, b) => a.importedAt - b.importedAt);
  rebuildCycles();
  refreshAll();
  show(readLS("fpa.view", "dashboard"));
}

init();
