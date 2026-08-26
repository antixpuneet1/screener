import type { DataProvider } from "../types.js";
import { config } from "../config.js";
import { MockProvider } from "./MockProvider.js";
import { UpstoxProvider } from "./UpstoxProvider.js";

/**
 * Provider factory. DATA_PROVIDER in .env selects the live data source:
 *   - "upstox" (default): live Upstox API, needs UPSTOX_ACCESS_TOKEN.
 *   - "mock": simulated feed, no credentials needed, safe for local demos/testing.
 * To plug in another broker/vendor, add a class implementing DataProvider and a
 * case below — nothing else in the app needs to change.
 */
export function createDataProvider(): DataProvider {
  switch (config.provider) {
    case "upstox":
      return new UpstoxProvider();
    case "mock":
      return new MockProvider();
    default:
      throw new Error(
        `Unknown DATA_PROVIDER "${config.provider}". Supported: "upstox", "mock".`,
      );
  }
}

export type { DataProvider };
