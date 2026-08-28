import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDataProvider, type DataProvider } from "./providers/index.js";
import { UpstoxProvider } from "./providers/UpstoxProvider.js";
import { Scanner, type ScanProgress } from "./screener/scanner.js";
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
const hub = new WsHub(server, () => currentStatePayload());

app.use(express.json({ limit: "16kb" }));

/**
 * Rejects cross-origin state-changing requests.
 *
 * The server listens on localhost, but that does not make it private: any page the user
 * visits in any browser can POST to http://localhost:4000. Without this, a malicious
 * site could silently wipe the stored Upstox token or repoint the data source. Only
 * same-origin requests (the dashboard itself) are allowed to mutate anything.
 */
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();

  const origin = req.get("origin");
  const host = req.get("host");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      res.status(403).json({ ok: false, message: "Bad Origin header." });
      return;
    }
    if (originHost !== host) {
      res.status(403).json({ ok: false, message: "Cross-origin requests are not allowed." });
      return;
    }
  }
  // Browsers always send Origin on cross-origin POSTs; a missing Origin means a
  // same-origin form/fetch or a non-browser client such as curl, which is fine locally.
  next();
});

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
  // No teardown needed: rate limiters are shared per provider and outlive rebuilds, so
  // a settings save cannot strand an in-flight cycle or leak a timer.
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

let progress: ScanProgress | null = null;

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
    /** Null once a cycle has completed; non-null while one is in flight. */
    progress,
    /** False until the first cycle lands, so the UI can say "still scanning" rather
     *  than rendering an empty table as though the scan found nothing. */
    hasCompletedCycle: lastResult !== null,
  };
}

async function tick(): Promise<void> {
  if (!scanner || cycleInFlight) return; // no provider yet, or a cycle is still running
  cycleInFlight = true;
  try {
    // Throttled so a 200-batch scan doesn't flood the socket with updates.
    let lastPush = 0;
    const result = await scanner.runCycle((p) => {
      progress = p;
      const now = Date.now();
      if (now - lastPush > 1000) {
        lastPush = now;
        hub.broadcast(currentStatePayload());
      }
    });
    progress = null;
    lastResult = result;
    hub.broadcast(currentStatePayload());
    for (const e of result.errors) console.error("[screener]", e);
    console.log(
      `[screener] cycle done: ${result.scannedContracts} contracts, ${result.hits.length} O=L hits, ${result.cycleDurationMs}ms, marketOpen=${result.marketOpen}`,
    );
  } catch (err) {
    console.error("[screener] cycle crashed:", err);
  } finally {
    progress = null;
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

// Logging is installed first so that anything the provider reports while starting up —
// including "no token configured", the message the docs tell users to look for — is
// actually captured in screener.log.
const logPath = startFileLogging();

buildProvider();
restartTicker();
void tick();

/**
 * Listens on the first free port at or after `config.port`.
 *
 * The packaged app has no console window, so a hard exit on EADDRINUSE (a stale copy
 * still running, or anything else on 4000) would look like the app silently doing
 * nothing. Stepping to the next port keeps it launchable instead.
 */
function listenOnFreePort(startPort: number, attemptsLeft = 10): void {
  // Remove only this function's own handlers between attempts. A `once` listener that
  // never fired stays attached, so without this every stale "listening" handler fires at
  // once after a retry — printing the banner twice and opening two app windows. Named
  // references rather than removeAllListeners(): the WebSocket server attaches its own
  // "listening"/"error" handlers to this same http.Server, and clearing those would
  // break /ws.
  const onError = (err: NodeJS.ErrnoException): void => {
    cleanup();
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`[screener] Port ${startPort} is busy, trying ${startPort + 1}...`);
      listenOnFreePort(startPort + 1, attemptsLeft - 1);
      return;
    }
    console.error(`[screener] Could not start the server: ${err.message}`);
    process.exit(1);
  };
  const onReady = (): void => {
    cleanup();
    onListening();
  };
  const cleanup = (): void => {
    server.off("error", onError);
    server.off("listening", onReady);
  };

  server.once("error", onError);
  server.once("listening", onReady);

  // Bound to loopback deliberately: the dashboard accepts an Upstox access token, so it
  // must not be reachable from other machines on the network.
  server.listen(startPort, "127.0.0.1");
}

function onListening(): void {
  const port = (server.address() as { port: number }).port;
  const url = `http://localhost:${port}`;
  console.log(`F&O O=L screener  |  build ${BUILD_ID}`);
  console.log(`Listening on ${url} (provider=${provider?.name ?? "not configured"})`);
  if (logPath) console.log(`Log file: ${logPath}`);
  if (providerError) {
    console.log(`[screener] Not configured: ${providerError}`);
    console.log("[screener] Use the Settings button in the app window to add your Upstox token.");
  }
  const shouldOpen = config.openBrowser === "auto" ? isPackaged : config.openBrowser === "true";
  if (shouldOpen) {
    console.log("Opening the app window...");
    // Quitting the app window shuts the server down. Without this the process survives
    // with no console and no window, so every relaunch orphans another copy holding a
    // port — and several orphans then scan the same account in parallel.
    openAppWindow(url, () => {
      console.log("[screener] App window closed — shutting down.");
      process.exit(0);
    });
  }
}

listenOnFreePort(config.port);
