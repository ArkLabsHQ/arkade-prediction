# STATUS

Updated: 2026-10-07 ~19:30 UTC (session 1). Branch `main`, local commits only (nothing pushed).

## Working state
- Isolated regtest stack `apm-regtest` (prefix `apm-`, ports 37xxx) from `infra/regtest/stack.env`:
  arkd v0.9.16 :37070, emulator v0.0.9-rc.1 :37073, Esplora :37000/api. Start/recreate:
  `node regtest/regtest.mjs start --env C:/Git/arkade-prediction/infra/regtest/stack.env` (`clean` is project-scoped; never `--prune`).
- arkadec: built from arkade-os/compiler@e9703e7 at `C:\Git\_apm-src\compiler\target\release\arkadec.exe`;
  `ARKADEC=<path> node contracts/build.mjs --check` verifies committed artifact fingerprints.
- Contracts: market_vault, resolved_vault, sell_offer, buy_offer, claim_box (+ spike_pay probe).
- Core `src/core`: programs (artifact adapter), arkadeTx (multi-covenant builder), actions (all money flows),
  market, offers, claimBox, attestation, definition, payout, renewal, encoding, assets.
- Server `src/server`: config, db (node:sqlite WAL/FULL, migrations), lease (single writer), workflows,
  markets (custom admission + genesis audit), offers (order book + fill inference), boxes, keeper,
  importer, resolver, sources/polymarket, api (Hono + SSE), main. Attestor: `src/oracle/main.ts` (separate process).
- UI `src/web` being built by a background agent (not yet committed).

## Last passing commands (exit 0)
- `pnpm exec tsc --noEmit -p .` (non-web files clean; web in progress)
- `pnpm exec vitest run test/unit` — 14 passed (Polymarket adapter, recorded fixtures)
- e2e (`pnpm exec vitest run --config vitest.e2e.config.ts <file>`): spike-pipeline, vault-lifecycle, renewal,
  offers, actions-lifecycle, claim-box, server-flow — each PASS on last run.
- `LIVE_POLYMARKET=1 ... test/e2e/polymarket-live.test.ts` — PASS (live import of Polymarket 593972; replay of
  2758339 settled NO from Polygon block 95130607 via attestor).

## Next steps (in order)
1. INVALID/timeout/too-early e2e; claim transfer e2e.
2. Fault injection (crash before/after submit) + restart reconciliation e2e.
3. Unroll/offboard demo + asset-exit limits.
4. Validate UI against regtest (browser), CLI demo script, one-command start.
5. Dockerfile/compose/env examples, redeploy + backup/restore test.
6. Perf measurements; Mutinynet preflight; docs (protocol, threat model, compatibility, runbook, acceptance table).
