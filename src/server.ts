import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDataProvider, type DataProvider } from "./providers/index.js";
import { UpstoxProvider } from "./providers/UpstoxProvider.js";
import { Scanner } from "./screener/scanner.js";
import { WsHub } from "./ws/hub.js";
import { isMarketOpen } from "./marketHours.js";
import { appDir, isPackaged, openAppWindow, startFileLogging } from "./bootstrap.js";
import {
  clearToken,
  effectiveConfig,
  loadSettings,
  maskToken,
  saveSettings,
  settingsFileLocation,
} from "./settings.js";

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

// Replaced at package time by esbuild --define (see scripts/package-win.mjs). Printed at
// startup and shown in the dashboard so which build is running is never ambiguous.
declare const __BUILD_ID__: string | undefined;
export const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

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

app.use(express.json({ limit: "16kb" }));
app.use(express.static(publicDir));

// --- Provider lifecycle -----------------------------------------------------------
// The provider is rebuilt whenever settings change, so entering a token in the UI takes
// effect without restarting. A provider that can't be built (e.g. no token yet) is NOT
// fatal: the server still runs so the user can reach the settings page and fix it.
let provider: DataProvider | null = null;
let providerError: string | null = null;
let scanner: Scanner | null = null;
let lastResult: Awaited<ReturnType<Scanner["runCycle"]>> | null = null;
let cycleInFlight = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function buildProvider(): void {
  try {
    provider = createDataProvider();
    scanner = new Scanner(provider);
    providerError = null;
    console.log(`[screener] provider ready: ${provider.name}`);
  } catch (err) {
    provider = null;
    scanner = null;
    providerError = (err as Error).message;
    lastResult = null;
    console.error(`[screener] provider not configured: ${providerError}`);
  }
}

function currentStatePayload() {
  return {
    type: "screener-update" as const,
    provider: provider?.name ?? null,
    configError: providerError,
    marketOpen: isMarketOpen(),
    refreshIntervalMs: effectiveConfig().refreshIntervalMs,
    hits: lastResult?.hits ?? [],
    scannedContracts: lastResult?.scannedContracts ?? 0,
    cycleStartedAt: lastResult?.cycleStartedAt ?? null,
    cycleDurationMs: lastResult?.cycleDurationMs ?? 0,
    errors: lastResult?.errors ?? [],
  };
}

async function tick(): Promise<void> {
  if (!scanner || cycleInFlight) return; // no provider yet, or a cycle is still running
  cycleInFlight = true;
  try {
    const result = await scanner.runCycle();
    lastResult = result;
    hub.broadcast(currentStatePayload());
    for (const e of result.errors) console.error("[screener]", e);
    console.log(
      `[screener] cycle done: ${result.scannedContracts} contracts, ${result.hits.length} O=L hits, ${result.cycleDurationMs}ms, marketOpen=${result.marketOpen}`,
    );
  } catch (err) {
    console.error("[screener] cycle crashed:", err);
  } finally {
    cycleInFlight = false;
  }
}

function restartTicker(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, effectiveConfig().refreshIntervalMs);
}

// --- API --------------------------------------------------------------------------

app.get("/api/status", (_req, res) => {
  res.json({
    provider: provider?.name ?? null,
    configError: providerError,
    marketOpen: isMarketOpen(),
    refreshIntervalMs: effectiveConfig().refreshIntervalMs,
    lastResult,
  });
});

/** Current settings for the UI. The access token is never returned in full — only
 *  whether one is set and its last 4 characters. */
app.get("/api/settings", (_req, res) => {
  const eff = effectiveConfig();
  const stored = loadSettings();
  res.json({
    provider: eff.provider,
    refreshIntervalMs: eff.refreshIntervalMs,
    ignoreMarketHours: eff.ignoreMarketHours,
    tokenSet: Boolean(eff.upstoxAccessToken),
    tokenMasked: maskToken(eff.upstoxAccessToken),
    tokenSource: stored.upstoxAccessToken ? "settings" : eff.upstoxAccessToken ? "env" : "none",
    settingsFile: settingsFileLocation(),
    configError: providerError,
    buildId: BUILD_ID,
  });
});

/** Validates a token against Upstox without saving it, for the "Test" button. */
app.post("/api/settings/test", async (req, res) => {
  const token = typeof req.body?.upstoxAccessToken === "string" ? req.body.upstoxAccessToken : "";
  const candidate = token.trim() || effectiveConfig().upstoxAccessToken;
  const result = await UpstoxProvider.validateToken(candidate);
  res.json(result);
});

app.post("/api/settings", async (req, res) => {
  const body = req.body ?? {};
  const next: Parameters<typeof saveSettings>[0] = {};

  if (body.provider === "upstox" || body.provider === "mock") next.provider = body.provider;
  if (typeof body.refreshIntervalMs === "number") next.refreshIntervalMs = body.refreshIntervalMs;
  if (typeof body.ignoreMarketHours === "boolean") next.ignoreMarketHours = body.ignoreMarketHours;
  // An omitted/blank token means "leave the existing one alone", so the user can change
  // other settings without re-entering their token.
  if (typeof body.upstoxAccessToken === "string" && body.upstoxAccessToken.trim() !== "") {
    next.upstoxAccessToken = body.upstoxAccessToken.trim();
  }

  try {
    saveSettings(next);
  } catch (err) {
    res.status(500).json({ ok: false, message: `Could not save settings: ${(err as Error).message}` });
    return;
  }

  buildProvider();
  restartTicker();
  void tick();
  hub.broadcast(currentStatePayload());

  res.json({ ok: true, configError: providerError });
});

app.post("/api/settings/clear-token", (_req, res) => {
  try {
    clearToken();
  } catch (err) {
    res.status(500).json({ ok: false, message: (err as Error).message });
    return;
  }
  buildProvider();
  hub.broadcast(currentStatePayload());
  res.json({ ok: true, configError: providerError });
});

// --- Startup ----------------------------------------------------------------------

buildProvider();
restartTicker();
void tick();

const logPath = startFileLogging();

/**
 * Listens on the first free port at or after `config.port`.
 *
 * The packaged app has no console window, so a hard exit on EADDRINUSE (a stale copy
 * still running, or anything else on 4000) would look like the app silently doing
 * nothing. Stepping to the next port keeps it launchable instead.
 */
function listenOnFreePort(startPort: number, attemptsLeft = 10): void {
  // Bound to loopback deliberately: the dashboard accepts an Upstox access token, so it
  // must not be reachable from other machines on the network.
  server.listen(startPort, "127.0.0.1");

  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`[screener] Port ${startPort} is busy, trying ${startPort + 1}...`);
      listenOnFreePort(startPort + 1, attemptsLeft - 1);
      return;
    }
    console.error(`[screener] Could not start the server: ${err.message}`);
    process.exit(1);
  });

  server.once("listening", () => {
    const port = (server.address() as { port: number }).port;
    const url = `http://localhost:${port}`;
    console.log(`F&O O=L screener  |  build ${BUILD_ID}`);
    console.log(`Listening on ${url} (provider=${provider?.name ?? "not configured"})`);
    if (logPath) console.log(`Log file: ${logPath}`);
    if (providerError) {
      console.log("[screener] No data source configured yet — use the Settings button in the app window.");
    }
    const shouldOpen = config.openBrowser === "auto" ? isPackaged : config.openBrowser === "true";
    if (shouldOpen) {
      console.log("Opening the app window...");
      openAppWindow(url);
    }
  });
}

listenOnFreePort(config.port);
