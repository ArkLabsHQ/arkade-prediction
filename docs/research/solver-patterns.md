# Solver patterns: intent-solver and banco

Read-only review, 2026-10-07. Every claim carries a citation and a label:

- **CONFIRMED**: read at the cited lines. A claim that something is absent means a repo-wide grep came back empty, and the bullet says so.
- **INFERRED**: reasoned from the cited code but not run. The bullet says what would confirm it.

Path legend:

| Prefix | Location |
|---|---|
| `IS` | `_apm-src/intent-solver` @ `ecc1c24`. `IS:arkade/` = `packages/solver-arkade/src/arkade/`, `IS:corr/` = `packages/solver-corridors/src/`, `IS:app/` = `packages/solver-app/src/`, `IS:db/` = `packages/solver-db/src/`, `IS:core/` = `packages/solver-core/src/` |
| `BC` | `_apm-src/banco` @ `428ae68` |
| `SDK` | `_apm-src/ts-sdk/packages/ts-sdk/src` @ `8020c3d4` (package version 0.4.78, the same as ours) |
| `SW` | `_apm-src/ts-sdk/packages/swap/src` (`@arkade-os/swap` 0.0.24, banco's maintained successor) |
| `EMU` | `_apm-src/emulator/README.md` (opcode table) |

Version note: IS pins `@arkade-os/sdk` 0.4.77 and `@arkade-os/swap` 0.0.23 (IS `package.json:27,52`; `packages/solver-arkade/package.json:29,31`). Every SDK name IS imports still exists in 0.4.78 (SDK `index.ts:115-847`, plus the `export *` lines at 468-472). CONFIRMED

## A. intent-solver

### 1. Workflow persistence and legal state transitions
- There is no workflow engine. Each corridor has a SQLite table and a matching `*_event` table, plus a hand-written `LEGAL_EDGES` map and NON_TERMINAL/EXPOSED state sets (IS:corr/db/receiveSwaps.ts:34-51, 225-244). CONFIRMED
- `transition(id, from, to, fields)` throws on a non-edge, which it treats as a caller bug. Otherwise it runs `UPDATE … SET state=? … WHERE id=? AND state=?` and treats `changes===1` as the race winner; the loser gets `false` (IS:corr/db/baseSwapStore.ts:286-316). Writable columns are allowlisted per method (baseSwapStore.ts:70-74; receiveSwaps.ts:56-80). CONFIRMED
- `fail()` sends exposed states to `stuck` (needs a human) and everything else to `refused` (baseSwapStore.ts:330-337). CONFIRMED
- The event INSERT runs as a separate statement after the CAS, outside any transaction (baseSwapStore.ts:307-314). A crash between the two would lose an audit row but never state. INFERRED from the code shape
- Driver loop: `tick(id)` runs `while (await step(row))` and re-reads the row on every step. A process-local `inFlight` set stops re-entry (IS:corr/send/orchestrator.ts:703-741; IS:core/util/sweep.ts:43-60). `tickAll` re-drives every NON_TERMINAL row and `tickHot` only the exposed ones (orchestrator.ts:755-780). Per-row errors are isolated (sweep.ts:9-41). CONFIRMED
- Cadences: HOT_TICK 250 ms, WATCH_SYNC 500 ms, FULL_SWEEP 3 s, REFUND_SWEEP 60 s, VTXO_LIFECYCLE 300 s (IS README.md:899-903). On boot the process re-drives every non-terminal row: "the row is the truth" (IS docs/runbook.md:62-66). CONFIRMED
- Natural keys are protected by partial UNIQUE indexes over live states only: one live swap per payment hash (receiveSwaps.ts:228-229) and one live fill per offer outpoint (IS:corr/db/offerFills.ts:124-129). CONFIRMED

### 2. Write-ahead of identity, and ambiguous submissions
- **Lightning pay.** Intent is committed before `payInvoice` by a CAS `funded→paying` that writes `pay_attempted_at` and a deterministic idempotency key `swap-<paymentHash>` (orchestrator.ts:1064-1075). On resume without a payment id, the backend is probed by hash before anything is resubmitted. If the probe contradicts the backend, the row is parked after a grace window (orchestrator.ts:1078-1141). CONFIRMED
- **L1 transactions** (txid known before broadcast). Order is sign → `patch(onchain_claim_txid)` → `broadcastRaw` (IS:corr/receive/onchainOrchestrator.ts:878-883). On resume, `transactionOutcome(txid)` decides: confirmed means settle, mempool means wait, `unknown` means rebuild at today's fee (onchainOrchestrator.ts:789-794, 913-918). CONFIRMED
- **Arkade `wallet.send`** (txid NOT known before submit, because the SDK builds, signs and submits internally). Before spending, the worker wins a DB lease with no TTL: `UPDATE … SET fund_started_at=now WHERE … fund_started_at IS NULL` (baseSwapStore.ts:339-355; IS:corr/receive/orchestrator.ts:928-931). On error the lease is released ONLY for `FundNotSubmittedError` (orchestrator.ts:955-967). CONFIRMED
- "Definitely not submitted" is a closed set: selection or refusal failures before any request exists, and `ArkError` code 15 `AMOUNT_TOO_LOW`. Every other throw counts as ambiguous ("a lost response cannot be told from a rejection") and is rethrown unwrapped (IS:corr/receive/fundLockup.ts:27-39, 71-85, 113-116). CONFIRMED
- **Crash recovery is adoption-first.** Before any gate runs, the worker reads every outpoint the lockup script ever held, spent ones included, and adopts the one matching the persisted payout value exactly (orchestrator.ts:798-833). A row that holds the lease with nothing to adopt just waits (orchestrator.ts:835). After a send, the worker polls the indexer for its own txid and then runs the CAS `armed→funded` (orchestrator.ts:970-997). CONFIRMED
- Known hole: a crash between taking the lease and a payment that never landed leaves the row stuck with nothing that can retry it. The runbook makes this an operator procedure and says it "needs wallet-level idempotency" (runbook.md:778-788). CONFIRMED
- **Custom-script Arkade spends** (claim and refund) build the ark tx locally, but its id is NOT persisted before `submitTx`. `submitted.arkTxid` is returned only after `finalizeTx` (IS:arkade/wallet.ts:540-583, 813-856). Recovery re-reads the script instead: an empty lockup with no recorded claim txid goes to `stuck`, never to `claimed` (orchestrator.ts:1607-1627; runbook.md:574-576). CONFIRMED
- **SDK pending-tx recovery.** For `wallet.send`, the SDK sets a persisted pending flag before `submitTx` and clears it after `finalizeTx` (SDK wallet/wallet.ts:6209-6219). Recovery is `finalizePendingTxs()` (wallet.ts:4971-4980), and the only automatic caller is the service-worker handler (SDK wallet/serviceWorker/wallet-message-handler.ts:1800). IS never calls it (repo grep empty). CONFIRMED So a Node process that crashes mid-send stays pending until something calls it. INFERRED; confirm by killing the process between submit and finalize, then restarting
- **Offer fills** (the keeper analogue): insert the intent as `fillable` (one live row per outpoint), CAS `fillable→filling` BEFORE submitting, then move to `filled` with the txid. Any throw lands in `stuck`; this path has no not-submitted/ambiguous split (IS:app/ops/assetOffers.ts:351-391). CONFIRMED

### 3. VTXO reservations
- The ledger is process-local, in-memory and counted, keyed by `txid:vout`, with idempotent release. It is deliberately not persisted, to avoid "a stale pin outliving the crash", and it assumes ONE process per wallet (IS:arkade/reservations.ts:1-19, 38-61). CONFIRMED
- Reservations are enforceable only because funding names its own inputs (`send({selectedVtxos})`) instead of letting the SDK choose (IS:arkade/lockupFunding.ts:20-24; fundLockup.ts:95-109). Inputs are pinned for the duration of the send and released in `finally` (fundLockup.ts:69, 117-122). CONFIRMED
- Renewal reads `getExpiringVtxos` minus `reserved()` (IS:app/ops/float.ts:232-236). SDK calls that pick their own inputs cannot take an exclusion list, so the code pins migration candidates from outside. It accepts a leftover race in which the migration loses with `VTXO_ALREADY_SPENT` (float.ts:166-207). CONFIRMED
- Limits: no TTL, no persistence, no cross-process visibility. The runbook forbids replicating the container and says to scale as "N solver identities: N containers, N mnemonics" (runbook.md:127-132). CONFIRMED

### 4. Pool shaping and VTXO lifecycle
- Why a pool: with one coin, the first in-flight funding pins the whole float and the next swap is refused (IS:arkade/vtxoPool.ts:4-9). The target has two rungs, `maxSats/4 × 2c` and `maxSats × (c+1)`, where `c = floor(maxExposed/maxSats)` (vtxoPool.ts:74-81). `planPool` splits coins below a coin-count ceiling and merges above it, and never pins the latest-expiring "keeper" coins (vtxoPool.ts:101-259). CONFIRMED
- Funding picks coins LATEST-expiry first, the inverse of the SDK's `selectVirtualCoins`. It prefers coins that outlive the refund horizon but falls back to others rather than refusing. Asset-bearing coins count as `value - dust` (lockupFunding.ts:4-18, 140-232). CONFIRMED The authors' own note says child VTXOs inheriting expiry is inferred, not observed (IS:arkade/vtxoLifecycle.ts:42-46). CONFIRMED that they flag it
- Renewal is IS's own code, not the SDK's `renewVtxos`:
  1. Gated `getExpiringVtxos` with a 3-day threshold.
  2. A per-coin "due" check whose threshold is capped at half the coin's own lifetime, to avoid a fee treadmill.
  3. `wallet.settle({inputs, outputs})`, with outputs pre-split into the pool shape and each piece priced through the `Estimator` CEL fee.
  4. At most 50 inputs and 8 outputs.

  (vtxoLifecycle.ts:303-374, 420-523; vtxoPool.ts:261-382; float.ts:225-244) CONFIRMED
- `settlementConfig: false` turns off the SDK's own 60 s poll and renewal, so the service is the only renewal authority. Their e2e had seen `INTENT_INSUFFICIENT_FEE` from the SDK's concurrent pass (wallet.ts:284-308). CONFIRMED
- Escrow protection: lockups are registered as `vhtlc-v2` contracts, which answer `isGenericallySpendable: false`, so the gated reads used by renewal and funding never touch them. `recoverVtxos` is ungated and all-or-nothing, so recovery is skipped while any immature or not-ours lockup sits in the sweep set, with a 90-min median-time-past margin (vtxoLifecycle.ts:14-19, 80-116, 624, 631-746). CONFIRMED
- Delegation: none. The SDK offers `delegatorProvider` (SDK wallet/index.ts; providers/delegate.ts), but IS never references it (grep). CONFIRMED
- Ops trap: a no-argument `settle()` consolidates the float onto one asset-bearing coin that cannot fund sats. The fix is `cli pool --mint` (runbook.md:618-648). CONFIRMED

### 5. Contract watcher
- Push events are nudges, never evidence. `LockupWatcher` forwards only script names, and the tick re-reads through `findLockups`, a paged indexer query that is the authority (IS:arkade/lockupWatcher.ts:1-20, 143-171; wallet.ts:376-409; IS:app/cli.ts:309-339). CONFIRMED
- Catch-up: each script is nudged right after its watch lands and again on `start()`; `connection_reset` nudges every watched script (lockupWatcher.ts:99-134, 143-153). The watched set is re-derived from `findRecoverable()` on every sync, fire-and-forget (cli.ts:385-402). Attaching to the contract manager retries with backoff from 1 s to 30 s (IS:arkade/lazyContractSource.ts:31-32, 60-89). CONFIRMED
- SDK 0.4.78 underneath: `watchScript(string|string[])` delivers at least once. Registration lives in memory, so it re-announces after a restart. The failsafe poll runs every 20 s, reconnect backs off from 1 s to 5 s with unlimited attempts, and a drop emits `connection_reset` (SDK contracts/contractManager.ts:600-628; contracts/contractWatcher.ts:29-40, 492-538). IS watches one script per call (lockupWatcher.ts:101-104), although passing a set costs a single subscription update. CONFIRMED
- Paging: `vtxoPages` fetches 500 per page, at most 1000 pages, and throws if the server does not advance (IS:arkade/indexerPaging.ts:13-36). An empty read means lag, never proof of a spend (`lockupSpendEvidence`, wallet.ts:499-516). CONFIRMED
- Offer discovery cannot use `subscribeForScripts`, because maker scripts are not known in advance. IS therefore speaks raw gRPC with the CEL filter `has(tx.extension) && hasPacket(tx.extension, 3)`. The stream counts as stale after 180 s and reconnects with backoff from 1 s to 10 s (IS:arkade/offerStream.ts:1-20, 102-147; grpcWire.ts:1-13). CONFIRMED It has no backfill for offers funded during a gap: there is no replay or catch-up code in offerStream.ts. CONFIRMED absence
- Doc drift: IS README.md:907 cites `DEFAULT_RECONNECT_MS` in lockupWatcher.ts, but no such constant exists anywhere in `packages/` (grep). CONFIRMED

### 6. SQLite configuration and migrations
- Driver: better-sqlite3 behind an async `SqlDriver` port, with Cloudflare D1 as the alternative (IS:db/driver.ts:8-68; IS:core/core/driver.ts:17-36). Pragmas are `journal_mode=WAL` and `synchronous=FULL`, because "the most recent commit is … the one recording that we are about to spend money" (driver.ts:23-27). CONFIRMED
- No `busy_timeout` is set anywhere (grep), so better-sqlite3's constructor default applies. Its docs give 5 s. INFERRED; the package is not installed locally to check
- `transaction()` wraps an ASYNC function in a manual `BEGIN IMMEDIATE` on the shared handle (driver.ts:45-57). Its only caller is a legacy table rebuild (IS:corr/db/swaps.ts:506-530). Any other code awaiting on that handle mid-transaction would silently join it. INFERRED
- The SDK's `SQLiteWalletRepository`/`SQLiteContractRepository` use a separate better-sqlite3 handle with WAL only, and `close()` checkpoints the WAL (IS:arkade/wallet.ts:56-72, 263-271). CONFIRMED
- Migrations: `CREATE TABLE IF NOT EXISTS` plus additive `addColumns` (PRAGMA `table_info`, then `ALTER TABLE ADD COLUMN`, with identifiers and types regex-guarded) (baseSwapStore.ts:82-101; receiveSwaps.ts:372-399). There is one SQLite-recommended table rebuild, inside a transaction (swaps.ts:506-530). There is no schema-version table (grep for `user_version` empty). Layout: fresh deployments use one file; legacy deployments keep five files that are never merged (IS:corr/db/layout.ts:3-10, 53-79). CONFIRMED

### 7. Single-writer, fencing and ownership
- Nothing enforces a single writer: no pidfile, lockfile, `locking_mode` or fencing token (grep empty). Single-writer is a runbook rule (runbook.md:127-132) and an assumption written into reservations.ts:17-18. CONFIRMED
- Safe across processes: CAS transitions, the fund lease, payment-hash idempotency and the partial unique indexes. On that basis the runbook says Workers + cron + queue consumers can run concurrently (runbook.md:275-278). NOT safe across processes: coin selection and reservations ("coin selection is per-process", IS:corr/receive/onchainOrchestrator.ts:659-665). CONFIRMED

### 8. Runbook and perf: throughput, latency, limitations
- 100 mixed swaps on regtest, one machine, 2026-08-11: 100/100 succeeded in 209.1 s wall, which is 0.48 swaps/s or about 2.1 s per swap sustained (runbook.md:1849-1852). CONFIRMED
- Lightning-send TOTAL median was 848 ms at n=4 and 14,032 ms at n=100; `indexer_visible` went from 20 ms to 3,657 ms (runbook.md:1857-1863). CONFIRMED
- There is no admission ceiling: the stack "queues rather than sheds" (runbook.md:1867-1869). The receive leg is dominated by `solver_arm_and_fund`, 90.7 s median (runbook.md:1880-1882). CONFIRMED
- 20 Lightning sends at concurrency 5/10/20 gave TOTAL medians of 5.3/7.9/9.7 s; `solver_deliver` is the phase that scales with concurrency (runbook.md:1893-1908). CONFIRMED
- The perf test asserts terminal success only, never timings, and its phases carry up to 250 ms of poll quantisation (IS test/perf/swapThroughput.perf.ts:83-94). CONFIRMED
- "A 1-vCPU box runs hundreds of concurrent swaps" is stated with no measurement in that section (runbook.md:123-126). CONFIRMED
- Known limits: no server-independent claim, and the cooperative refund needs both the server and the emulator alive (runbook.md:658-664). CONFIRMED

### SDK APIs intent-solver calls (all present in 0.4.78; CONFIRMED)
| Need | Call(s) | Where |
|---|---|---|
| Custom-script offchain tx | `buildOffchainTx(inputs{tapLeafScript,tapTree}, outputs, wallet.serverUnrollScript)` → `identity.sign` → `arkProvider.submitTx` → `assertSubmittedArkTxid` + `matchServerCheckpoints` → sign the server's checkpoints at `[0]` → `arkProvider.finalizeTx` | IS:arkade/wallet.ts:550-582 |
| Covenant spend via emulator | same build plus `setArkPsbtField(PrevArkTxField)`; `Extension.create([EmulatorPacket.create(per-vin), assetPacket])` inserted before the P2A anchor; `new RestEmulatorProvider(url).submitTx`; check returned id == local id | wallet.ts:593-600, 698-781 |
| Wallet send | `wallet.send({recipients:[{address, amount, extensions?, tapTree?}], selectedVtxos})`; `getSpendableVtxos({withRecoverable:false, genericallySpendableOnly:true})` | fundLockup.ts:25, 95-109, 158-160 |
| Settle / renew | `getVtxoManager()` → `getExpiringVtxos`, `recoverVtxos`, `migrateDeprecatedSignerVtxos`, `getExpiredBoardingUtxos`; `wallet.settle({inputs, outputs})`; `Estimator`. No delegator | float.ts:153-303; vtxoLifecycle.ts:442-446 |
| Indexer | `indexerProvider.getVtxos({scripts or outpoints, spendableOnly, pageIndex, pageSize})`, `getVirtualTxs`, `isVtxoSpent` | wallet.ts:392-516; indexerPaging.ts:25 |
| Subscriptions | `getContractManager()` → `watchScript`/`unwatchScript`/`onContractEvent`, `setVtxoSyncMaxAge`; raw gRPC for offers | cli.ts:282-288; lazyContractSource.ts:65-101 |
| Assets | `send` routes asset change by itself; `createAssetPacket`; `selectCoinsWithAsset`; `@arkade-os/swap` `fillOffer` | lockupFunding.ts:166-185; wallet.ts:613-643; offerFulfill.ts:27-137 |

## B. banco

**SDK pin.** `"@arkade-os/sdk": "github:louisinger/wallet-sdk#arkade-script-final"` (BC package.json:43), locked to commit `5a24cbf`, which declares version 0.4.28 (BC pnpm-lock.yaml:11-13, 40-42). That commit exists locally but is not an ancestor of ts-sdk 0.4.78 (`git merge-base --is-ancestor` returned false). CONFIRMED

### The funded-offer contract
Taptree (BC src/offer.ts:344-387). CONFIRMED
- **fulfill**: built as `{arkadeScript: covenant, emulators:[emulatorPubkey], tapscript: Multisig([server])}`. The leaf actually spent is `Multisig([server, computeArkadeScriptPublicKey(emulator, covenant)])` (BC src/taker.ts:130-141). The maker signs nothing.
- **cancel** (optional): `CLTVMultisig([maker, server], cancelDelay)`, where `cancelDelay` is an absolute unix time computed as now + N seconds (maker.ts:121-123).
- **exit** (optional): `CSVMultisig([maker, server], unilateralExitDelay)` (offer.ts:372-384).

Findings on that contract:
- The exit leaf includes the server key. CONFIRMED (script text) So it is not unilateral, despite README.md:78-80. INFERRED The successor builds exit from the maker key alone (SW offer.ts:124-128, 157-158). CONFIRMED
- **Full-fill covenant.** Output 0 value ≥ wantAmount, and output 0's witness program == the maker's (offer.ts:390-414). The asset variant is `0 <txid> 0 INSPECTOUTASSETLOOKUP VERIFY <want> GTE VERIFY`, which hard-codes `asset_gidx = 0` (offer.ts:416-430). EMU README:497 defines that slot as the issuance group index, and the successor binds `$wantAssetGroupIndex` there (SW swap-want-asset.program.json:8, 19-20). CONFIRMED So a banco offer wanting an asset with gidx ≠ 0 cannot be filled. INFERRED; the e2e only issues fresh gidx-0 assets
- **Partial fill** (ratioNum/ratioDen, GCD-reduced at maker.ts:125-141). The swap VTXO must be input 0 (`PUSHCURRENTINPUTINDEX 0 EQUALVERIFY`) and the maker is paid at output 1. `consumed = x*num/den` with integer floor. If consumed ≥ input value it is a full fill; otherwise output 0 must recreate the same script holding exactly the remainder (offer.ts:453-517, 519-618, 620-732). CONFIRMED
- Opcodes used: INSPECTOUTPUTVALUE, INSPECTOUTPUTSCRIPTPUBKEY, INSPECTINPUTVALUE, INSPECTINPUTSCRIPTPUBKEY, PUSHCURRENTINPUTINDEX, FINDASSETGROUPBYASSETID, INSPECTOUTASSETLOOKUP, INSPECTINASSETLOOKUP, MUL, DIV, IF/ELSE and the alt stack. They are emitted as `arkade.ArkadeScript.encode` arrays, not compiled by arkadec. CONFIRMED
- Partial-fill scripts pass FINDASSETGROUPBYASSETID's packet position `k` (EMU README:470) into the `asset_gidx` slot of the asset lookup (offer.ts:471-483). That only works when packet position == issuance gidx, which holds in the asset→BTC e2e. INFERRED
- **Wire format.** TLV records inside extension packet type `0x03`; the decoder is strict and rejects unknown types (offer.ts:118-296; README.md:125-147). CONFIRMED
- **Double satisfaction.** Output indexes are absolute (EMU README:349-350), and the full-fill check never binds to the current input index; the successor's programs have the same shape (SW swap-want-btc.program.json:11-16). CONFIRMED (script text) So two covenant inputs that pay the same maker script could share a single output-0 payment. INFERRED; confirm with an e2e that spends two same-maker offers with one payment

### How the maker goes offline and a taker fills
- **Maker.** `createOffer` reads the server key from `arkProvider.getInfo()` and the emulator key from the emulator's own `getInfo()` (maker.ts:97-165). The maker then funds the swap address with `wallet.send({address, amount, assets, extensions:[packet]})` and can go offline (README.md:169-176). CONFIRMED SDK 0.4.78 deliberately pins the emulator key per network instead of trusting the emulator's `/v1/info` (SDK arkade/contract.ts:350-362). CONFIRMED
- **Taker** (taker.ts:97-598). CONFIRMED
  1. Decode the offer, from hex or via `getVirtualTxs` → `Extension.fromTx` → `getPacketByType(0x03)` (taker.ts:63-81).
  2. Rebuild the script and abort on mismatch (taker.ts:113-119).
  3. Take the FIRST spendable VTXO at the script (taker.ts:121-128).
  4. Select coins from the ungated `wallet.getVtxos()` with `selectCoinsWithAsset` or `selectVirtualCoins`; DUST is hard-coded to 450 (taker.ts:144-200).
  5. Build outputs and one Extension output holding `asset.Packet.create(groups)` and `EmulatorPacket.create([{vin:0, script, witness:empty}])` (taker.ts:206-530).
  6. `buildOffchainTx([swap, ...taker], outputs, checkpointTapscript)` (taker.ts:544-548), plus `PrevArkTxField` on input 0 for partial fills (taker.ts:554-567).
  7. The taker signs inputs 1..n and their checkpoints, but not checkpoint 0 (taker.ts:569-583).
  8. `emulator.submitTx`: the emulator validates the covenant, co-signs, forwards to arkd and finalizes. The returned id is never compared to the local one (taker.ts:585-597).
- **Cancel.** The maker builds with the CLTV leaf, calls `arkProvider.submitTx`, signs the server's checkpoints without `assertSubmittedArkTxid`/`matchServerCheckpoints`, then calls `finalizeTx` (maker.ts:195-277). IS documents exactly that blind signing as a theft surface (IS:arkade/wallet.ts:526-538). CONFIRMED
- **Asset packet API.** `asset.AssetGroup.create(id, null, inputs, outputs, [])`, `AssetInput.create(vin, amt)`, `AssetOutput.create(vout, amt)` and `asset.Packet.create`; cancel uses `createAssetPacket(Map<vin, Asset[]>, recipients)` (taker.ts:260-349; maker.ts:232-246). Amounts pass through `Number()` (taker.ts:273-277, 329). CONFIRMED That loses precision above 2^53. INFERRED

### What banco needs from the regtest stack
- `regtest:start` runs the arkade-regtest submodule (`start-env.sh --env .env.regtest`), then `docker-compose.emulator.yml`, then `ark init` (BC package.json:35). CONFIRMED
- arkd and arkd-wallet are v0.9.4, with every intent fee set to 0 (BC .env.regtest:1-12). CONFIRMED
- Emulator `ghcr.io/arkade-os/emulator:v0.0.1` on port 7073, `EMULATOR_ARKD_URL=arkd:7070`, a fixed test secret, tmpfs storage, on the external `nigiri` network (BC docker-compose.emulator.yml:6-27). CONFIRMED
- The faucet is `docker exec arkd ark send` or `arkd note` (BC test/e2e/utils.ts:66-94). The submodule is not checked out locally. CONFIRMED
- E2E covers asset→BTC full fill, asset→asset full fill, and an asset→BTC partial fill done in two steps (banco.test.ts:39-442). CONFIRMED
- E2E does not cover cancel, exit, BTC→asset, concurrent takers, or `fulfillByTxid`; the tests fund without `extensions` (banco.test.ts:83-92). CONFIRMED

### Does banco still match SDK 0.4.78?
- **Gone:** `arkade.ArkadeVtxoScript` and `ArkadeVtxoInput` (grep of SDK src empty). In 0.4.78 covenants are compiled from program artifacts via `ArkadeProgramScript`, `Arkade.connect`, `ArkadeContract`, `ArkadeTransactionBuilder` and `parseArtifact`; the emulator key is appended to covenant leaves automatically (SDK arkade/index.ts:44-60; program.ts:446-531; contract.ts:285-436). CONFIRMED absence So BC offer.ts:12 and 344-387 will not compile against 0.4.78. INFERRED; not built
- **Still present:** `buildOffchainTx`, `RestEmulatorProvider.submitTx` (returns `{signedArkTx}`), `EmulatorPacket`, `Extension.fromTx`/`getPacketByType`, `PrevArkTxField`, `setArkPsbtField`, `createAssetPacket`, `selectCoinsWithAsset`, `selectVirtualCoins`, `computeArkadeScriptPublicKey`, `ArkadeScript`, `asset.*`, `CLTVMultisigTapscript`/`CSVMultisigTapscript` and `MultisigTapscript` (SDK index.ts:258-317, 470-471, 686-758; providers/emulator.ts:86-117; extension/index.ts:155, 232; arkade/tweak.ts:55; arkade/script.ts:50). CONFIRMED
- **Maintained successor:** `@arkade-os/swap` `createOffer`/`fillOffer`/`cancelOffer` (SW offer.ts:658, 805, 970). Differences from banco (SW offer.ts:101-105, 932-1166; swap-want-btc.program.json:29). CONFIRMED
  - Full fill only; the ratio fields are "reserved … never interpreted".
  - `cancel` is untimelocked `[$user,$server]`, and exit is a CSV leaf for the maker alone.
  - `fund` coins must be passed explicitly.
  - `fundingTxid` is required when an address holds several deposits.
  - It refuses a deposit that lacks the advertised `offerAsset`.
  - The wanted asset must be packet group 0.
  - Losing a race to a cancel is a normal outcome, not an error.
- IS fills offers through this successor (IS:arkade/offerFulfill.ts:12-28, 114-137). CONFIRMED

## Adopt / Avoid
For our design: a single-writer SQLite workflow backend, plus funded standing orders that keepers fill while the maker is offline.

**Adopt**
- One table per workflow, an event table, explicit LEGAL_EDGES, and a CAS of the form `UPDATE … WHERE id=? AND state=?`. Illegal edges throw; losing a race returns false (IS baseSwapStore.ts:286-316). Unlike IS (baseSwapStore.ts:307-314), put the CAS and its event INSERT in one synchronous better-sqlite3 `db.transaction`.
- WAL with `synchronous=FULL` (IS driver.ts:23-27). Also add what IS lacks: an explicit `busy_timeout` and an ordered migration list keyed on `user_version`.
- Choose write-ahead by whether the txid is known before submit:
  - Known (L1 txs, custom ark txs): persist the txid and PSBTs before submit, then reconcile by txid on resume.
  - Unknown (`wallet.send`): use a no-TTL DB lease, a closed "definitely-not-submitted" error set, and adoption by script plus exact value (IS fundLockup.ts:27-39; orchestrator.ts:798-967).
  - Either way, call `wallet.finalizePendingTxs()` at boot; under Node nothing calls it automatically.
- Name coin inputs explicitly (`selectedVtxos`) so an in-process reservation ledger can be enforced. Set `settlementConfig: false` and run one renewal loop of our own, with a reservation filter, the half-lifetime treadmill cap and split-on-settle into a two-rung pool (IS vtxoLifecycle.ts; vtxoPool.ts; float.ts:221-254).
- Treat SSE and stream events as nudges only. The authoritative read is a paged indexer query, and an empty result means lag, not a spend (IS lockupWatcher.ts:1-20; wallet.ts:499-516). Our own order book stays the index of live orders, so a stream gap cannot lose one.
- Keeper pre-fill checks:
  - Rebuild the script from the order terms and abort on mismatch.
  - Re-read the specific outpoint live.
  - Select it by `fundingTxid`.
  - Verify the returned txid == the local txid.

  (IS offerSettle.ts:87-169; SW offer.ts:1049-1090; IS wallet.ts:773-779)
- Enforce the single writer mechanically, for example an exclusive OS lock, or an owner/epoch row checked inside every CAS, rather than a runbook sentence (IS runbook.md:127-132).

**Avoid**
- Covenants that check a fixed output index without `PUSHCURRENTINPUTINDEX` binding, as in banco and SW fulfill. Bind outputs to the input index, as IS's refund covenant does (wallet.ts:706-710), or give every order a unique payout script, so one payment cannot satisfy two orders.
- Hard-coding the asset gidx, or feeding FINDASSETGROUPBYASSETID's packet position into an issuance-gidx slot (BC offer.ts:416-430, 471-483).
- Trusting the emulator's own `/v1/info` for the covenant key (BC maker.ts:105-108).
- Blind-signing the server's checkpoints (BC maker.ts:261-275).
- Hard-coded dust, `Number()` on asset amounts, taking `vtxos[0]` at a shared address, and ungated `getVtxos()` for coin selection (BC taker.ts:121-155, 273-277).
- Building on banco's fork SDK or its partial-fill scripts: they do not exist in 0.4.78 and the successor dropped partial fills. If we need partials, write and test them fresh against 0.4.78 program artifacts.
- Leaving `settlementConfig` at its default alongside our own renewal, which creates two renewal authorities (IS wallet.ts:284-308).
- Async work inside a manual `BEGIN` on a shared handle (IS driver.ts:45-57).
