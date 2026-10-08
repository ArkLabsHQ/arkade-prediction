# Protocol specification (template v1, binary markets)

Status labels: **Implemented + tested** cites the regtest test that exercises it; **Documented limit** marks what is not provided.

## 1. Participants

| Role | Holds | Can do | Cannot do |
|---|---|---|---|
| Trader | own wallet key (browser/CLI) | sign own inputs; mint, merge, trade, redeem, cancel own offers, withdraw own claim box | move anyone else's coins |
| Maker | offer = funded standing order | go offline after funding; cancel with operator co-signature | change terms of a live offer |
| Liquidity provider (LP) | server-side wallet (`LP_MNEMONIC`) | mint sets, post asks | spend vault collateral |
| Market creator / operator wallet | genesis wallet (`OPERATOR_MNEMONIC`, or a user's browser for custom markets) | issue CTRL/YES/NO once, open the vault | reissue claims after genesis, withdraw collateral |
| Keeper | no funds needed (fees are 0 on regtest/Mutinynet), ephemeral musig session keys | renew covenant VTXOs, settle expired offers, mint-match crossing bids, submit certified resolutions, auto-claim boxes | choose beneficiaries or fees (all are fixed by covenants) |
| Oracle attestor | `ORACLE_SECRET_KEY` in a separate process | sign one payout vector per market binding | change funded terms, pick a vector the vault did not precommit |
| Arkade operator (arkd) | signer key | co-sign every offchain spend, run batches | spend covenant VTXOs without the emulator |
| Emulator | tweaked co-signer key | execute Arkade Script before co-signing | sign a spend whose covenant fails |

## 2. Assets and identity

- **CTRL** (supply 1) is issued in genesis T0 with **YES/NO** (seed supply S each) whose control asset is CTRL
  (`AssetRef.ByGroup(0)`). Asset ids are `(T0 txid, group 0|1|2)`; covenants push the txid byte-reversed.
- arkd v0.9.16 lets an existing asset grow only if its control asset is spent in the same tx
  (`tx_validation.go:109-145`), and every input's assets must be declared exactly (`:201-238`).
- T1 spends T0's CTRL output directly into the vault with S × unit collateral. `src/core/audit.ts` checks
  T0 (exactly CTRL+YES+NO issued first, further groups only transfers) and T1 (CTRL → vault script, YES/NO delta 0):
  the server before listing, the browser before its first money-moving action on a market (`src/web/verify.ts`,
  which also recomputes the binding from the displayed text). After T1 only vault covenants can spend CTRL.
- Metadata (`apm.market`, `apm.role`) is descriptive only; authority is the asset id + CTRL path.

## 3. Contracts and every spending leaf

All covenant leaves are `[arkd signer, emulator key tweaked by the covenant]`; Bitcoin consensus sees only the
2-of-2 Schnorr leaf. The covenant itself is enforced by the emulator before it co-signs (emulator `SubmitTx` /
`SubmitIntent`). Tapscript-only leaves are enforced by Bitcoin consensus.

### MarketVault (open market) — `contracts/src/market_vault.ark`
| Leaf | Who signs | Outputs allowed | Effect on claims |
|---|---|---|---|
| `mint(n)` | arkd + emulator (anyone may submit) | out0 = same script, value +n·unit, holds exactly CTRL; value ≤ cap | YES and NO each +n |
| `merge(n)` | arkd + emulator | out0 = same script, value −n·unit, CTRL kept | YES and NO each −n (burned) |
| `resolveYes/No/Invalid(evidence, sigs[3])` | arkd + emulator, after `checkTime(closeAt)` and at least `threshold` valid attestor signatures over the bound message (one slot per attestor key; empty = absent) | out0 = the precommitted ResolvedVault script, same value, CTRL kept | none; vector fixed from now on |
| `timeout()` | arkd + emulator after `checkTime(timeoutAt)` (if set) | out0 = ResolvedVault(INVALID), same value | none |
| `renew()` | emulator only on an intent proof (`tx.version == 2`) | paired intent output keeps script, value, assets (OP_TUNNEL 7) | none (YES/NO delta forced 0) |
| `unilateral` | CSV + BIP341 NUMS key — **nobody** | — | exists only because arkd refuses intents for scripts with no exit leaf |

### ResolvedVault(vector) — `contracts/src/resolved_vault.ark`
| Leaf | Who | Allowed | Effect |
|---|---|---|---|
| `redeem(y, n)` | arkd + emulator | out0 = same script, value − floor((y·n₀ + n·n₁)·unit / D), CTRL kept | burns y YES + n NO |
| `renew()` | intent only | tunnel | none |
| `unilateral` | NUMS — nobody | — | — |

### SellOffer / BuyOffer — `contracts/src/{sell,buy}_offer.ark`
| Leaf | Who | Allowed | Effect |
|---|---|---|---|
| `fill(qty)` | arkd + emulator; maker absent | output at the **offer's own input index**: continuation (same script, remainder, proceeds accumulate) or, on the final fill, maker's committed P2TR; price, min fill, expiry, reserve enforced | units move to taker |
| `settle()` | anyone after `expiresAt` | output at own index = maker's committed script; value and assets preserved (OP_TUNNEL 6) | returned to maker |
| `renew()` | intent only | tunnel | none |
| `cancel` | maker + arkd (tapscript) | anything | maker takes everything back |
| `unilateral` | maker after CSV | maker's own L1 spend | sats recovered; units are only BTC-carrier on L1 |

### ClaimBox(owner) — `contracts/src/claim_box.ark`
| Leaf | Who | Allowed | Effect |
|---|---|---|---|
| `claim()` | anyone, only as input 1 next to a ResolvedVault of this market at input 0, 2 inputs total | out1 = owner's committed script with ≥ released collateral + box sats, no assets | all claims burned at the fixed vector |
| `renew()` | intent only | tunnel | none |
| `withdraw` | owner + arkd | anything | owner takes claims back |
| `unilateral` | owner after CSV | L1 | carrier sats only |

## 4. Settlement mathematics

- Unit `u` (sats per complete set, even). Vector `(n₀, n₁)/D` with non-negative integers, `n₀ + n₁ = D > 0`.
  Template v1 precommits exactly YES `(1,0)/1`, NO `(0,1)/1`, INVALID `(1,1)/2`.
- Redemption pays `floor((y·n₀ + n·n₁)·u / D)`; merge pays `k·u`. With `u` even, every v1 payout is exact,
  so residual = vault base only. Splitting a position into many small redemptions can only lose rounding,
  never gain (floor per redemption). Exact integer math: `src/core/payout.ts` (bigint), covenant BigNum.
- Fees: none charged by covenants. Takers pay exactly the offer price; keeper match surplus
  (`qty·(p_yes + p_no − u)`) goes to the keeper output or, below 330 sats, to the YES bid.
- Carrier sats (≥ 330 per asset-bearing VTXO) are separate from collateral: vault value = base + u·sets.

## 5. Attestation binding

`message = sha256("APM/attest/v1" ‖ binding ‖ evidence ‖ num2bin(n₀,8) ‖ num2bin(n₁,8) ‖ num2bin(D,8))`,
recomputed inside `resolve*` and verified with `OP_CHECKSIGFROMSTACK` against each of the vault's three attestor
slots. An empty signature counts 0; an invalid one fails the script; at least `threshold` must verify. A single
attestor fills all three slots with its key and threshold 1; above threshold 1 the vault refuses repeated keys,
because it counts slots and one attestor could otherwise fill two (tests: threshold-oracle).
`binding = taggedHash("APM/market/v1", canonical JSON of {network, arkd signer, emulator signer, template
fingerprints, market id, definition hash (question, rules, outcomes, close, timeout, source identity), unit,
CTRL/YES/NO ids, outcome labels, oracle keys/threshold/epoch, timing})`. `evidence` is a digest of the chain facts at one
finalized Polygon block (chain, CTF contract, condition, block number/hash, payout); the resolver picks the block
and every attestor re-reads that block, so independent attestors sign the same message. A certificate for another market, network,
template, key, epoch, vector or outcome order fails the in-covenant check (tests: vault-lifecycle,
settlement-paths). Certificates never expire; double payment is prevented by claim burns, not by expiry.

## 6. Time

| Clock | Used for | Enforced by |
|---|---|---|
| Emulator wall clock (`OP_CHECKTIME`) | market close, timeout, offer expiry | emulator only |
| arkd batch expiry (`expiresAt`, seconds) | VTXO renewal deadline | arkd sweeper; keeper renews before it |
| Bitcoin MTP (CSV seconds) | unilateral exit delays, checkpoint delay | Bitcoin consensus |
| Source chain finality | resolution evidence | attestor (Polygon `finalized` tag, ≥ 2 providers) |
Arkade tx locktime is rewritten by arkd, so `tx.time` is never used as a deadline.

## 7. Numeric lifecycle (test/e2e/actions-lifecycle.test.ts, unit 1000)

| Step | Vault | Notes |
|---|---|---|
| operator opens vault with 1 seed set, base 1000 | 2,000 | operator holds 1 YES + 1 NO |
| LP mints 20 sets | 22,000 | LP 21 YES / 21 NO |
| LP posts asks 10 YES @600, 10 NO @450; goes offline | 22,000 | asks hold units + 330 sats each |
| Alice buys 4 YES (2,400); Bob buys 3 NO (1,350) | 22,000 | LP proceeds accumulate inside the asks |
| Carol bids YES @550×5, Dave bids NO @480×5; keeper mint-matches 5 | 27,000 | 5×(550+480−1000) = 150 surplus < 330 stays with Carol's bid |
| LP merges 5 sets | 22,000 | LP gets 5,000 |
| oracle attests YES; vault → ResolvedVault(YES) | 22,000 | one-shot |
| Alice redeems 4 YES | 18,000 | 4,000 paid |
| Carol redeems 5 YES | 13,000 | 5,000 paid; remaining 12 winning YES (LP 11 + operator 1) back 12,000 + base 1,000 |

## 8. Serialization and bottlenecks

- One vault UTXO per market serializes mint/merge/resolve/redeem for that market (each is one Arkade tx,
  sub-second on regtest). Trades do not touch the vault; each offer is its own UTXO.
- No sharded collateral: shared backing across shards would need cross-shard accounting that the verified stack
  does not provide; fungible claims could otherwise drain one shard.
- Renewal batches many covenant VTXOs per intent (tested with 3); keeper runs them sequentially as the single writer.
