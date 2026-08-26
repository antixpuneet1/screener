import { config } from "./config.js";
import { effectiveConfig } from "./settings.js";

const IST_OFFSET_MIN = 5 * 60 + 30;

function istNow(): Date {
  const utcMs = Date.now();
  return new Date(utcMs + IST_OFFSET_MIN * 60_000);
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** True on Mon-Fri between MARKET_OPEN and MARKET_CLOSE, IST. NSE holiday calendar is not modeled. */
export function isMarketOpen(): boolean {
  if (effectiveConfig().ignoreMarketHours) return true;

  const ist = istNow();
  const day = ist.getUTCDay(); // istNow() already shifted, so use UTC getters on the shifted value
  if (day === 0 || day === 6) return false;

  const minutesNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = parseHHMM(config.marketOpen);
  const close = parseHHMM(config.marketClose);
  return minutesNow >= open && minutesNow <= close;
}

/** IST calendar date string (YYYY-MM-DD), used as the trading-session key for dedupe resets. */
export function currentSessionDate(): string {
  const ist = istNow();
  return ist.toISOString().slice(0, 10);
}

export function nowIstIso(): string {
  const ist = istNow();
  return ist.toISOString().replace("Z", "+05:30");
}
