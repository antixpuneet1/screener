// Covers how the contract list is obtained: browser-like headers, fallback to the
// all-exchanges file, plain-vs-gzipped bodies, and clear errors when every source fails.
import { gzipSync } from "node:zlib";
import { UpstoxProvider } from "../src/providers/UpstoxProvider.ts";
import fs from "node:fs";

const FNO_ROWS = [
  { segment: "NSE_FO", instrument_type: "CE", strike_price: 100, expiry: "2026-09-24",
    trading_symbol: "X 100 CE", instrument_key: "NSE_FO|1", underlying_symbol: "X", lot_size: 50 },
  { segment: "NSE_FO", instrument_type: "PE", strike_price: 100, expiry: "2026-09-24",
    trading_symbol: "X 100 PE", instrument_key: "NSE_FO|2", underlying_symbol: "X", lot_size: 50 },
  { segment: "NSE_EQ", instrument_type: "EQ", trading_symbol: "X", instrument_key: "NSE_EQ|9" },
];

function clearCache() {
  try { fs.unlinkSync("instruments-cache.json"); } catch {}
}

let failures = 0;
async function check(label, fn) {
  clearCache();
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}: ${e.message}`);
  }
}

function provider() {
  return new UpstoxProvider({ accessToken: "t", instrumentsUrl: "https://primary.test/NSE.json.gz" });
}

console.log("instrument loading:");

await check("sends a browser User-Agent (CDNs 403 bare Node requests)", async () => {
  let seenUA = null;
  globalThis.fetch = async (_url, opts) => {
    seenUA = opts?.headers?.["User-Agent"];
    return { ok: true, status: 200, arrayBuffer: async () => gzipSync(Buffer.from(JSON.stringify(FNO_ROWS))) };
  };
  await provider().getOptionInstruments();
  if (!seenUA || !/Mozilla/.test(seenUA)) throw new Error(`no browser UA sent (got ${seenUA})`);
});

await check("falls back to complete.json.gz when the primary 403s", async () => {
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(url);
    if (url.includes("primary.test")) return { ok: false, status: 403, text: async () => "Forbidden" };
    return { ok: true, status: 200, arrayBuffer: async () => gzipSync(Buffer.from(JSON.stringify(FNO_ROWS))) };
  };
  const r = await provider().getOptionInstruments();
  if (r.length !== 2) throw new Error(`expected 2 contracts, got ${r.length}`);
  if (tried.length !== 2) throw new Error(`expected a fallback attempt, tried ${tried.length}`);
});

await check("accepts a plain (non-gzipped) JSON body", async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(FNO_ROWS)),
  });
  const r = await provider().getOptionInstruments();
  if (r.length !== 2) throw new Error(`expected 2 contracts, got ${r.length}`);
});

await check("reports every source when all fail", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "Forbidden" });
  try {
    await provider().getOptionInstruments();
    throw new Error("should have thrown");
  } catch (e) {
    if (!/403/.test(e.message) || !/complete\.json\.gz/.test(e.message)) {
      throw new Error(`error did not name both sources: ${e.message}`);
    }
  }
});

await check("rejects an HTML error page instead of hanging", async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200, arrayBuffer: async () => Buffer.from("<html>blocked</html>"),
  });
  try {
    await provider().getOptionInstruments();
    throw new Error("should have thrown");
  } catch (e) {
    if (!/not readable JSON/.test(e.message)) throw new Error(`unexpected: ${e.message}`);
  }
});

clearCache();
if (failures > 0) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nPASS - contract list loads or explains why");
