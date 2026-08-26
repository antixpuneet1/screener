# F&O O=L Screener

Live screener for the full NSE Futures & Options stock universe that flags option
contracts where **Open = Low** for the current trading session — across every CE/PE,
every strike, every expiry, refreshed continuously through market hours.

It is built against a pluggable `DataProvider` interface rather than NSE's public
website endpoint, so it can be pointed at a real broker/market-data API.

## How it works

```
providers/ (DataProvider impls) → Scanner (batch quotes, rate limiting, O=L detection)
                                          → ScreenerState (dedupe + "new" highlighting)
                                          → WebSocket hub → browser dashboard
```

- **`src/types.ts`** — the `DataProvider` contract every data source implements:
  `getOptionInstruments()` (the live F&O universe) and `getQuotes()` (batched live quotes).
- **`src/providers/MockProvider.ts`** — default provider. Simulates a live feed for all
  208 seed F&O stocks so the app runs out of the box with no credentials. For clearly
  marked demo/testing purposes only.
- **`src/providers/KiteProvider.ts`** — real provider backed by Zerodha's Kite Connect
  REST API. Derives the F&O universe automatically from Kite's own instrument master
  (`GET /instruments/NFO`) on a timer (`INSTRUMENT_REFRESH_MS`), so the underlying list,
  strikes and expiries always match NSE's current F&O list — nothing is hardcoded, and
  additions/removals from the exchange are picked up without a code change.
- **`src/screener/scanner.ts`** — each cycle: loads the instrument universe, chunks all
  contracts into provider-sized quote batches, applies rate limiting + retry-with-backoff,
  and flags contracts where `open > 0 && open == low` using the exact timestamp the
  provider reports for that quote.
- **`src/screener/state.ts`** — keeps contracts that already matched today so results
  aren't duplicated; a contract is marked `isNew` only on the cycle it's first detected.
- **`src/marketHours.ts`** — scanning is gated to NSE market hours (IST, Mon–Fri,
  configurable), so the loop is idle outside trading hours instead of scanning stale data.

## Adding your own broker/data provider

Implement `DataProvider` (see `src/types.ts`) in a new file under `src/providers/`,
then register it in `src/providers/index.ts`. You only need to supply:

- `getOptionInstruments()` — return every current CE/PE contract (all strikes/expiries)
  for every F&O-eligible underlying, ideally derived live from the vendor's own
  instrument/contract master rather than a static list.
- `getQuotes(tokens)` — return `open`, `high`, `low`, `close`, `ltp`, `volume`, `oi`,
  `changeInOi`, and the data's own timestamp for a batch of instruments.
- `maxQuoteBatchSize` / `quoteRateLimitPerSecond` — the vendor's own documented limits;
  the scanner uses these to batch and throttle requests and to retry with backoff on
  429/5xx/timeout errors.

No other code changes are needed — the scanner, dedupe logic, server, and dashboard are
all provider-agnostic.

## Running

```bash
npm install
cp .env.example .env   # defaults to the mock provider, no credentials needed
npm run dev            # http://localhost:4000
```

To go live with Zerodha Kite Connect, set in `.env`:

```
DATA_PROVIDER=kite
KITE_API_KEY=...
KITE_ACCESS_TOKEN=...   # generated daily via the Kite Connect login flow; expires each day
```

Production build:

```bash
npm run build
npm start
```

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP/WebSocket server port |
| `DATA_PROVIDER` | `mock` | `mock` or `kite` |
| `KITE_API_KEY` / `KITE_ACCESS_TOKEN` | - | Required when `DATA_PROVIDER=kite` |
| `REFRESH_INTERVAL_MS` | `10000` | How often the full universe is rescanned |
| `INSTRUMENT_REFRESH_MS` | `1800000` | How often the F&O instrument master is refreshed |
| `MARKET_OPEN` / `MARKET_CLOSE` | `09:15` / `15:30` | IST trading window the scanner runs in |
| `IGNORE_MARKET_HOURS` | `false` | Set `true` to scan outside market hours (demos) |
| `MAX_RETRIES` | `4` | Retries per batch on rate-limit/transient errors before it's reported as an error for that cycle |

## Data correctness notes

- Only same-session data is used: `open`/`low` come from the provider's live quote for
  *today's* session, never a prior day's OHLC or a stale option-chain snapshot.
- **Change in OI**: Kite's real-time quote endpoint does not expose the prior session's
  closing OI directly, so `KiteProvider` uses the first OI value observed each trading
  day per contract as the baseline (reset daily). For an exact prior-close OI figure,
  call `KiteProvider.seedChangeInOiBaseline(...)` with a once-daily historical-data
  snapshot fetched before market open.
- A contract's `low` only decreases through the session, so once a contract stops
  satisfying `open == low` it cannot re-qualify later the same day — matching how the
  screener's dedupe/"new" highlighting is meant to behave.

## Dashboard

`public/index.html` connects over WebSocket (`/ws`) and re-renders on every scan cycle:
Symbol, CE/PE, Strike, Expiry, Open, Low, LTP, Volume, OI, Change in OI, and the exact
data timestamp per contract. Newly detected contracts flash on arrival.
