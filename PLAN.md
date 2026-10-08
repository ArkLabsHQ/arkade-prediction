# PLAN

Goal: working BTC-collateralized prediction market on Arkade (regtest PoC complete; Mutinynet/Dokploy ready).
Status legend: TODO / WIP / DONE / BLOCKED / UNSUPPORTED / NOT RUN.

## A. Recon, compatibility, trust decisions, vertical slice
- A1 Clone + pin sources (emulator, compiler, ts-sdk, intent-solver, banco, arkade-regtest, arkd) — DONE
- A2 Isolated regtest stack (apm-regtest, ports 37xxx, emulator v0.0.9-rc.1) — DONE
- A3 Compiler -> artifact -> programFromArtifact -> SDK -> emulator -> arkd spike — DONE (spike-pipeline.test.ts)
- A4 Capability matrix — DONE (docs/compatibility.md)
- A5 Protocol spec with numeric lifecycle — DONE (docs/protocol.md)

## B. Collateral + claims
- B1 market_vault.ark / resolved_vault.ark: mint, merge, resolve, timeout, redeem, renew; two-tx genesis — DONE
- B2 Exact payout math (bigint) + property tests — DONE (test/unit/core.test.ts)
- B3 Adversarial e2e: over-release, mint without collateral, wrong vector, early attestation — DONE
- B4 Unilateral exit of claims with economic value — UNSUPPORTED (BTC-only exits upstream; vault has NUMS exit)

## C. Sources + oracle
- C1 Polymarket discovery adapter + eligibility + persistence — DONE
- C2 Final-resolution verifier (CTF v1 binary, finalized Polygon block) + live historical proof — DONE
- C3 Attestation encoding + attestor process + in-covenant verification — DONE
- C4 Threshold oracle (k-of-3 attestor slots) — DONE (threshold-oracle.test.ts, live 2-of-3)

## D. Trading, durability, renewal
- D1 sell_offer / buy_offer (partial fill, cancel, expiry settle) + keeper mint-match — DONE
- D2 Workflow store (SQLite WAL/FULL), single-writer lease, write-ahead, reconciliation — DONE
- D3 Keeper: covenant renewals via intents, auto-claim boxes, settles, LP liquidity, activation — DONE
- D4 Keeper fee input for nonzero intent fees — TODO

## E. Product
- E1 API + SSE — DONE (docs/api.md)
- E2 Web UI (markets, detail, trade, portfolio, create, wallet, operator) — DONE (docs/evidence/ui/)
- E3 CLI/demo scripts, one-command regtest — DONE (scripts/regtest.mjs, scripts/demo.ts)

## F. Hardening + packaging
- F1 Crash/restart tests, property tests — DONE (fault-recovery.test.ts, core.test.ts)
- F2 Perf measurements — DONE (docs/performance.md)
- F3 Dockerfile/compose/env examples, redeploy + backup/restore test — DONE (docker-redeploy.test.ts)
- F4 Mutinynet preflight + runbook — DONE read-only (docs/operations.md); live Mutinynet transactions NOT RUN
- F5 Threat model — DONE (docs/threat-model.md)
- F6 Independent reviews (collateral, oracle, orders, durability) + fixes — DONE (docs/reviews.md)
- F7 Hosted Dokploy deployment — NOT RUN (needs authorization and funded test wallets)
