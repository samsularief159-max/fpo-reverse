# Fleet Productivity Analyzer

A new, independent replacement for the old *Fleet Productivity Optimisation / ASA* (VB6, 2004–2007)
haul-truck analysis tool. It does the same job without the run-time restriction, old ActiveX
controls or the Jet/DAO install:

* **No install, no expiry.** One HTML file — `dist/FleetProductivityAnalyzer.html` — that opens in
  Chrome, Edge or Firefox and works fully offline. Data stays on the computer (browser storage).
* **Your company branding.** Logo, company name, brand colour, site name and report footer
  (Settings tab, or built in by default — see `branding/README.md`).
* **Reads your old data.** Old ASA/FPO work databases (`.mdb` with the `Results` table), VIMS
  databases (`DataLogger`, `DataLogger_Detail`, `ChannelConfig` …) and VIMS / TPMS text exports
  (`.csv .txt .asc .prn`) with automatic column matching.

## Features

| Area | What you get |
|---|---|
| Dashboard | Fleet KPIs (tonnes, avg payload, cycle time, t/h, passes, fuel l/t) and a per-cycle table with road ratings; CSV export and printable summary |
| Cycle analysis | Cycle segmentation from Payload Status, phase times (stopped/travel empty, loading, travel/stopped loaded, dumping), haul distances, passes, fuel |
| Graphs (27) | Payload & cycle time · Haul Road Condition Index (loaded/empty) · composite pressures (rack/pitch/bias) vs distance, time and loading time · strut pressures · speed / engine / gear vs brake temperature · brake severity · speed & gear · instantaneous and cumulative fuel · throttle |
| Limits | Configurable rack/pitch/bias management limits, max brake temperature and brake-life limit; HRCI rated Acceptable / Unacceptable |
| Output | Print selected graphs as a branded A4 report (or *Save as PDF*), save any graph as PNG, export results back to the legacy `Results` CSV layout |
| Workspace | Imported files are remembered; save/open a workspace `.json` to move between PCs |

## Using it

1. Open `dist/FleetProductivityAnalyzer.html` (double-click).
2. **Settings** → enter the company name and upload your logo; set your site's limits.
3. **Work Files** → *Import data files…* (or drag files onto the window).
4. **Dashboard** for the fleet summary, click a cycle to open its **Graphs**; tick graphs and *Print selected*.

> The default HRCI limits (±7000 kPa) and brake limits are placeholders — enter the values
> recommended for your truck models and site.

## Development

```bash
npm install
npm test        # model / importer tests against the sample data in test/fixtures
npm run build   # writes dist/FleetProductivityAnalyzer.html
```

Source: `src/model.js` (cycles & statistics), `src/importers.js` (file formats),
`src/graphs.js` (graph catalogue), `src/charts.js` (Chart.js rendering), `src/main.js` (UI).
