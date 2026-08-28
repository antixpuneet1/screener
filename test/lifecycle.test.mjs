// Regression tests for two bugs that silently disabled the app.
import { sharedRateLimiter } from "../src/rateLimiter.ts";
import { UpstoxProvider } from "../src/providers/UpstoxProvider.ts";

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}: ${e.message}`);
  }
}

console.log("lifecycle:");

await check("the rate limiter is shared across rebuilds, not recreated", async () => {
  // A settings save rebuilds provider and scanner. A fresh limiter each time leaked a
  // timer and reset the request history, so it believed it had headroom Upstox had
  // already spent - and disposing the old one stranded the in-flight cycle.
  const a = sharedRateLimiter("test:key", [{ limit: 5, windowMs: 1000 }]);
  const b = sharedRateLimiter("test:key", [{ limit: 5, windowMs: 1000 }]);
  if (a !== b) throw new Error("a rebuild created a second limiter for the same API");
});

await check("an absent oi does not pin the change-in-OI baseline to zero", async () => {
  // Seeding a baseline of 0 from a missing oi makes the contract later report its whole
  // open interest as the day's change.
  const p = new UpstoxProvider({ accessToken: "t" });
  const respond = (rows) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: rows }), text: async () => "" });
  };

  // Pass 1: untraded, no oi reported at all.
  respond({ A: { instrument_token: "K", ohlc: null } });
  await p.getQuotes(["K"]);

  // Pass 2: same contract now trades, carrying 90,000 OI that was there all along.
  respond({ A: { instrument_token: "K", ohlc: { open: 5, high: 6, low: 5, close: 5 }, last_price: 6, oi: 90000, volume: 10 } });
  const q = (await p.getQuotes(["K"])).get("K");

  if (q.changeInOi === 90000) {
    throw new Error("baseline was pinned to 0; reports entire OI as the day's change");
  }
  if (q.oi !== 90000) throw new Error(`oi mis-parsed: ${q.oi}`);
});

await check("a failed refresh keeps the already-loaded contract list", async () => {
  // check() clears the cache, but be explicit: a same-day instruments-cache.json left in
  // cwd by actually running the app would otherwise short-circuit the cold-start path.
  try { (await import("node:fs")).unlinkSync("instruments-cache.json"); } catch {}
  const p = new UpstoxProvider({ accessToken: "t", instrumentsUrl: "https://x.test/a.json.gz" });
  const { gzipSync } = await import("node:zlib");
  const rows = [
    { segment: "NSE_FO", instrument_type: "CE", strike_price: 1, expiry: "2026-09-24",
      trading_symbol: "A", instrument_key: "NSE_FO|1", underlying_symbol: "A", lot_size: 1 },
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => gzipSync(Buffer.from(JSON.stringify(rows))) });
  const first = await p.getOptionInstruments();
  if (first.length !== 1) throw new Error("setup failed");

  // Force the cache stale, then make every source fail.
  p.instrumentsCachedAt = 1;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "Forbidden" });
  const second = await p.getOptionInstruments();
  if (second.length !== 1) throw new Error("a failed refresh blanked the contract list");
});

try { (await import("node:fs")).unlinkSync("instruments-cache.json"); } catch {}
if (failures > 0) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nPASS - lifecycle regressions covered");
