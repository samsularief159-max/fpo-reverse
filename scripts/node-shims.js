// Minimal Node globals for browser bundling (used by mdb-reader's optional decryption code).
import { Buffer } from "buffer";
export { Buffer };
export const process = { env: { NODE_ENV: "production" }, browser: true, version: "", versions: {}, nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)) };
