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

/** Opens the default browser at `url`. Best-effort — failures are logged, not thrown. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" });
  // A missing browser-opener binary surfaces as an async 'error' event, not a throw;
  // without this listener Node treats it as an unhandled 'error' and kills the process.
  child.on("error", (err) => {
    console.error(`[screener] Could not auto-open browser (open ${url} manually): ${err.message}`);
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
