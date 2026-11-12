// Persistence: settings in localStorage, imported datasets in IndexedDB. Everything is optional —
// the app keeps working in memory if the browser blocks storage.

export const DEFAULT_LIMITS = {
  reference: "mean",
  rack: 7000,
  pitch: 7000,
  bias: 7000,
  brakeTemp: 120,
  brakeSeverity: 2.5,
};

const SKEY = "fpa.settings.v1";

export function loadSettings() {
  const brand = window.__BRAND_DEFAULT__ || {};
  const base = {
    company: brand.company || "",
    logo: brand.logo || "",
    accent: brand.accent || "#d38b00",
    site: brand.site || "",
    footer: brand.footer || "",
    theme: "",
    dayFirst: false,
    limits: { ...DEFAULT_LIMITS },
  };
  try {
    const s = JSON.parse(localStorage.getItem(SKEY) || "null");
    if (s) return { ...base, ...s, limits: { ...base.limits, ...(s.limits || {}) } };
  } catch {}
  return base;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SKEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open("fpa", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("datasets", { keyPath: "id" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) {
        rej(e);
      }
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("datasets", mode);
    const st = t.objectStore("datasets");
    const out = fn(st);
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

export async function loadDatasets() {
  try {
    return (await tx("readonly", (s) => s.getAll())) || [];
  } catch {
    return [];
  }
}
export async function putDataset(ds) {
  try {
    await tx("readwrite", (s) => s.put(ds));
  } catch {}
}
export async function deleteDataset(id) {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {}
}
