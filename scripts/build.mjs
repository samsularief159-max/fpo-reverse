// Builds dist/FleetProductivityAnalyzer.html: one self-contained, offline HTML file.
// Optional default branding: put your logo at branding/logo.(png|jpg|svg) and details in branding/company.json.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const r = (...p) => path.join(root, ...p);

const shim = r("scripts", "node-shims.js");
const res = await build({
  entryPoints: [r("src", "main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  write: false,
  inject: [shim],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  alias: { stream: "stream-browserify" },
  logLevel: "warning",
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync(r("src", "styles.css"), "utf8");

// default branding
let brand = null;
const cj = r("branding", "company.json");
if (fs.existsSync(cj)) brand = JSON.parse(fs.readFileSync(cj, "utf8"));
const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp" };
for (const ext of Object.keys(mime)) {
  const f = r("branding", `logo.${ext}`);
  if (fs.existsSync(f)) {
    brand = brand || {};
    brand.logo = `data:${mime[ext]};base64,${fs.readFileSync(f).toString("base64")}`;
    break;
  }
}

let html = fs.readFileSync(r("src", "index.html"), "utf8");
html = html.replace("/*__CSS__*/", () => css);
html = html.replace("/*__BRAND__*/null", () => JSON.stringify(brand).replace(/</g, "\\u003c"));
html = html.replace("/*__JS__*/", () => js);
fs.mkdirSync(r("dist"), { recursive: true });
const out = r("dist", "FleetProductivityAnalyzer.html");
fs.writeFileSync(out, html);
console.log(`built ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)${brand ? " with default branding" : ""}`);
