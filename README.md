# Arkade prediction markets

BTC-collateralized binary prediction markets on Arkade. Every YES/NO claim is a native Arkade asset backed by
sats locked in a per-market covenant vault; orders are funded covenant VTXOs that fill while makers are offline;
outcomes come from an attestor whose signature is checked inside the covenant. Markets are imported from
Polymarket (CTF v1 binary) or created by users.

**State:** regtest proof of concept complete and tested; Mutinynet readiness verified read-only; no Mutinynet
transactions and no hosted deployment yet (both need funded test wallets and authorization). Test funds only.

## Quick start (regtest)

```sh
git submodule update --init regtest && pnpm install
node scripts/regtest.mjs up      # isolated regtest stack + app + attestor -> http://localhost:37400
node scripts/regtest.mjs demo    # deterministic end-to-end demo (prints DEMO OK)
node scripts/regtest.mjs test    # typecheck, unit, fill planner, regtest e2e
```

## Documents

| Topic | File |
|---|---|
| Protocol: contracts, every spending leaf, settlement math, attestation binding, numeric lifecycle | `docs/protocol.md` |
| Threat model, trust split and per-failure recovery | `docs/threat-model.md` |
| Pins and capability matrix | `docs/compatibility.md` |
| Runbook: regtest, Docker/Dokploy, Mutinynet preflight, backup/restore, upgrades | `docs/operations.md` |
| Performance | `docs/performance.md` |
| Independent reviews: findings and dispositions | `docs/reviews.md` |
| HTTP API | `docs/api.md` |
| Decisions, plan, status | `DECISIONS.md`, `PLAN.md`, `STATUS.md` |
| Research notes (emulator, Polymarket, solver patterns) | `docs/research/` |

## Acceptance

Statuses: PASS (executed, evidence linked), FAIL, NOT RUN, UNSUPPORTED (not possible on the pinned stack).
E2E commands are `pnpm exec vitest run --config vitest.e2e.config.ts <file>` against the regtest stack;
the full-suite log is `docs/evidence/e2e-regtest.txt`.

| # | Requirement | Status | Evidence | Reproduce |
|---|---|---|---|---|
| 1 | Import a live Polymarket market | PASS | `docs/evidence/polymarket-live.txt` | `LIVE_POLYMARKET=1` + `test/e2e/polymarket-live.test.ts` |
| 2 | Verify historical finalized results live, with provenance | PASS | `docs/research/evidence/polymarket/live-verify-2758339.json` (NO), `live-verify-3409541.json` (YES), `live-verify-4737427.json` (50/50) | `node --import tsx scripts/live/polymarket-proof.ts` |
| 3 | Custom market via API and UI | PASS | `test/e2e/server-flow.test.ts`, `docs/evidence/ui/README.md` | `server-flow.test.ts`; UI steps in the evidence file |
| 4 | Fund wallets and add liquidity | PASS | `docs/evidence/ui/README.md`, `docs/evidence/demo.txt` | `node scripts/regtest.mjs demo` |
| 5 | Issue claims against exact collateral | PASS | `test/e2e/vault-lifecycle.test.ts` (short collateral, unbalanced set, CTRL theft, cap refused) | `vault-lifecycle.test.ts` |
| 6 | Orders: offline-maker fill, partial fill, cancel, expiry, keeper match | PASS | `test/e2e/offers.test.ts` (underpay, skim, min-fill, overspend, short delivery refused) | `offers.test.ts` |
| 7 | Claim transfer and merge | PASS | `test/e2e/settlement-paths.test.ts` (P2P transfer), `vault-lifecycle.test.ts` (merge, over-release refused) | same files |
| 8 | Attested redemption | PASS | `vault-lifecycle.test.ts`, `server-flow.test.ts` (forged certificate refused) | same files |
| 9 | YES, NO, INVALID and timeout settlement | PASS | YES: `vault-lifecycle.test.ts`; NO: replay of Polymarket 2758339 in `docs/evidence/polymarket-live.txt`; INVALID + timeout + early attestation refused: `settlement-paths.test.ts` | same files |
| 10 | Renewal while owners are offline | PASS | `test/e2e/renewal.test.ts`, `claim-box.test.ts`, `offers.test.ts` | same files |
| 11 | Kill and restart at submission boundaries | PASS | `test/e2e/fault-recovery.test.ts` | `fault-recovery.test.ts` |
| 12 | Redeploy, backup and restore on one volume | PASS | `docs/evidence/docker-redeploy.txt` | `DOCKER_E2E=1` + `test/e2e/docker-redeploy.test.ts` |
| 13a | Collaborative offboard and unilateral exit of BTC | PASS | `test/e2e/withdrawal.test.ts` | `withdrawal.test.ts` |
| 13b | Unilateral exit carrying claims or vault collateral | UNSUPPORTED | SDK: exits handle BTC value only; vault exit leaf is NUMS (`DECISIONS.md` 11) | — |
| 14 | Browser UI against regtest | PASS | `docs/evidence/ui/README.md` + screenshots | manual (Playwright-driven) |
| 15 | Performance measured | PASS | `docs/evidence/perf.json`, `docs/performance.md` | `node --import tsx scripts/perf.ts` |
| 16 | Unit and property tests (88) | PASS | `docs/evidence/unit.txt` | `pnpm exec vitest run test/unit` |
| 17 | Mutinynet readiness (read-only) | PASS | `docs/evidence/mutinynet-preflight.txt` | `node --env-file=.env.mutinynet.example --import tsx scripts/preflight.ts` |
| 17a | Early source resolution detected (batched finalized reads) and trading halted | PASS | `docs/evidence/early-resolution-screen.txt` (live), `test/unit/server/resolver.test.ts`, `keeper-liquidity.test.ts` | `node --import tsx scripts/live/early-resolution-check.ts` |
| 17b | Independent reviews: collateral, oracle, orders, durability | DONE | `docs/reviews.md` (3 high, 11 medium, 9 low: each fixed or documented) | — |
| 18 | Mutinynet transactions | NOT RUN | needs funded test wallets and authorization | `docs/operations.md` |
| 19 | Hosted Dokploy deployment | NOT RUN | image and compose tested locally (#12) | `docs/operations.md` |
| 20 | Threshold oracle, categorical markets, nonzero-fee renewal | NOT RUN (not implemented) | `PLAN.md` C4, D4 | — |

## Trust summary

Covenant rules are enforced by the Arkade emulator and the operator's co-signature, not by Bitcoin consensus.
Plain BTC can always exit unilaterally; claim value and pooled collateral depend on the operator and emulator
staying honest and available, and on a keeper renewing covenant VTXOs before expiry. Details:
`docs/threat-model.md`.
