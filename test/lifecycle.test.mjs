// Regression tests for two bugs that silently disabled the app.
import { RateLimiter } from "../src/rateLimiter.ts";
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

await check("dispose() releases waiters instead of hanging the cycle", async () => {
  // A settings save disposes the limiter mid-cycle. If dispose drops queued acquire()
  // promises they never settle, runCycle never returns, cycleInFlight stays true and
  // scanning stops permanently until restart.
  const rl = new RateLimiter([{ limit: 1, windowMs: 60_000 }]);
  await rl.acquire(); // consume the only slot
  const queued = rl.acquire(); // must wait

  let settled = false;
  queued.then(() => { settled = true; });

  rl.dispose();
  await Promise.race([queued, new Promise((_, rej) => setTimeout(() => rej(new Error("acquire() never settled after dispose")), 2000))]);
  if (!settled) throw new Error("acquire() did not resolve");
});

await check("a disposed limiter stops throttling instead of wedging its last cycle", async () => {
  // Releasing queued waiters is not enough: the cycle being replaced keeps calling
  // acquire(), and with the drain timer already cleared each new call would queue
  // forever. That left cycleInFlight stuck true and silently ended all scanning.
  const rl = new RateLimiter([{ limit: 1, windowMs: 60_000 }]);
  await rl.acquire();
  rl.dispose();
  await Promise.race([
    rl.acquire(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("acquire() after dispose never settled")), 2000)),
  ]);
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
