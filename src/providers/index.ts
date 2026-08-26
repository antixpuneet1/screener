import type { DataProvider } from "../types.js";
import { config } from "../config.js";
import { MockProvider } from "./MockProvider.js";
import { KiteProvider } from "./KiteProvider.js";

/**
 * Provider factory. DATA_PROVIDER in .env selects the live data source:
 *   - "mock" (default): simulated feed, no credentials needed, safe for local demos.
 *   - "kite": Zerodha Kite Connect, needs KITE_API_KEY / KITE_ACCESS_TOKEN.
 * To plug in another broker/vendor, add a class implementing DataProvider and a
 * case below — nothing else in the app needs to change.
 */
export function createDataProvider(): DataProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider();
    case "kite":
      return new KiteProvider();
    default:
      throw new Error(
        `Unknown DATA_PROVIDER "${config.provider}". Supported: "mock", "kite".`,
      );
  }
}

export type { DataProvider };
