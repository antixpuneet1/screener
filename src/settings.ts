import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { appDir } from "./bootstrap.js";

/**
 * User settings entered through the in-app settings page, persisted next to the
 * executable so a packaged .exe user never has to hand-edit .env.
 *
 * Precedence: these values override the corresponding .env / environment values,
 * because they represent the most recent explicit action the user took. Anything
 * left unset here falls through to .env, then to the built-in defaults.
 */
export interface UserSettings {
  provider?: string;
  upstoxAccessToken?: string;
  refreshIntervalMs?: number;
  ignoreMarketHours?: boolean;
}

const SETTINGS_FILENAME = "settings.json";

function settingsPath(): string {
  return path.join(appDir(), SETTINGS_FILENAME);
}

let cached: UserSettings | null = null;

export function loadSettings(): UserSettings {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as UserSettings;
    cached = sanitize(parsed);
  } catch {
    // Missing or unreadable settings file is the normal first-run case.
    cached = {};
  }
  return cached;
}

/** Drops unknown keys and coerces types, so a hand-edited or corrupted file can't
 *  inject arbitrary values into the running config. */
function sanitize(input: UserSettings): UserSettings {
  const out: UserSettings = {};
  if (input.provider === "upstox" || input.provider === "mock") out.provider = input.provider;
  if (typeof input.upstoxAccessToken === "string" && input.upstoxAccessToken.trim() !== "") {
    out.upstoxAccessToken = input.upstoxAccessToken.trim();
  }
  if (typeof input.refreshIntervalMs === "number" && Number.isFinite(input.refreshIntervalMs)) {
    // Floor guards against a typo (e.g. 20 instead of 20000) hammering the provider's
    // rate limit with a scan every few milliseconds.
    out.refreshIntervalMs = Math.max(5_000, Math.floor(input.refreshIntervalMs));
  }
  if (typeof input.ignoreMarketHours === "boolean") out.ignoreMarketHours = input.ignoreMarketHours;
  return out;
}

export function saveSettings(next: UserSettings): UserSettings {
  const merged = sanitize({ ...loadSettings(), ...next });
  const file = settingsPath();
  // mode 0600: the file holds an access token, so keep it readable only by its owner.
  // (On Windows the mode is largely advisory; see the security note in the README.)
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort - some filesystems (and Windows) reject chmod; not fatal.
  }
  cached = merged;
  return merged;
}

/** Clears the stored Upstox token (leaving other settings intact). */
export function clearToken(): UserSettings {
  const current = { ...loadSettings() };
  delete current.upstoxAccessToken;
  const file = settingsPath();
  fs.writeFileSync(file, JSON.stringify(current, null, 2), { encoding: "utf-8", mode: 0o600 });
  cached = current;
  return current;
}

/** The config actually in force: user settings layered over .env layered over defaults. */
export function effectiveConfig() {
  const s = loadSettings();
  return {
    provider: s.provider ?? config.provider,
    upstoxAccessToken: s.upstoxAccessToken ?? config.upstoxAccessToken,
    refreshIntervalMs: s.refreshIntervalMs ?? config.refreshIntervalMs,
    ignoreMarketHours: s.ignoreMarketHours ?? config.ignoreMarketHours,
  };
}

/** Last 4 characters only, for display. Never send the full token to the browser. */
export function maskToken(token: string): string {
  if (!token) return "";
  const tail = token.slice(-4);
  return `${"•".repeat(8)}${tail}`;
}

export function settingsFileLocation(): string {
  return settingsPath();
}
