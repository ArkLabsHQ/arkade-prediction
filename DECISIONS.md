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
14. **User keys stay in the browser.** The UI derives the wallet from a mnemonic kept in localStorage encrypted
    with PBKDF2-SHA256 (600k iterations) + AES-GCM and signs every user transaction client-side. The server holds
    only its own operator and LP wallets. Offline actions on users' behalf go through covenants that need no
    user key (offers, claim boxes, keeper renewal). Rejected: server-held user keys or unrestricted delegation.
15. **Claim boxes for offline payout.** A holder can park claims in a `claim_box` covenant that anyone may renew
    (tunnel) or redeem after resolution, paying everything to the owner's committed script. Keeps the "auto-claim
    while offline" promise without giving the keeper spending authority.
16. **Separate attestor process.** `src/oracle/main.ts` holds the oracle key, pins network/operator/emulator,
    re-reads the source itself and signs only finalized CTF payouts; the server relays certificates and verifies
    them against the market's pinned key before use. Rejected: signing inside the app server (one compromise
    would control both funds routing and outcomes).
17. **Single writer per volume.** A SQLite lease with a fencing token; every workflow transition is a conditional
    update on (id, state, token). API-only processes (`WORKERS=none`) may share the volume.
    Rejected: multi-writer with row locks (SQLite) or an external coordinator (operational weight for a PoC).
18. **Write-ahead submission and reconciliation.** Keeper workflows record txid + input outpoints before
    submitting; on restart the indexer classifies them as landed / not-submitted / lost / unknown, so a crash on
    either side of submission never duplicates a match or a resolution (fault-recovery.test.ts).
19. **The vault is the coin that holds CTRL.** Coins paid to a vault script by anyone else are ignored by client
    actions and server reconciliation (they would otherwise make vault lookups ambiguous).
20. **Final offer fill pays the maker directly.** A zero-asset continuation would make the emulator's asset
    opcodes fail ("no asset packet vin=0"); expiry settlement tunnels value and assets to the maker.
21. **Coin selection reads the indexer**, minus a process-wide recently-spent set (5 min TTL), and retries while the
    indexer catches up. Rejected: the SDK wallet cache, which lagged behind covenant spends and double-selected.
22. **Genesis may carry existing assets** as transfer groups after the three issuance groups (ByGroup(0) still
    names CTRL). The admission audit requires exactly three issuance groups and transfers only after them.
23. **Polymarket profile = CTF v1 binary only.** conditionId recomputed from resolver + questionId, payout read at
    the Polygon `finalized` tag from >= 2 providers that must agree, resolver allowlist, neg-risk and non-binary
    rejected, Gamma treated as untrusted discovery data. Imported markets time out to INVALID
    `IMPORT_TIMEOUT_DAYS` (default 60) after close.
24. **Packaging for Dokploy.** One image for app and attestor, explicit variable passthrough in `compose.yaml`
    (Dokploy passes only referenced variables), named volumes, the HTTP port `expose`d rather than published
    (the local override publishes it), secrets via environment or `*_FILE`, no build arguments.
25. **Offers are tracked by coin lineage, not by script.** Refresh follows the tracked outpoint through its
    spending Arkade tx (input index via the checkpoint txid, continuation at the same output index) or its renewal
    batch, recording one trade per hop. Rejected: "newest unspent coin at the script", which let anyone hijack an
    offer's tracking by paying a stray coin to its public script.
26. **Failed workflows re-arm.** Ids are deterministic, so `enqueue` revives a failed row after a growing cooldown
    (2 min to 1 h), keeping recorded progress and dropping per-attempt fields; `lost` submissions rebuild from
    fresh state. Multi-step workflows record the in-flight step, so a landed sub-transaction is progress, not
    completion. Rejected: terminal failure (a contended resolve left markets unresolvable).
27. **Interrupted arkd submissions are finalized, not resubmitted.** arkd v0.9.16 marks inputs spent on accept,
    creates outputs on finalize, and refuses a duplicate submission; finalization is keyed by txid and repeatable.
    The keeper stores signed checkpoints before finalizing and repeats finalization on recovery
    (finalize-recovery.test.ts crashes between accept and finalize and observes exactly this).
    Reconciliation decides from the inputs and outputs, never from the transaction's presence alone: arkd also
    lists submissions it recorded and then failed.
28. **Clients audit markets themselves.** `src/core/audit.ts` (shared by server and browser) checks genesis and
    vault from indexer data; the browser also recomputes the binding from the text it displays and checks every
    offer leg's asset and script. This protects users of an independently served UI; a compromised server that
    serves the UI bundle is out of reach of any client check (threat model §2a).
29. **Early source resolution halts trading.** One batched `payoutDenominator` read per Polygon provider per
    interval screens open imported markets; a finalized payout reported by >= 2 providers, confirmed by the full
    verifier, sets `source-final` and the market shows `halted` until close (also when a certificate arrives
    early). LP offers expire at close and are cancelled on halt. The covenant still refuses resolution before
    close: making early resolution possible would change the template.
30. **The attestor checks what it signs.** Besides the source identity it requires the definition's outcome labels
    (in order) and question to match the live source, so a server cannot obtain a certificate for a mirror with
    swapped labels or a negated question.
31. **E2E funding comes from fresh notes, and the suite mines first.** Coins inherit the batch expiry of what
    they spend, so funding tests from the stack's long-lived CLI wallet produced coins that were swept mid-test.
    Each test process now redeems a small operator note into a new batch through an SDK wallet (with deadlines),
    and the e2e global setup mines 12 blocks so arkd's sweeper can reclaim expired batches; without blocks its
    liquidity drained until batches stalled.
32. **Threshold attestation in the vault (template v2).** The vault has three attestor slots and a threshold; each
    resolve leaf counts valid `OP_CHECKSIGFROMSTACK` results (empty signature = absent) and requires the quorum.
    Repeated keys are allowed only at threshold 1 and refused on-chain above it, because the vault counts slots.
    Attestors sign evidence for a block the resolver pins, so their messages match. Markets on the retired
    single-key template are marked failed by migration 3. Rejected: per-pair leaves (9 resolve leaves) and
    MuSig/FROST aggregation (one signature would hide which attestors agreed and needs interactive signing).
33. **Pins and endpoints are optional.** On Mutinynet the server and attestor default to Arkade's published Ark
    server and emulator hosts and the SDK's Esplora URL, read the operator key from `/v1/info`, and use the SDK's
    per-network emulator pin (never the emulator's self-report). Explicit pins remain as overrides. Safety against
    a silent key change comes from the volume identity guard. Regtest keeps explicit endpoints (local ports).
34. **One container for a proof of concept.** `ORACLE_SECRET_KEY` on the app starts the attestor as a supervised
    child bound to `127.0.0.1`, as the market's only key (1-of-1). It stays a separate process holding the key, but
    the app operator now also controls resolution of imported markets; separate attestors (`compose.attestors.yaml`)
    remain the way to a quorum that adds independence.
35. **Admin API on its own port, without a token.** `/api/admin` and the operator console are mounted only on
    `ADMIN_PORT`, which the deployer protects at the edge; the public port returns 404 for them. Browser requests
    that `Sec-Fetch-Site` marks cross-site are refused, so edge credentials cannot be ridden by another page.
    No `Host` allowlist: the edge routes by host, and the container port is not published.
36. **Mirror Polymarket broadly.** Neg-risk outcomes (most of Polymarket's catalogue) are binary CTF conditions whose
    oracle is the NegRiskAdapter (`conditionId = keccak(adapter, questionID, 2)`, checked on live markets), so they
    settle through the same `payoutNumerators` read. They are admitted only when the adapter is in
    `POLYMARKET_RESOLVERS`; "Other" placeholders and markets with missing flags stay refused, because their meaning
    can change. A `negRiskAdapter` key is added to the hashed protocol only for those markets, so no existing
    `versionHash` moves. Discovery is ordered by 24-hour volume, and the LP's opening asks are the source's
    reference price plus 2% per side (fixed asks remain the fallback, and both legs must sum above the unit).
    Sports markets close at Polymarket's `endDate`, which is the game start (`gameStartTime`); Polymarket clears
    its own book then (`clearBookOnStart`), and our LP never reprices, so in-play trading would only let informed
    takers drain it. Resolution still follows the game, from the finalized CTF payout.
    The LP follows the refreshed source odds: an ask that drifts by 3% of the unit or more is cancelled on-contract
    and what is left of it re-posted at the new price (`lp-reprice`, two transactions per ask).
    Import skips markets whose `gameStartTime` has passed (`started`) or whose reference price is at least 0.98
    (`decided`): a halted import holds an `IMPORT_MAX_ACTIVE` slot until its close, which for sports can be a week
    after the game (Polymarket 5175509 was activated after it had already settled).
37. **ECDSA attestor keys.** Attestor slots also take the emulator's extended keys (0x10 ECDSA/secp256k1, 0x11
    ECDSA/P-256, each + a compressed key), so HSM, cloud-KMS or passkey attestors can sign our 32-byte attestation
    message. The SDK checks `pubkey` parameters for 32 bytes, so such sets use `market_vault_anykey` (the vault with
    `bytes[3] oracles`, derived by `contracts/build.mjs`); all-Schnorr sets keep the original vault byte for byte,
    so existing markets need no migration. High-S ECDSA is accepted, as the emulator does.
