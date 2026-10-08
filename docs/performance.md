# Performance

Measured 2026-10-08 06:28 UTC on the final code with `node --import tsx scripts/perf.ts` against the Docker app
on :37400 and the isolated regtest stack. Raw numbers: `docs/evidence/perf.json`; the earlier run at commit
`24ccc96` (before the review fixes) is kept in `docs/evidence/perf-24ccc96.json`.

**Host:** one Windows 11 machine (AMD Ryzen AI 9 365, 20 logical cores, 63 GiB), Docker Desktop shared with
other regtest stacks and other projects' test suites. arkd, emulator, bitcoind, indexer, app and load generator
all ran on this host, so absolute figures move with that load (the two runs differ by up to 2x in both
directions) and say nothing about public-network latency.

## Results

| Workload | Final code | `24ccc96` |
|---|---|---|
| Sequential mints on one market (15 Arkade transactions, each spends the vault) | p50 251 ms, p95 620 ms, **3.4 tx/s** | p50 563 ms, p95 833 ms, 1.71 tx/s |
| 6 concurrent takers filling 6 different offers | 0 errors, 503 ms wall clock | 0 errors, 1.24 s |
| Emulator `SubmitTx` (covenant check + co-sign) p50 | 98 ms | 150 ms |
| arkd `SubmitTx` p50 | 25 ms | 25 ms |
| Indexer `getVirtualTxs` p95 (waiting for the previous tx) | 123 ms | 594 ms |
| API `GET /api/markets?limit=50` (2,000 requests) | 109 req/s, 0 errors | 88 req/s, 0 errors |
| API `GET /api/markets/:id` | 298 req/s, 0 errors | 456 req/s, 0 errors |
| API `GET /api/markets/:id/offers` | 642 req/s, 0 errors | 1,038 req/s, 0 errors |
| Server process after the run | RSS 404 MB, JS heap 87 MB | RSS 161 MB, JS heap 39 MB |

Memory: three further rounds of 6,000 mixed reads moved the container from 340 to 377 MiB and then stayed at
377 MiB; the JS heap was back at 38 MB afterwards. The higher RSS is native memory the process keeps reserved
(this instance had just run the backup test's `VACUUM INTO`), not a growing leak.

The single-market and offers reads were 35-38% slower in the final run while every write path was faster. Host
load explains part of it but this was not isolated; a request-level profile of the new middleware (body cap)
and the larger market payload would settle it.

## What limits throughput

- **Per-market writes serialize on the vault.** Every mint, merge, resolution, mint-match and redemption spends
  the single vault VTXO, so the next one must wait for the previous transaction to be indexed. Measured ceiling:
  1.7 to 3.4 transactions per second per market on this host, depending on its load. Markets are independent, so total throughput grows
  with the number of markets until arkd or the emulator saturates (not measured).
- **Offer fills parallelize.** Each offer is its own VTXO; takers of different offers do not contend.
  Two takers racing for the same offer: the operator accepts one spend; the other submission is rejected and has
  to be re-planned against the continuation (no automatic retry; not measured).
- **Indexer lag drives the latency tails under load.** The p95 wait for a just-submitted transaction was 594 ms
  on the loaded host and 123 ms on the lighter one, while emulator and arkd submission times barely moved.
- **The backend is not the bottleneck.** Reads are served from SQLite; the market list is slower because it runs
  one query per market for prices and volume (N+1, known; fix with one aggregate query when lists grow).

## Scaling path (not implemented)

1. Batch several users' mints into one vault transaction (the covenant already accepts any `qty`).
2. Shard a hot market across several vaults with the same CTRL authority (needs a contract change).
3. Run API-only processes (`WORKERS=none`) next to the writer on the same host and volume (SQLite WAL needs a
   local filesystem); writes stay single-writer by design. Beyond one host: move the store to Postgres.
