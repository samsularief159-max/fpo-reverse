// Node tests for the data model and importers. Run: npm test
import fs from "node:fs";
import assert from "node:assert/strict";
import { parseDelimited, isResultsLayout, resultsRowsFromTable, guessMapping, samplesFromTable, cyclesFromSamples, openAccess, classifyAccess, cyclesFromAsaDb } from "../src/importers.js";
import { cyclesFromResultsRows, fleetSummary, hrciRating, normMode, decodeGear, cyclesToResultsRows } from "../src/model.js";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const fx = new URL("./fixtures/", import.meta.url);

await test("mode normalisation", () => {
  assert.equal(normMode(8), "TravlLd");
  assert.equal(normMode("TRAVELING EMPTY"), "TravEmp");
  assert.equal(normMode("Dumping"), "DUMPING");
  assert.equal(normMode("StopdLd"), "StopdLd");
  assert.equal(decodeGear(147), 3);
  assert.equal(decodeGear(129), -1);
});

const csv = fs.readFileSync(new URL("sample_results.csv", fx), "utf8");
const p = parseDelimited(csv);
let legacy;
await test("legacy Results CSV import", () => {
  assert.ok(isResultsLayout(p.header));
  legacy = cyclesFromResultsRows(resultsRowsFromTable(p.header, p.data));
  assert.equal(legacy.length, 2);
  const c1 = legacy[0].stats;
  assert.equal(legacy[0].rows.length, 830);
  assert.ok(Math.abs(c1.payload - 85) < 0.01, "payload " + c1.payload);
  assert.equal(c1.passes, 4);
  assert.equal(c1.emptyTravelDist, 2407);
  assert.equal(c1.loadTravelDist, 1380);
  assert.ok(c1.complete);
});

await test("raw re-processing reproduces legacy derived values", () => {
  // Feed the legacy file through the raw (VIMS-style) path, dropping derived columns.
  const keep = ["Cycle_Time", "OP_Mode", "Speed", "Eng_Speed", "Gear", "Retarder", "Fuel_Rate", "Lt_F_Brk_Temp", "Rt_F_Brk_Temp", "Lt_R_Brk_Temp", "Rt_R_Brk_Temp", "Load_Wgt", "LF", "RF", "LR", "RR", "Throttle_Pos"];
  const idx = keep.map((k) => p.header.indexOf(k));
  const header = keep;
  const data = p.data.map((r) => idx.map((i) => r[i]));
  const map = guessMapping(header);
  assert.equal(map.time, 0); assert.equal(map.mode, 1); assert.equal(map.load, 11); assert.equal(map.lf, 12);
  const samples = samplesFromTable(header, data, map);
  const cyc = cyclesFromSamples(samples, { id: "AGC01926", model: "777D", source: "t" });
  assert.equal(cyc.length, 2);
  const a = cyc[0].stats, b = legacy[0].stats;
  assert.equal(a.passes, b.passes);
  // speed-integrated distance is within 10% of the logger's own distance channel
  assert.ok(Math.abs(a.emptyTravelDist - b.emptyTravelDist) / b.emptyTravelDist < 0.1, `${a.emptyTravelDist} vs ${b.emptyTravelDist}`);
  assert.ok(Math.abs(a.loadTravelDist - b.loadTravelDist) / b.loadTravelDist < 0.1, `${a.loadTravelDist} vs ${b.loadTravelDist}`);
  assert.ok(Math.abs(a.fuel - b.fuel) / b.fuel < 0.02, `${a.fuel} vs ${b.fuel}`);
  // composite pressures identical to legacy formula
  const r0 = cyc[0].rows[0], l0 = legacy[0].rows[0];
  assert.deepEqual([r0.rack, r0.pitch, r0.bias], [l0.rack, l0.pitch, l0.bias]);
});

await test("distance channel is used when mapped", () => {
  const keep = ["Cycle_Time", "OP_Mode", "Speed", "Load_Wgt", "Distance"];
  const idx = keep.map((k) => p.header.indexOf(k));
  const data = p.data.map((r) => idx.map((i) => r[i]));
  const map = guessMapping(keep);
  assert.equal(map.odo, 4);
  const cyc = cyclesFromSamples(samplesFromTable(keep, data, map), { id: "T", model: "", source: "t" });
  assert.ok(Math.abs(cyc[0].stats.emptyTravelDist - 2407) <= 25, String(cyc[0].stats.emptyTravelDist));
});

await test("legacy ASA .mdb work file import", async () => {
  const f = new URL("ASA_Data.mdb", fx);
  if (!fs.existsSync(f)) return console.log("   (skipped: fixture missing)");
  const buf = fs.readFileSync(f);
  const db = await openAccess(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(classifyAccess(db).kind, "asa");
  const cyc = cyclesFromAsaDb(db, "ASA_Data.mdb");
  assert.equal(cyc.length, 2);
  assert.equal(cyc[0].stats.passes, 4);
});

await test("summary, rating and export", () => {
  const s = fleetSummary(legacy);
  assert.equal(s.trucks, 1);
  assert.equal(s.loadedCycles, 1); // cycle 2 is incomplete (ends while loading)
  assert.ok(Math.abs(s.tonnes - 85) < 0.01);
  const r = hrciRating(legacy[0].stats, "loaded", { rack: 100000, pitch: 100000, bias: 100000 });
  assert.equal(r.acceptable, true);
  const r2 = hrciRating(legacy[0].stats, "loaded", { rack: 1, pitch: 1, bias: 1 });
  assert.equal(r2.acceptable, false);
  assert.equal(cyclesToResultsRows(legacy).length, 1177);
});

console.log(`\n${passed} tests passed`);
