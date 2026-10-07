# PLAN

Goal: working BTC-collateralized prediction market on Arkade (regtest PoC complete; Mutinynet/Dokploy ready).
Status legend: TODO / WIP / DONE / BLOCKED / UNSUPPORTED.

## A. Recon, compatibility, trust decisions, vertical slice
- A1 Clone + pin sources (emulator, compiler, ts-sdk, intent-solver, banco, arkade-regtest, arkd) — DONE
- A2 Isolated regtest stack (apm-regtest, ports 37xxx, emulator v0.0.9-rc.1) — DONE
- A3 Compiler -> artifact -> programFromArtifact -> SDK -> emulator -> arkd spike — WIP
- A4 Capability matrix (docs/compatibility.md) — WIP
- A5 Protocol spec (docs/protocol.md) with numeric lifecycle — TODO

## B. Collateral + claims
- B1 MarketVault.ark: mint / merge / redeem / renew; genesis (CTRL + YES/NO) — TODO
- B2 Exact payout math (bigint) + property tests — TODO
- B3 Adversarial e2e: wrong asset, extra asset, forged id, reissue without collateral — TODO

## C. Sources + oracle
- C1 Polymarket discovery adapter + eligibility + persistence — TODO
- C2 Final-resolution verifier (CTF profile, finalized Polygon block) + live historical proof — TODO
- C3 Attestation encoding + attestor process + in-covenant verification — TODO

## D. Trading, durability, renewal
- D1 Offer.ark (sell/buy funded offers, partial fill, cancel, expiry refund) — TODO
- D2 Workflow store (SQLite WAL/FULL), single-writer lease, recovery — TODO
- D3 Keeper: renewals (OP_TUNNEL via intents), payouts, expired-offer refunds — TODO

## E. Product
- E1 API + SSE — TODO
- E2 Web UI (markets, detail, trade, portfolio, create, operator) — TODO
- E3 CLI/demo scripts, deterministic demo — TODO

## F. Hardening + packaging
- F1 Failure/restart tests, property tests — TODO
- F2 Perf measurements — TODO
- F3 Dockerfile/compose/env examples, redeploy+backup/restore test — TODO
- F4 Mutinynet preflight + runbook — TODO
