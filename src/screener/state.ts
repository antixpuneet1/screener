import type { ScreenerHit } from "../types.js";
import { currentSessionDate } from "../marketHours.js";

/**
 * Tracks which contracts have already been flagged as O=L today, so the same
 * hit is never reported twice as "new" and so results survive across scan
 * cycles until the underlying condition genuinely stops holding.
 */
export class ScreenerState {
  private hits = new Map<string, ScreenerHit>();
  private sessionDate = currentSessionDate();

  private resetIfNewSession(): void {
    const today = currentSessionDate();
    if (today !== this.sessionDate) {
      this.sessionDate = today;
      this.hits.clear();
    }
  }

  /** Records the set of contracts satisfying O=L in the current cycle, returning the
   *  full up-to-date hit list with `isNew` set only for contracts detected this cycle. */
  applyCycle(activeKeys: Set<string>, buildHit: (key: string) => Omit<ScreenerHit, "isNew" | "firstDetectedAt">): ScreenerHit[] {
    this.resetIfNewSession();
    const now = Date.now();

    for (const key of activeKeys) {
      const existing = this.hits.get(key);
      const fresh = buildHit(key);
      if (existing) {
        this.hits.set(key, { ...fresh, isNew: false, firstDetectedAt: existing.firstDetectedAt });
      } else {
        this.hits.set(key, { ...fresh, isNew: true, firstDetectedAt: now });
      }
    }

    // Contracts no longer satisfying O=L this cycle (e.g. low dropped further) fall off the live list.
    for (const key of this.hits.keys()) {
      if (!activeKeys.has(key)) this.hits.delete(key);
    }

    return [...this.hits.values()].sort((a, b) =>
      a.underlying === b.underlying
        ? a.expiry === b.expiry
          ? a.strike - b.strike || a.optionType.localeCompare(b.optionType)
          : a.expiry.localeCompare(b.expiry)
        : a.underlying.localeCompare(b.underlying),
    );
  }

  /** Marks isNew=false on everything after it has been broadcast once, so a contract
   *  that keeps matching across cycles is only highlighted as "new" the first time. */
  clearNewFlags(): void {
    for (const hit of this.hits.values()) hit.isNew = false;
  }
}
