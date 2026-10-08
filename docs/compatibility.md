# Compatibility and capability matrix

Checked on 2026-10-07. "Tested on pins" means an executed regtest e2e test against exactly the pins below
(`docs/evidence/e2e-regtest.txt`). "Mutinynet" means a read-only check against the public endpoints
(`docs/evidence/mutinynet-preflight.txt`); no transaction was sent to Mutinynet.

## Pins

| Component | Pin | Where |
|---|---|---|
| arkd | `ghcr.io/arkade-os/arkd:v0.9.16@sha256:f723e26a…90b5` | `infra/regtest/stack.env` |
| arkd-wallet | `ghcr.io/arkade-os/arkd-wallet:v0.9.16@sha256:9c409211…edd2` | `infra/regtest/stack.env` |
| Arkade emulator | `ghcr.io/arkade-os/emulator:v0.0.9-rc.1@sha256:56fe9e50…2444` (same version as Mutinynet on 2026-10-07) | `infra/regtest/stack.env` |
| arkade-regtest | submodule `regtest/` @ `8afc1eb` | `.gitmodules` |
| TypeScript SDK | `@arkade-os/sdk` 0.4.78 (exact) | `package.json`, `pnpm-lock.yaml` |
| Compiler | `arkadec` from arkade-os/compiler @ `e9703e7` (no stable release exists) | `contracts/build.mjs` |
| Contract artifacts | fingerprints `marketVault sha256:bb6bc1f8…`, `resolvedVault sha256:4d6bd198…` | `contracts/artifacts/*.json` |
| Runtime | `node:24.16.0-bookworm-slim@sha256:2c87ef9b…a203` | `Dockerfile` |
| Mutinynet operator | signer `03301078…127a`, emulator `03f823b9…889a`, exit delay 2048 s, zero intent fees | `.env.mutinynet.example` |

Covenant scripts commit to the emulator key and the operator key. A different key on the target network means
new scripts: the server refuses to start when a pin or the stored volume identity differs (`src/server/main.ts`).

## Capability matrix

| Capability | Implemented | Tested on pins (regtest) | Mutinynet | Evidence / note |
|---|---|---|---|---|
| Compiled `.ark` covenant spent via emulator + arkd | yes | yes | key/version match only | spike-pipeline.test.ts |
| Native assets: issue, control-asset reissue, burn, transfer | yes | yes | NOT RUN | vault-lifecycle.test.ts |
| In-covenant attestation (`OP_CHECKSIGFROMSTACK`) | yes | yes | NOT RUN | settlement-paths.test.ts |
| Emulator-clock deadlines (`OP_CHECKTIME`) | yes | yes | NOT RUN | settlement-paths, offers |
| Value/script/asset tunnelling (`OP_TUNNEL`) | yes | yes | NOT RUN | renewal, offers (settle) |
| Renewal of covenant VTXOs through batch swaps, owner offline | yes | yes | NOT RUN | renewal.test.ts, claim-box.test.ts |
| Funded offers: fill, partial fill, cancel, expiry settle, keeper mint-match | yes | yes | NOT RUN | offers.test.ts |
| Offboard of BTC VTXOs (collaborative) | yes | yes | NOT RUN | withdrawal.test.ts |
| Unilateral exit of BTC VTXOs (pre-signed package, P2A CPFP) | yes | yes | NOT RUN | withdrawal.test.ts |
| Unilateral exit carrying assets | — | carrier sats only | — | UNSUPPORTED upstream: SDK README "Unilateral exit handles BTC value only" |
| Unilateral exit of pooled vault collateral | — | — | — | UNSUPPORTED by design: NUMS exit leaf (DECISIONS 11) |
| Emulator L1 covenant (`SubmitOnchainTx`) | no | no | — | available upstream, untested; candidate vault exit path |
| Nonzero intent fees during renewal | no | no | fees are zero (preflight) | needs a keeper fee input |
| Polymarket CTF v1 binary import + finalized-payout verification | yes | live run (opt-in) | n/a (Polygon) | polymarket-live.test.ts, `docs/research/evidence/polymarket/` |
| Polymarket neg-risk / categorical markets | no | rejected at eligibility (`neg-risk`) | — | test/unit/sources/polymarket.test.ts |
| Threshold oracle (m-of-n) | no | — | — | 1-of-1 attestor per market |
| Operator signer rotation for existing covenants | no | — | deprecated signer listed | not exercised |
| Lightning / swaps | no | — | — | out of scope |

## Known differences between regtest and Mutinynet

| Parameter | Regtest stack | Mutinynet (observed) | Effect |
|---|---|---|---|
| Unilateral exit delay | 512 s | 2048 s | read from `/v1/info` at startup (`src/server/network.ts`); CSV leaves differ per network |
| VTXO tree expiry | 7168 s | not advertised in `/v1/info` | keeper renews VTXOs whose indexer `expiresAt` is within `RENEW_THRESHOLD_SECONDS` (default 3600); must stay below the operator's expiry |
| Fees | zero | zero | nonzero fees break value-preserving renewals (see matrix) |
| Emulator key | local stack key | `03f823b9…889a` | scripts and asset ids are network-specific |

Regtest uses seconds-denominated locktimes because arkd v0.9.16's indexer reports block-mode expiries in
seconds (DECISIONS 3).
