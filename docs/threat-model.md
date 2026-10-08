# Threat model, trust and recovery limits

## 1. What enforces what

| Rule | Enforced by | Evidence |
|---|---|---|
| Unilateral exit of plain BTC VTXOs (CSV + owner key) | Bitcoin consensus after unroll | withdrawal.test.ts (keyless pre-signed exit recovered 59,702 sats) |
| Every offchain spend co-signed by the operator | Bitcoin consensus on the 2-of-2 leaves, arkd policy | all e2e |
| Covenant rules (collateral, vectors, prices, recipients, tunnels) | **emulator** before co-signing; arkd cannot spend covenant leaves alone | covenant-refusal assertions in vault-lifecycle, offers, renewal, claim-box, settlement-paths |
| Asset conservation / control-asset reissuance | **arkd** asset validation (v0.9.16) and the emulator's packet checks | vault-lifecycle (mint without collateral refused) |
| Oracle outcome | oracle signature checked **in the covenant**; source truth is the attestor's read of Polygon finalized state | settlement-paths, polymarket-live |
| Close / timeout / offer expiry | **emulator wall clock** (`OP_CHECKTIME`) | settlement-paths, offers |
| Market listing, order book, keeper scheduling | server (holds no user keys; see §2a for what it can still do) | server-flow, fault-recovery |

Extended Arkade opcodes are not Bitcoin consensus rules. Anyone who controls both the arkd signer and the emulator
key can sign any spend of a covenant VTXO; the covenants protect users against everyone else (makers, takers,
keepers, the market creator, the server, the LP and the attestor).

## 2a. What a compromised app server can do

The server holds no user keys and cannot sign covenant spends, but it is not powerless:

- **It serves the UI bundle.** Malicious JavaScript can steal a user's keys. Client-side checks (genesis audit,
  binding recomputation, offer asset checks) protect users only when the UI comes from a source they trust:
  a self-built copy of `src/web` or a CLI using `src/core`, pointed at the API.
- **It serves market terms and offer listings.** A trusted client audits them against the indexer before moving
  money; an untrusted client cannot tell forged terms from real ones.
- **It can withhold certificates.** Only the server asks the attestor to sign. If it never does, an imported
  market reaches its timeout and anyone can settle it as INVALID (50/50) instead of the true outcome.
- **It can delay** matching, renewals and auto-claims; delayed renewals end in the sweep case of §3.

## 2. Spending authority over pooled collateral

No single key can withdraw vault collateral. The vault's only non-covenant leaf is a CSV leaf locked to the BIP341
NUMS point, which exists because arkd v0.9.16 refuses intents (renewal) for scripts without an exit leaf. The market
creator, the LP and the server operator have no leaf over the vault at all.

## 3. Failure scenarios (who keeps what)

| Failure | Plain BTC (wallet, payouts) | Open claims (YES/NO in wallet or box) | Collateral in vault | Orders |
|---|---|---|---|---|
| Server / keeper down | unaffected | unaffected; users can mint, merge, trade P2P and redeem with the SDK/CLI | unaffected | makers cancel themselves; nothing renews: VTXOs approach expiry (see below) |
| Keeper down past VTXO expiry | user must renew own coins (wallet settle) or exit | expired claim VTXOs are swept by arkd → recoverable only with operator cooperation | expired vault swept by arkd → recoverable via intent only with operator cooperation | same as claims |
| Attestor down / source unresolved | unaffected | value pending; merge of complete sets always works | stays locked until attestation or the precommitted timeout (INVALID) | trading continues |
| Server withholds the certificate, or source metadata changes (quarantine) | unaffected | at timeout anyone can settle INVALID (50/50); winners lose the difference | paid per the INVALID vector | — |
| Source oracle corrupted (wrong final payout on Polygon) | — | mirrored claims pay the corrupted vector; the attestor cannot repair it | paid out per that vector | — |
| Attestor key compromised / equivocates | — | attacker can pick YES/NO/INVALID for markets bound to that key; **cannot** make a vault pay two vectors (one-shot resolution) | paid per the first resolution submitted | — |
| Emulator unavailable | offchain BTC moves still work through arkd | covenant spends stop: no mint/merge/fill/redeem/renew | frozen (not lost) | fills stop; maker cancel still works (maker+arkd leaf) |
| arkd censors or disappears | unroll + CSV exit of BTC VTXOs (proven) | **economic value not recoverable**: unilateral exit is BTC-only (SDK README:911); claims recover only their 330-sat carrier | **no unilateral path** (NUMS leaf); after the batch expires the operator's sweep leaf takes it, so it comes back only through the operator | maker exits own offer coin after CSV (carrier + accumulated proceeds) |
| arkd + emulator collude | — | can steal | can steal | can steal |

Long-lived markets therefore depend on (a) a live keeper renewing covenant VTXOs before batch expiry (proven while
the user is offline: renewal.test.ts, claim-box.test.ts, deployed container renewed 7 VTXOs in one batch) and (b) the
operator and emulator being honest and available. This is reported as a limitation, not solved.

## 4. Source and oracle trust

- Source trust: Polymarket's UMA/CTF resolution. Mirroring adds local exposure without adding to the source's
  bonds; per-market collateral is capped on-contract (`capValue`, `MARKET_CAP_SETS`).
- Transport trust: each market commits 1 to 3 attestor keys and a threshold (default 1-of-1; `ORACLE_THRESHOLD=2`
  with three keys gives 2-of-3). A quorum only adds independence if the attestors run on separate infrastructure
  under separate operators; three keys in one place are one attestor. Below the quorum, nothing resolves and the
  timeout applies.
  The attestor re-reads the market definition and the finalized CTF payout from ≥ 2 Polygon providers that must
  agree on block hash and values, rejects unknown resolvers/versions/neg-risk/outcome-order changes, and signs a
  message bound to deployment, template, market, claims, outcome order, vector and evidence digest.
- Not a light client: the attestor trusts its RPC providers' view of Polygon finality.
- Quarantine: identity changes (resolver, condition, outcome labels or order, question text, protocol version)
  make the attestor refuse (`409 identity`) and the server shows the status; activation of new markets stops for
  unknown profiles. Quarantine is a veto: such a market can only settle INVALID at its timeout.
  The server cannot stop users from minting through the permissionless covenant; the on-contract cap bounds that.
- Early source resolution: once per resolution interval the server reads `payoutDenominator` for every open
  imported market in one batched call per Polygon provider; a finalized payout reported by >= 2 providers halts
  trading in the app until close. Resting covenant offers stay fillable on-contract until their makers cancel
  them, so the halt protects the LP (its offers are cancelled and expire at close) more than other makers.

## 5. Keeper powers

Keepers hold no user keys. Every keeper transaction is covenant-constrained: renewals must tunnel script, value
and assets to the paired output; settles pay the maker's committed script; mint-matches pay each bid exactly its
price-bounded fill and the vault exactly `qty × unit`; auto-claims pay the box owner everything released.
A keeper can only choose *when* (or whether) to act and receives match surplus. A malicious keeper could delay
renewals until expiry (see §3) or front-run fills; it cannot redirect funds.

## 6. Time

Close and timeout use the emulator's clock, not Bitcoin time; a misconfigured emulator clock can open resolution
early or late. Arkade tx locktime is rewritten by arkd and is never used as a deadline. CSV exit delays are
Bitcoin-enforced (median time past).

## 7. Known residual risks

1. Oracle equivocation picks the winner of the race to resolve; detected and shown (`conflicting-certificates`).
2. Operator signer rotation: covenant leaves commit to the current arkd key; after rotation, existing contract
   VTXOs need deprecated-signer cooperation to move (not exercised).
3. Fee policy changes: renewals preserve value exactly; nonzero intent fees would need a keeper fee input
   (not implemented; Mutinynet and regtest advertise zero fees, preflight checks it).
4. A stray coin paid to a vault or offer script is ignored (vault = coin holding CTRL; offers follow their own
   coin lineage) but stays unspendable by the covenants.
5. A halt after early source resolution is enforced by the app only; other clients can still fill resting offers
   until their makers cancel them.
6. An Arkade transaction arkd accepted but nobody finalizes leaves its inputs spent and its outputs missing.
   The keeper finalizes its own wallet-funded transactions from stored checkpoints; for covenant transactions
   the emulator finalizes, and if it never does the workflow waits in `submitting` (visible in the overview)
   because nothing on our side can complete it.
7. Swept offer coins are marked `gone`; recovering them through the keeper's renewal path is not implemented.
8. The browser audit assumes the indexer keeps a market's genesis and vault transactions for the market's
   lifetime; if it prunes them, money actions on old markets are blocked rather than allowed.
9. Every output of an Arkade transaction inherits the batch expiry of the coins it spends. Claims paid out of a
   vault the keeper is about to renew can therefore expire within the renewal threshold (default 1 h). A holder
   who stays offline must receive into a claim box (renewed by the keeper) or renew with their own wallet; a
   regtest drill lost unrenewed test coins this way when they descended from an old batch.
