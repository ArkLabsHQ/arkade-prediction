# STATUS

Updated: 2026-10-08 (session 1). Branch `main`, local commits only (nothing pushed, nothing deployed).

## State
- Regtest proof of concept complete: contracts, client actions, single-writer server + keeper, attestor,
  Polymarket CTF v1 binary import, web UI, Docker image + compose, one-command regtest, demo, perf, preflight.
- Independent reviews (collateral, oracle, orders, durability) done; every finding fixed or documented
  (`docs/reviews.md`).
- Acceptance table with evidence: `README.md`.

## Environment
- Isolated regtest stack `apm-regtest` (prefix `apm-`, ports 37xxx) from `infra/regtest/stack.env`:
  arkd v0.9.16 :37070, emulator v0.0.9-rc.1 :37073, Esplora :37000/api. Never run `clean --prune`.
- App + attestor containers from `node scripts/regtest.mjs up` on :37400.
- arkadec built from arkade-os/compiler@e9703e7 at `C:\Git\_apm-src\compiler\target\release\arkadec.exe`;
  `ARKADEC=<path> node contracts/build.mjs --check` passes (artifacts match sources).

## Last gate (2026-10-08, final code; evidence in `docs/evidence/`)
- `pnpm exec tsc --noEmit -p .` exit 0; unit 88/88 (baseline before reviews: 21/21); `contracts/build.mjs --check`,
  `src/web/fills.check.ts`, `pnpm run web:build` pass.
- Regtest e2e 10 passed, 2 opt-in skipped (`e2e-regtest.txt`); live Polymarket e2e pass; Docker redeploy/backup/
  restore pass (stale backup remaining=4 reconciled to 3); `node scripts/regtest.mjs up` + `demo` → DEMO OK.
- Mutinynet read-only preflight 18/18; live early-resolution screen check pass.
- Flakes named and fixed in test infrastructure (not app code): emulator log latency in the covenant-refusal
  check, test-server start deadline on a loaded host, faucet coins inheriting an old batch expiry, and arkd
  liquidity drained by unswept batches on a stack that mines only on demand (DECISIONS 31).

## Not done (needs authorization or is out of scope)
- Mutinynet transactions (funded test wallets + authorization), hosted Dokploy deployment.
- Threshold oracle, categorical markets, nonzero-fee renewal (PLAN C4, D4).
- Residual risks: `docs/threat-model.md` §7.
