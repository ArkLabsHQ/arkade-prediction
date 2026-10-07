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
7. **Genesis in two txs.** T0 issues CTRL(1) + YES/NO(seed) with control = CTRL (ByGroup); T1 spends T0's
   CTRL output directly into the vault with seed x unit collateral. Asset ids are fixed by T0, so the vault
   script can name them (one tx cannot: the vault script would depend on its own txid). Activation audits
   T0/T1 from indexer data; after T1 only vault covenants can reissue.
8. **One-shot resolution to precommitted ResolvedVault scripts** (YES [1,0]/1, NO [0,1]/1, INVALID [1,1]/2).
   The open vault moves its whole balance once; redemptions then use the vector fixed in the script, so an
   equivocating oracle can pick the winner but cannot make the vault pay two vectors (insolvency).
   Rejected: per-redemption oracle signatures (equivocation => inconsistent payouts across redemptions).
9. **Attestation is verified in the covenant:** message = sha256("APM/attest/v1" || binding || evidence ||
   num2bin(n0,8) || num2bin(n1,8) || num2bin(D,8)); binding commits network, keys, templates, market, terms,
   claim ids, source and oracle policy. Rejected: compiler example pattern of verifying a caller-supplied hash.
10. **Timeout = precommitted INVALID vector** (50/50 per complete set) after `timeoutAt` (emulator clock),
    mutually exclusive with attested resolution because both consume the same open vault.
11. **Vault exit leaf = CSV + BIP341 NUMS key (unspendable).** arkd v0.9.16 refuses intents for VTXOs with no
    exit leaf ("failed to get smallest exit delay: no exit leaf"), so renewable contracts need one; any
    signable exit could withdraw collateral backing other holders. Consequence: pooled collateral has no
    unilateral exit; claims' economic value depends on arkd + emulator (documented in threat model).
    Next step if needed: CSV + anyone-key + emulator-tweaked L1 covenant via SubmitOnchainTx (untested upstream).
12. **Keeper renewal** = emulator-signed intent proof tunnelling each covenant VTXO (vin k+1 -> vout k), musig
    session key only, forfeits co-signed by the emulator. Proven for the CTRL-holding vault (renewal.test.ts).
13. **Node EventSource** via the `eventsource` package + `configureEventSource` (SDK batch streams are SSE).
