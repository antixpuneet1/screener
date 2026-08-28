// Regression test for the crash seen in production:
//   "Quote batch failed (500 contracts, ...): Cannot read properties of null (reading 'open')"
// Feeds UpstoxProvider the sparse/null shapes Upstox returns for contracts that have not
// traded, and asserts one bad row can no longer take down a whole batch.
import { UpstoxProvider } from "../src/providers/UpstoxProvider.ts";

const provider = new UpstoxProvider({ accessToken: "test-token" });

// Mimic a 500-key batch: mostly untraded contracts, a few real ones, including the exact
// null-ohlc row that was crashing.
const data = {};
for (let i = 0; i < 495; i++) {
  data[`NSE_FO:DEAD${i}`] = {
    instrument_token: `NSE_FO|dead${i}`,
    ohlc: null, // <-- the crash
    last_price: 0,
    volume: 0,
    oi: 0,
  };
}
data["NSE_FO:PARTIAL"] = { instrument_token: "NSE_FO|partial", ohlc: {}, oi: null };
data["NSE_FO:MISSING_OHLC"] = { instrument_token: "NSE_FO|missing" };
data["NSE_FO:NULLROW"] = null;
data["NSE_FO:OL_HIT"] = {
  instrument_token: "NSE_FO|olhit",
  ohlc: { open: 12.5, high: 20, low: 12.5, close: 11 },
  last_price: 18.25, volume: 4200, oi: 90000,
  timestamp: "1756276200000",
};
data["NSE_FO:NOT_OL"] = {
  instrument_token: "NSE_FO|notol",
  ohlc: { open: 30, high: 33, low: 25, close: 29 },
  last_price: 31, volume: 100, oi: 500,
};

globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ data }),
  text: async () => "",
});

const quotes = await provider.getQuotes(["NSE_FO|olhit"]);

console.log("returned quotes:", quotes.size, "(untraded contracts correctly skipped)");
const hit = quotes.get("NSE_FO|olhit");
const notOl = quotes.get("NSE_FO|notol");
console.log("O=L contract parsed:", JSON.stringify(hit));
console.log("open === low ?      ", hit.open === hit.low);
console.log("non-O=L parsed:     ", notOl.open, "vs low", notOl.low, "->", notOl.open === notOl.low);
console.log("null row skipped:   ", !quotes.has("NSE_FO|dead0"));
console.log("empty ohlc skipped: ", !quotes.has("NSE_FO|partial"));
console.log("missing ohlc skipped:", !quotes.has("NSE_FO|missing"));

if (quotes.size !== 2) throw new Error(`expected 2 usable quotes, got ${quotes.size}`);
if (hit.open !== hit.low) throw new Error("O=L contract mis-parsed");
console.log("\nPASS - a null ohlc no longer fails the batch");
