# F&O O=L Screener

Live screener for the full NSE Futures & Options stock universe that flags option
contracts where **Open = Low** for the current trading session — across every CE/PE,
every strike, every expiry, refreshed continuously through market hours.

Backed by the **Upstox API**, behind a pluggable `DataProvider` interface so a different
broker/vendor can be swapped in without touching the screener logic. Ships as a
double-clickable **Windows .exe** as well as a normal Node app.

## How it works

```
providers/ (DataProvider impls) → Scanner (batch quotes, rate limiting, O=L detection)
                                          → ScreenerState (dedupe + "new" highlighting)
                                          → WebSocket hub → browser dashboard
```

- **`src/types.ts`** — the `DataProvider` contract every data source implements:
  `getOptionInstruments()` (the live F&O universe) and `getQuotes()` (batched live quotes).
- **`src/providers/UpstoxProvider.ts`** — the live provider. Derives the F&O universe
  automatically from Upstox's published instrument master (`NSE.json.gz`) on a timer
  (`INSTRUMENT_REFRESH_MS`), filtering `segment == "NSE_FO"` and `instrument_type` in
  `{CE, PE}`, so the underlying list, strikes and expiries always match NSE's current
  F&O list — nothing is hardcoded, and exchange additions/removals are picked up without
  a code change. Upstox refreshes that file daily (~6 AM IST).
- **`src/providers/MockProvider.ts`** — simulated feed for demos/testing with no
  credentials (`DATA_PROVIDER=mock`). Its 208-symbol seed list is illustrative only and
  is never used by the live provider.
- **`src/screener/scanner.ts`** — each cycle: loads the instrument universe, chunks all
  contracts into provider-sized quote batches, applies rate limiting + retry-with-backoff,
  and flags contracts where `open > 0 && open == low` using the exact timestamp the
  provider reports for that quote.
- **`src/screener/state.ts`** — keeps contracts that already matched today so results
  aren't duplicated; a contract is marked `isNew` only on the cycle it's first detected.
- **`src/marketHours.ts`** — scanning is gated to NSE market hours (IST, Mon–Fri,
  configurable), so the loop is idle outside trading hours instead of scanning stale data.

## Getting an Upstox access token

1. Create an app at the [Upstox developer console](https://account.upstox.com/developer/apps)
   and note its **API key**, **API secret**, and the **redirect URL** you registered.
2. Send yourself through the OAuth dialog:
   `https://api.upstox.com/v2/login/authorization/dialog?client_id=<API_KEY>&redirect_uri=<REDIRECT_URL>&response_type=code`
3. After logging in you're redirected to your redirect URL with `?code=...`.
4. Exchange that code for a token by POSTing to
   `https://api.upstox.com/v2/login/authorization/token` with `code`, `client_id`,
   `client_secret`, `redirect_uri`, and `grant_type=authorization_code`.
5. Put the returned `access_token` in `.env` as `UPSTOX_ACCESS_TOKEN`.

**Tokens expire daily (~3:30am IST)**, so this is a once-per-trading-day step. If you want
it hands-off, script steps 2–5 and have the script rewrite `.env` before market open.

## Running as a normal Node app

```bash
npm install
cp .env.example .env    # then set UPSTOX_ACCESS_TOKEN
npm run dev             # http://localhost:4000
```

To try it without any credentials, set `DATA_PROVIDER=mock` (and
`IGNORE_MARKET_HOURS=true` if you're outside 09:15–15:30 IST).

Production build: `npm run build && npm start`.

## Building the Windows .exe

```bash
npm run package:win
```

This produces a ready-to-ship `release/` folder:

```
release/
  fno-ol-screener.exe    ~88 MB, self-contained (Node runtime included)
  public/                dashboard assets — must stay next to the .exe
  .env.example           copy to .env and set your token
  README-DIST.txt        end-user instructions
```

Zip and ship the whole folder. The end user copies `.env.example` to `.env`, sets their
token, and double-clicks the `.exe` — a console window shows live logs and the dashboard
opens in their default browser automatically. Closing the console window stops it.

How the build works (`scripts/package-win.mjs`): esbuild bundles the app to a single
CommonJS file, the script downloads the official Windows `node.exe` from nodejs.org, and
`postject` injects the bundle using Node's built-in
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
support. The build runs on any platform (it doesn't need Windows) and caches the
downloaded runtime in `build/`. Override the Node version with `SEA_NODE_VERSION=v22.x.y`.

Two notes on the output: `postject` prints `warning: The signature seems corrupted!` —
that's expected for an unsigned binary and harmless. And since the .exe isn't code-signed,
Windows SmartScreen may warn about an unrecognized publisher on first run.

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

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP/WebSocket server port |
| `DATA_PROVIDER` | `upstox` | `upstox` or `mock` |
| `UPSTOX_ACCESS_TOKEN` | - | Required when `DATA_PROVIDER=upstox`; expires daily |
| `UPSTOX_BASE_URL` | `https://api.upstox.com/v2` | API base URL |
| `UPSTOX_INSTRUMENTS_URL` | Upstox `NSE.json.gz` | Instrument master snapshot |
| `UPSTOX_QUOTE_RATE_LIMIT_PER_SECOND` | `8` | Quote requests/sec (see below) |
| `REFRESH_INTERVAL_MS` | `20000` | How often the full universe is rescanned |
| `INSTRUMENT_REFRESH_MS` | `1800000` | How often the F&O instrument master is refreshed |
| `MARKET_OPEN` / `MARKET_CLOSE` | `09:15` / `15:30` | IST trading window the scanner runs in |
| `IGNORE_MARKET_HOURS` | `false` | Set `true` to scan outside market hours (demos) |
| `MAX_RETRIES` | `4` | Retries per batch on rate-limit/transient errors before it's reported as an error for that cycle |

### Sizing the refresh interval against rate limits

Upstox's documented limits are **25 req/s, 250/min, 1000/30min**. The screener requests
quotes in batches of 500 instruments, so a full NSE F&O option universe of roughly
`N` contracts costs about `N / 500` requests per cycle. The per-minute ceiling is the one
that binds first: keep

```
(contracts / 500) * (60000 / REFRESH_INTERVAL_MS)  <  250
```

The defaults (`REFRESH_INTERVAL_MS=20000`, 8 req/s) leave healthy headroom. If you hit
429s, raise `REFRESH_INTERVAL_MS` before touching the per-second limit — the screener
already backs off and retries automatically, and reports any batch it ultimately gave up
on in that cycle's `errors` (shown in the dashboard status bar).

## Data correctness notes

- Only same-session data is used: `open`/`low` come from the provider's live quote for
  *today's* session, never a prior day's OHLC or a stale option-chain snapshot.
- **Change in OI**: Upstox's real-time quote endpoint does not expose the prior session's
  closing OI directly, so `UpstoxProvider` uses the first OI value observed each trading
  day per contract as the baseline (reset daily). For an exact prior-close OI figure,
  call `UpstoxProvider.seedChangeInOiBaseline(...)` with a once-daily historical-data
  snapshot fetched before market open.
- A contract's `low` only decreases through the session, so once a contract stops
  satisfying `open == low` it cannot re-qualify later the same day — matching how the
  screener's dedupe/"new" highlighting is meant to behave.

## Dashboard

`public/index.html` connects over WebSocket (`/ws`) and re-renders on every scan cycle:
Symbol, CE/PE, Strike, Expiry, Open, Low, LTP, Volume, OI, Change in OI, and the exact
data timestamp per contract. Newly detected contracts flash on arrival.
