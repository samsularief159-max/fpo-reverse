// Chart.js rendering of graph specs produced by graphs.js.
import {
  Chart, LineController, BarController, LineElement, PointElement, BarElement,
  LinearScale, CategoryScale, Legend, Tooltip, Filler,
} from "chart.js";

Chart.register(LineController, BarController, LineElement, PointElement, BarElement, LinearScale, CategoryScale, Legend, Tooltip, Filler);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || "#888";

export function renderChart(canvas, spec, { print = false } = {}) {
  const ink = print ? "#222" : cssVar("text");
  const muted = print ? "#555" : cssVar("muted");
  const grid = print ? "#ddd" : cssVar("border");
  const col = (c) => cssVar(c);
  Chart.defaults.font.family = '"Segoe UI", system-ui, Arial, sans-serif';
  Chart.defaults.color = muted;

  const scales = {};
  const axisTitle = (t) => ({ display: !!t, text: t, color: ink, font: { weight: "600" } });
  if (spec.kind === "bar") {
    scales.x = { type: "category", grid: { color: grid } };
  } else {
    scales.x = { type: "linear", min: 0, title: axisTitle(spec.xTitle), grid: { color: grid } };
  }
  scales.y = { position: "left", title: axisTitle(spec.y1), grid: { color: grid } };
  if (spec.y2) scales.y2 = { position: "right", title: axisTitle(spec.y2), grid: { drawOnChartArea: false } };

  let datasets;
  if (spec.kind === "bar") {
    datasets = spec.series.map((s) => ({
      label: s.label, data: s.data, backgroundColor: col(s.color), borderRadius: 4, yAxisID: s.axis === "y2" ? "y2" : "y",
      maxBarThickness: 46,
    }));
  } else {
    datasets = spec.series.map((s) => ({
      label: s.label,
      data: s.data,
      borderColor: col(s.color),
      backgroundColor: col(s.color),
      borderWidth: s.axis === "y2" ? 1.5 : 1.8,
      borderDash: s.dash || [],
      pointRadius: 0,
      stepped: s.stepped ? "before" : false,
      spanGaps: true,
      yAxisID: s.axis === "y2" ? "y2" : "y",
      tension: 0,
    }));
    for (const l of spec.limits || []) {
      datasets.push({
        label: l.label || "",
        data: [{ x: 0, y: l.y }, { x: spec.xMax || 1, y: l.y }],
        borderColor: col(l.color),
        borderDash: [7, 5],
        borderWidth: 1.2,
        pointRadius: 0,
        yAxisID: l.axis || "y",
        _limit: true,
      });
    }
  }

  return new Chart(canvas, {
    type: spec.kind === "bar" ? "bar" : "line",
    data: spec.kind === "bar" ? { labels: spec.labels, datasets } : { datasets },
    options: {
      responsive: !print,
      devicePixelRatio: print ? 1 : undefined,
      maintainAspectRatio: false,
      animation: false,
      parsing: true,
      normalized: true,
      interaction: { mode: spec.kind === "bar" ? "index" : "nearest", axis: "x", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: ink, boxWidth: 14, boxHeight: 2, filter: (item, data) => !!item.text && !(data.datasets[item.datasetIndex]._limit && !item.text) },
        },
        tooltip: {
          callbacks: {
            title: (items) => (spec.kind === "bar" ? items[0]?.label : `${spec.xTitle?.split(" ")[0] || "x"}: ${Math.round(items[0]?.parsed.x)}`),
            label: (it) => `${it.dataset.label}: ${typeof it.parsed.y === "number" ? +it.parsed.y.toFixed(2) : it.parsed.y}`,
          },
        },
      },
      scales,
    },
  });
}
