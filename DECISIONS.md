# DECISIONS

Each entry: decision, reason, rejected alternatives. Newest last.

1. **Pins.** arkd v0.9.16 (digest pinned), emulator v0.0.9-rc.1 (= live Mutinynet emulator version, 2026-10-07),
   @arkade-os/sdk 0.4.78 (npm latest = master release tag), arkadec built from arkade-os/compiler@e9703e7
   (no stable release; only `v0.1.0-test`), arkade-regtest@8afc1eb as submodule `regtest/`.
   Rejected: emulator v0.0.8-rc.0 (regtest default) — older than what Mutinynet runs.
2. **Regtest isolation.** Compose project `apm-regtest`, container prefix `apm-`, host ports 37xxx, driven by
   `infra/regtest/stack.env`. Never `clean --prune` (machine-wide volume prune; shared host).
3. **Seconds-denominated locktimes on regtest** (tree expiry 7168 s, exits 512 s, boarding 1024 s).
   Reason: with block values arkd v0.9.16's indexer reports `expiresAt = createdAt + N seconds` while the
   sweeper counts N blocks; every expiry consumer (CLI, SDK, emulator OP_PUSHEXPIRY) then misreads expiry.
   Tree expiry >= 6000 s because the SDK enforces a regtest batch-expiry floor (`batchExpiry.ts:10`).
4. **Regtest intent fees = 0**, mirroring Mutinynet's advertised policy. Renewal paths still let a keeper add
   its own fee input; nonzero-fee renewal gets its own test.
5. **Contract state lives in VTXO value + held assets; scripts are constant.** arkadec's `new C(args)` accepts
   only constructor params/literals (runtime args need "dynamic taproot reconstruction", stability_offer.ark).
   Continuations use `output.scriptPubKey == input.current.scriptPubKey` plus witness version 1.
6. **Claims are native Arkade assets; issuance authority = control asset locked in the market vault.**
   arkd v0.9.16 requires the control asset to be *spent* for any reissuance (tx_validation.go:109-145) and
   exact input declarations (no silent inflation). Every vault spend path constrains YES/NO/CTRL deltas,
   because any spend of CTRL would otherwise authorize reissuance in the same tx.
