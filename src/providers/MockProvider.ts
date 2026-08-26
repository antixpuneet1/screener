import type { DataProvider, OptionInstrument, OptionQuote } from "../types.js";
import { MOCK_FNO_UNDERLYINGS } from "./fnoStockSeed.js";
import { currentSessionDate } from "../marketHours.js";

interface SimState {
  open: number;
  low: number;
  high: number;
  ltp: number;
  volume: number;
  oi: number;
  prevDayOi: number;
  /** Some contracts drift upward all session so open=low naturally persists, like real thin-strike behavior. */
  upwardBias: boolean;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

const EXPIRIES_AHEAD = 3;
const STRIKES_PER_SIDE = 4;

function nextWeeklyExpiries(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  // roll to next Thursday
  const day = d.getUTCDay();
  const daysToThu = (4 - day + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysToThu);
  for (let i = 0; i < count; i++) {
    out.push(new Date(d.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Simulated live data source: generates the full 208-stock F&O universe with
 * multiple strikes/expiries per side, plus a continuously-updating live quote feed.
 * Used out of the box (DATA_PROVIDER=mock) so the screener is fully runnable and
 * demonstrable without live broker credentials. Swap for KiteProvider (or a new
 * provider implementing DataProvider) to go live.
 */
export class MockProvider implements DataProvider {
  readonly name = "mock";
  readonly maxQuoteBatchSize = 500;
  readonly quoteRateLimitPerSecond = 10;

  private instruments: OptionInstrument[] = [];
  private state = new Map<string, SimState>();
  private sessionDate = currentSessionDate();

  async getOptionInstruments(): Promise<OptionInstrument[]> {
    this.resetForNewSessionIfNeeded();
    if (this.instruments.length > 0) return this.instruments;

    const expiries = nextWeeklyExpiries(EXPIRIES_AHEAD);
    const instruments: OptionInstrument[] = [];

    for (const underlying of MOCK_FNO_UNDERLYINGS) {
      const rnd = mulberry32(hashString(underlying));
      const basePrice = 100 + rnd() * 2900;
      const strikeStep = basePrice > 2000 ? 50 : basePrice > 500 ? 20 : 5;

      for (const expiry of expiries) {
        for (let i = -STRIKES_PER_SIDE; i <= STRIKES_PER_SIDE; i++) {
          const strike = Math.round((basePrice + i * strikeStep) / strikeStep) * strikeStep;
          for (const optionType of ["CE", "PE"] as const) {
            const tradingSymbol = `${underlying}${expiry.replace(/-/g, "").slice(2)}${strike}${optionType}`;
            const instrumentToken = tradingSymbol;
            instruments.push({
              instrumentToken,
              underlying,
              optionType,
              strike,
              expiry,
              tradingSymbol,
              lotSize: 500,
            });
          }
        }
      }
    }

    this.instruments = instruments;
    return instruments;
  }

  async getQuotes(instrumentTokens: string[]): Promise<Map<string, OptionQuote>> {
    this.resetForNewSessionIfNeeded();
    const now = new Date();
    const out = new Map<string, OptionQuote>();

    for (const token of instrumentTokens) {
      let s = this.state.get(token);
      const rnd = mulberry32(hashString(token + this.sessionDate));

      if (!s) {
        const openPrice = Math.max(0.5, rnd() * 300 + 5);
        const upwardBias = rnd() < 0.18;
        s = {
          open: Number(openPrice.toFixed(2)),
          low: Number(openPrice.toFixed(2)),
          high: Number(openPrice.toFixed(2)),
          ltp: Number(openPrice.toFixed(2)),
          volume: Math.floor(rnd() * 5000),
          oi: Math.floor(rnd() * 200_000),
          prevDayOi: Math.floor(rnd() * 200_000),
          upwardBias,
        };
        // Simulate the ticks that would already have happened between the exchange
        // open and "now", so the mock's open/low relationship looks like a real
        // mid-session snapshot instead of every contract trivially starting at open=low.
        const warmupTicks = 15 + Math.floor(rnd() * 30);
        for (let i = 0; i < warmupTicks; i++) {
          const drift = upwardBias ? 0.6 : 0;
          const pctMove = (rnd() - 0.5 + drift) * 0.03;
          s.ltp = Math.max(0.05, Number((s.ltp * (1 + pctMove)).toFixed(2)));
          s.low = Math.min(s.low, s.ltp);
          s.high = Math.max(s.high, s.ltp);
        }
        this.state.set(token, s);
      }

      const tickRnd = Math.random();
      const drift = s.upwardBias ? 0.6 : 0;
      const pctMove = (tickRnd - 0.5 + drift) * 0.03;
      s.ltp = Math.max(0.05, Number((s.ltp * (1 + pctMove)).toFixed(2)));
      s.low = Math.min(s.low, s.ltp);
      s.high = Math.max(s.high, s.ltp);
      s.volume += Math.floor(Math.random() * 400);
      s.oi = Math.max(0, s.oi + Math.floor((Math.random() - 0.45) * 2000));

      out.set(token, {
        instrumentToken: token,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.open,
        ltp: s.ltp,
        volume: s.volume,
        oi: s.oi,
        changeInOi: s.oi - s.prevDayOi,
        timestamp: now,
      });
    }

    return out;
  }

  private resetForNewSessionIfNeeded(): void {
    const today = currentSessionDate();
    if (today !== this.sessionDate) {
      this.sessionDate = today;
      this.instruments = [];
      this.state.clear();
    }
  }
}
