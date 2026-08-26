import type { DataProvider } from "../types.js";
import { MockProvider } from "./MockProvider.js";
import { UpstoxProvider } from "./UpstoxProvider.js";
import { effectiveConfig } from "../settings.js";

/**
 * Provider factory. The data source comes from the effective config (in-app settings
 * layered over .env), so saving settings can rebuild the provider without a restart:
 *   - "upstox" (default): live Upstox API, needs an access token.
 *   - "mock": simulated feed, no credentials needed, safe for local demos/testing.
 * To plug in another broker/vendor, add a class implementing DataProvider and a
 * case below — nothing else in the app needs to change.
 */
export function createDataProvider(): DataProvider {
  const eff = effectiveConfig();
  switch (eff.provider) {
    case "upstox":
      return new UpstoxProvider({ accessToken: eff.upstoxAccessToken });
    case "mock":
      return new MockProvider();
    default:
      throw new Error(
        `Unknown data provider "${eff.provider}". Supported: "upstox", "mock".`,
      );
  }
}

export type { DataProvider };
