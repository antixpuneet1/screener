import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDataProvider, type DataProvider } from "./providers/index.js";
import { Scanner } from "./screener/scanner.js";
import { WsHub } from "./ws/hub.js";
import { isMarketOpen } from "./marketHours.js";
import { appDir, fatal, isPackaged, openBrowser } from "./bootstrap.js";

// This file runs three ways, each needing a different way to locate public/:
//  1. Packaged .exe (real Single Executable Application) — public/ ships as a sibling
//     folder next to the executable (see scripts/package-win.mjs).
//  2. The same esbuild CommonJS bundle run directly via plain `node build/server.cjs`
//     (used to smoke-test the bundle without packaging) — a real __dirname is available,
//     one level under the project root, same as case 3.
//  3. Native ESM, dev via tsx or `node dist/server.js` after `tsc` — only import.meta.url
//     identifies this file's location.
// `declare const` only affects the type checker; `typeof __dirname` is a safe runtime
// feature-check in all three cases. Each branch below is only *evaluated* in the case it
// handles — esbuild cannot translate import.meta.url for a CommonJS bundle (case 1/2),
// but that expression is never reached there since isPackaged/__dirname short-circuit it.
declare const __dirname: string | undefined;
const publicDir = isPackaged
  ? path.join(appDir(), "public")
  : path.join(
      typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "public",
    );

const app = express();
const server = http.createServer(app);
const hub = new WsHub(server);

let provider: DataProvider;
try {
  provider = createDataProvider();
} catch (err) {
  fatal((err as Error).message);
}
const scanner = new Scanner(provider);

app.use(express.static(publicDir));

let lastResult: Awaited<ReturnType<Scanner["runCycle"]>> | null = null;
let cycleInFlight = false;

app.get("/api/status", (_req, res) => {
  res.json({
    provider: provider.name,
    marketOpen: isMarketOpen(),
    refreshIntervalMs: config.refreshIntervalMs,
    lastResult,
  });
});

async function tick(): Promise<void> {
  if (cycleInFlight) return; // never overlap cycles if one runs long (e.g. rate-limit backoff)
  cycleInFlight = true;
  try {
    const result = await scanner.runCycle();
    lastResult = result;
    hub.broadcast({ type: "screener-update", provider: provider.name, ...result });
    if (result.errors.length > 0) {
      for (const e of result.errors) console.error("[screener]", e);
    }
    console.log(
      `[screener] cycle done: ${result.scannedContracts} contracts, ${result.hits.length} O=L hits, ${result.cycleDurationMs}ms, marketOpen=${result.marketOpen}`,
    );
  } catch (err) {
    console.error("[screener] cycle crashed:", err);
  } finally {
    cycleInFlight = false;
  }
}

setInterval(tick, config.refreshIntervalMs);
tick();

server.listen(config.port, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`F&O O=L screener listening on ${url} (provider=${provider.name})`);
  if (isPackaged || process.env.OPEN_BROWSER === "true") {
    console.log("Opening dashboard in your default browser... (close this window to stop the screener)");
    openBrowser(url);
  }
});
