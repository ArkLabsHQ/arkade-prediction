# HTTP API

Types: `src/shared/api.ts`. Amounts are decimal strings, bytes are lowercase hex. Errors: `{ "error": string, "code": string }`
with 4xx/5xx. Public endpoints need no auth; `/api/admin/*` needs `Authorization: Bearer <ADMIN_TOKEN>`;
`/api/dev/*` exists only when `DEV_ENDPOINTS=true` (regtest).

The server never holds user keys. Browsers (and the CLI) build, sign and submit their own Arkade
transactions with `src/core/actions.ts` directly against arkd/emulator (CORS is open on both), then tell
the server about new orders. The server only trusts what it re-reads from the Arkade indexer, and the browser
audits each market (`src/core/audit.ts`, `src/web/verify.ts`) before its first money-moving action.

Request bodies are capped at 64 KiB (413), including chunked uploads. Market `status` is one of `activating`,
`open`, `halted` (outcome known before close: the source resolved early or a certificate arrived; trading is
disabled in the app), `closed`, `resolving`, `resolved`, `failed`, `hidden`. `MarketJson` carries `genesisTxid`,
`vaultTxid` and `source.binding` so clients can audit without trusting the server.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health/live` | | `{ ok: true }` (process up) |
| GET | `/api/health/ready` | | `{ ok, components: {db, arkd, emulator, writer, oracle} }`; 503 if db/arkd down |
| GET | `/api/config` | | `ConfigJson` |
| GET | `/api/markets` | `?status=open&kind=&q=&limit=&cursor=` | `{ markets: MarketJson[], next: string \| null }` |
| GET | `/api/markets/:id` | | `MarketJson` |
| GET | `/api/markets/:id/offers` | `?status=open` | `{ offers: OfferJson[] }` |
| GET | `/api/markets/:id/trades` | `?limit=` | `{ trades: TradeJson[] }` |
| POST | `/api/markets` | `CreateMarketRequest` (creator already ran genesis + openVault) | `MarketJson` (server re-derives terms, audits genesis on the indexer) |
| POST | `/api/markets/:id/certificates` | `CertificateJson` | `{ accepted: true }` (signature checked against the market oracle key; keeper submits the resolve tx) |
| POST | `/api/offers` | `PostOfferRequest` | `OfferJson` (server recomputes the offer script from terms and finds the funded coin) |
| POST | `/api/offers/:id/refresh` | | `OfferJson` (re-read from indexer; call after filling or cancelling) |
| GET | `/api/portfolio` | `?script=<hex pkScript>` | `{ offers: OfferJson[], trades: TradeJson[] }` |
| GET | `/api/events` | SSE, honours `Last-Event-ID` | `MarketEvent` stream (`event: <type>`); replays the log in pages, closes a stream whose client falls 1,000 events behind |
| GET | `/api/admin/overview` | | operator view: import lag, oracle lag, workflows, liquidity, expiries |
| POST | `/api/admin/import/run` | | runs one discovery pass |
| POST | `/api/admin/markets/:id/activate` | | activates an eligible imported market (operator genesis) |
| POST | `/api/admin/markets/:id/hide` | | hides a market from listings |
| POST | `/api/admin/markets/:id/liquidity` | `{ sets: string, yesAsk: string, noAsk: string }` | LP mints and posts asks |
| POST | `/api/admin/markets/:id/dev-resolve` | `{ outcome }` | regtest dev oracle only |
| POST | `/api/admin/workflows/:id/retry` | | returns a `failed` workflow to `pending` with its stored progress (writer process only) |
| POST | `/api/admin/backup` | | `{ path }` consistent SQLite snapshot under `/data/backups/` |
| POST | `/api/admin/replay` | `{ sourceId }` | regtest only: mirrors a resolved Polymarket market as a historical replay |
| POST | `/api/dev/faucet` | `{ address, amountSats }` | `{ txid }` (regtest only) |
