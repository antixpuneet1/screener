import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

function detectIsPackaged(): boolean {
  try {
    // Lazily required: node:sea only exists on Node versions that support Single
    // Executable Applications, and this file also runs unpackaged under plain Node.
    const sea = require("node:sea") as { isSea(): boolean };
    return sea.isSea();
  } catch {
    return false;
  }
}

/** True when running inside the packaged Single Executable Application (.exe) rather
 *  than plain Node (dev via tsx, or `node dist/server.js`). */
export const isPackaged = detectIsPackaged();

/** Directory containing the .exe (or the script, under plain Node) — where a
 *  user-supplied .env sitting next to the executable should be read from. */
export function appDir(): string {
  return isPackaged ? path.dirname(process.execPath) : process.cwd();
}

/** Loads .env from next to the executable/script, falling back to cwd. Call once,
 *  before anything reads process.env (config.ts does this at import time). */
export function loadEnv(): void {
  const envPath = path.join(appDir(), ".env");
  dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });
}

/**
 * Mirrors console output into screener.log beside the executable.
 *
 * The packaged app runs as a GUI-subsystem binary so Windows shows no console window
 * (see scripts/package-win.mjs) — which means stdout/stderr have nowhere to go. This
 * keeps a diagnostic trail for when something goes wrong and there is no console to
 * read it from. Truncated at startup so the file can't grow without bound.
 */
export function startFileLogging(): string | null {
  if (!isPackaged) return null;
  const logPath = path.join(appDir(), "screener.log");
  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(logPath, { flags: "w" });
  } catch {
    return null; // read-only folder: carry on without a log rather than failing to start
  }

  for (const level of ["log", "error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        stream.write(`${new Date().toISOString()} ${args.map(String).join(" ")}\n`);
      } catch {
        // never let logging break the app
      }
    };
  }
  return logPath;
}

/** Standard install locations for Chromium-based browsers on Windows. Any of these can
 *  host an "app window": a standalone window with no address bar, no tabs and its own
 *  taskbar entry, which is what makes this feel like a desktop app rather than a webpage. */
function findAppWindowHost(): string | null {
  if (process.platform !== "win32") {
    for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/pw-browsers/chromium"]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";

  const candidates = [
    // Edge ships with Windows 10/11, so in practice this first entry almost always hits.
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Opens the dashboard as a desktop app window.
 *
 * Chromium's --app mode renders the page in its own frameless window with no address
 * bar, tabs or bookmarks, and a separate --user-data-dir keeps it out of the user's
 * normal browsing session so it behaves like an independent application. Falls back to
 * the default browser only when no Chromium-based browser can be found.
 */
export function openAppWindow(url: string, onClosed?: () => void): void {
  const host = findAppWindowHost();

  if (host) {
    const profileDir = path.join(appDir(), ".app-window");
    // Not detached: the window is this app's UI, so its lifetime is the app's lifetime
    // and `onClosed` can shut the server down when the user closes it. The dedicated
    // --user-data-dir also keeps this a distinct browser process rather than a tab
    // adopted by an already-running Edge/Chrome, which is what makes exit observable.
    const child = spawn(
      host,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        "--window-size=1440,900",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { stdio: "ignore" },
    );
    child.on("error", (err) => {
      console.error(`[screener] Could not open app window (${err.message}); falling back.`);
      openInDefaultBrowser(url);
    });
    if (onClosed) child.on("exit", onClosed);
    return;
  }

  console.error("[screener] No Chromium-based browser found for an app window; using default browser.");
  openInDefaultBrowser(url);
}

function openInDefaultBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" });
  // A missing opener binary surfaces as an async 'error' event, not a throw; without this
  // listener Node treats it as an unhandled 'error' and kills the process.
  child.on("error", (err) => {
    console.error(`[screener] Could not open a window (open ${url} manually): ${err.message}`);
  });
  child.unref();
}

/** Prints a fatal startup error and, when running as a packaged .exe (where the
 *  console window would otherwise vanish instantly), waits for a keypress before
 *  exiting so the message is actually readable. */
export function fatal(message: string): never {
  console.error(`\n[screener] FATAL: ${message}\n`);
  if (isPackaged) {
    console.error("Press any key to exit...");
    try {
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    } catch {
      // no stdin available (e.g. launched without a console) — fall through and exit.
    }
  }
  process.exit(1);
}
