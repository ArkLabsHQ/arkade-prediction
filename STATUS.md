# STATUS

Updated: 2026-10-07 (session 1).

## Working state
- Isolated regtest stack `apm-regtest` (prefix `apm-`, ports 37xxx) from `infra/regtest/stack.env`:
  arkd v0.9.16 :37070, emulator v0.0.9-rc.1 :37073, Esplora :37000/api. Start:
  `node regtest/regtest.mjs start --env <abs>/infra/regtest/stack.env`.
- Compiler: arkadec built from arkade-os/compiler@e9703e7 (`C:\Git\_apm-src\compiler\target\release\arkadec.exe`);
  `ARKADEC=<path> node contracts/build.mjs --check` verifies committed artifact fingerprints.
- Contracts (contracts/src): market_vault, resolved_vault, sell_offer, buy_offer (+ spike_pay probe).
- Core (src/core): programs (artifact adapter), arkadeTx (multi-covenant builder), market, offers,
  attestation, payout, renewal, encoding, assets.

## Last passing commands
- `pnpm exec tsc --noEmit -p .` — clean.
- `pnpm exec vitest run --config vitest.e2e.config.ts` — spike-pipeline, vault-lifecycle, renewal, offers PASS
  (offers.test.ts 49 s; renewal.test.ts ~21 s).

## Known gaps / next steps
1. Backend: SQLite workflows, single-writer lease, keeper loop, API + SSE.
2. Polymarket adapter + final-resolution verifier + attestor process (research agent pending).
3. Web UI; CLI demo; Docker/Dokploy; Mutinynet preflight.
4. Docs: protocol.md (numeric lifecycle), threat model, compatibility matrix.
