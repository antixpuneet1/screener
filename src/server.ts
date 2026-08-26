import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDataProvider } from "./providers/index.js";
import { Scanner } from "./screener/scanner.js";
import { WsHub } from "./ws/hub.js";
import { isMarketOpen } from "./marketHours.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const hub = new WsHub(server);

const provider = createDataProvider();
const scanner = new Scanner(provider);

app.use(express.static(path.join(__dirname, "..", "public")));

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
  console.log(`F&O O=L screener listening on http://localhost:${config.port} (provider=${provider.name})`);
});
