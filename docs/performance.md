# Performance

Measured 2026-10-07 20:57 UTC at commit `24ccc96` with `node --import tsx scripts/perf.ts` against the Docker app
on :37400 and the isolated regtest stack. Raw numbers: `docs/evidence/perf.json`. The later review fixes left the
measured paths (covenant submission, offer fills, read endpoints) essentially unchanged; this is inferred, not
re-measured.

**Host:** one Windows 11 machine (AMD Ryzen AI 9 365, 20 logical cores, 63 GiB), Docker Desktop shared with
other regtest stacks. arkd, emulator, bitcoind, indexer, app and load generator all ran on this host, so the
figures are an upper bound for co-located services and say nothing about public-network latency.

## Results

| Workload | Result |
|---|---|
| Sequential mints on one market (15 Arkade transactions, each spends the vault) | p50 563 ms, p95 833 ms, **1.71 tx/s per market** |
| 6 concurrent takers filling 6 different offers | 0 errors, all done in 1.24 s (p50 1.18 s) |
| Emulator `SubmitTx` (covenant check + co-sign) | p50 150 ms, p95 518 ms |
| arkd `SubmitTx` | p50 25 ms, p95 43 ms |
| Indexer `getVirtualTxs` (waiting for the previous tx) | p50 21 ms, p95 594 ms |
| API `GET /api/markets?limit=50` (2,000 requests) | 88 req/s, p50 155 ms, p99 573 ms, 0 errors |
| API `GET /api/markets/:id` | 456 req/s, p50 31 ms, 0 errors |
| API `GET /api/markets/:id/offers` | 1,038 req/s, p50 14 ms, 0 errors |
| Server process after the run | RSS 161 MB, heap 39 MB |

## What limits throughput

- **Per-market writes serialize on the vault.** Every mint, merge, resolution, mint-match and redemption spends
  the single vault VTXO, so the next one must wait for the previous transaction to be indexed. Measured ceiling:
  about 1.7 transactions per second per market on this host. Markets are independent, so total throughput grows
  with the number of markets until arkd or the emulator saturates (not measured).
- **Offer fills parallelize.** Each offer is its own VTXO; takers of different offers do not contend.
  Two takers racing for the same offer: the operator accepts one spend; the other submission is rejected and has
  to be re-planned against the continuation (no automatic retry; not measured).
- **Indexer lag dominates latency tails.** The p95 wait for a just-submitted transaction (594 ms) exceeds the
  emulator and arkd submission times combined at p50.
- **The backend is not the bottleneck.** Reads are served from SQLite; the market list is slower because it runs
  one query per market for prices and volume (N+1, known; fix with one aggregate query when lists grow).

## Scaling path (not implemented)

1. Batch several users' mints into one vault transaction (the covenant already accepts any `qty`).
2. Shard a hot market across several vaults with the same CTRL authority (needs a contract change).
3. Run API-only processes (`WORKERS=none`) next to the writer on the same host and volume (SQLite WAL needs a
   local filesystem); writes stay single-writer by design. Beyond one host: move the store to Postgres.
