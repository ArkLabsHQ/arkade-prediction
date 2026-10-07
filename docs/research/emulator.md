# Arkade Emulator: research notes (target pin v0.0.9-rc.1)

Scope: arkade-os/emulator tag `v0.0.9-rc.1` (280aced), the version the public Mutinynet emulator reports. Read-only review, 2026-10-07.

**Path prefixes.**
- `E:` emulator at v0.0.9-rc.1. Master (da929b7) differs only in `pkg/emulator/{finalization,onchain}.go` and `finalization_test.go`, so every other `E:` line number also holds on master.
- `A:` arkd v0.9.16 (`git -C C:\Git\_apm-src\arkd show v0.9.16:<path>`).
- `L:` ark-lib f863e48 as pinned by the emulator (Go module cache). Its asset/extension/intent/offchain code differs from `A:pkg/ark-lib` only in import paths.
- `K:` compiler (arkadec) at e9703e7. `T:` ts-sdk at 8020c3d4, under `packages/ts-sdk/`.

**Labels.** CONFIRMED = read in the cited source, or ran the cited unit test. INFERRED = reasoned from confirmed facts, not exercised. "Not specified" = no Arkade source covers it.

**What I ran.** `go test . -run 'Tunnel|...'` in `E:pkg/arkade` passed: 6 `TestTunnel*` tests plus `TestOpSighashMatchesCheckSigFromStack`. The `E:test/*` integration tests need regtest, so they are cited as source only, not run.

## 1. Signing model

**1.1 Which inputs the emulator owns.** For each emulator-packet entry (type 0x01 inside the `ARK` OP_RETURN):
- It reads the input's `TaprootLeafScript[0]` (base leaf version only) and decodes it as an arkd closure: Multisig, CSVMultisig, CLTVMultisig, ConditionMultisig or ConditionCSVMultisig.
- It owns the input if the x-only key `P_emu(even-Y) + tagged_hash("ArkScriptHash", script)·G` is among the closure's pubkeys. CONFIRMED E:pkg/arkade/script.go:134-205, tweak.go:15-39.
- It tries the current key, then deprecated keys, which can be cut off by `EMULATOR_DEPRECATED_KEYS_VALID_UNTIL`. CONFIRMED E:pkg/emulator/signer.go:86-111, service.go:92-97.
- Entries with no matching key are skipped only if the tx has more than one input. Inputs without an entry are never examined. CONFIRMED E:pkg/emulator/tx.go:47-54, intent.go:63-70.
- Signing rules: SIGHASH_DEFAULT or ALL only; P2TR prevout; exactly one leaf; the leaf must be committed by the prevout key. Signatures are plain BIP342. CONFIRMED E:pkg/emulator/signer.go:18-84.
- The Arkade Script is **not in the tapscript**. It is bound only through the key tweak, so it must be revealed in the packet on every spend. CONFIRMED E:README.md:51-59.

**1.2 SubmitTx (Arkade tx + checkpoints)**, E:pkg/emulator/tx.go:19-111. CONFIRMED:
- (a) Exactly one distinct checkpoint per input (141-174).
- (b) Every input must carry the PSBT unknown `0xde||"prevarktx"`: the tx that created the VTXO, possibly a batch-leaf tx. Its hash must equal the checkpoint's input outpoint, and the witness UTXOs must reconcile (prevout.go:64-130; psbt_fields.go:34-37). The README calls this field optional; the code requires it on all inputs.
- (c) For each owned entry: the checkpoint is 1-in/2-out with out[1] = P2A anchor (value 0); the input spends checkpoint:0; values and scripts match; both the input and the checkpoint input use the same committed covenant leaf (176-248). The checkpoint script itself is left to arkd's rebuild.
- (d) The script runs only on the Arkade tx. On success the emulator signs the Arkade input and checkpoint input 0 (75-98).

**1.3 When it calls arkd and finalizes.** App layer, E:internal/application/service.go:126-241.
- The emulator is the "finalizer" iff, for every input it just signed, the tweaked key is the **last non-arkd key in the closure's pubkey order**. All signed inputs must agree. CONFIRMED E:internal/application/finalize.go:20-46, 81-125.
- As finalizer it checks that all non-arkd checkpoint signatures are present (127-157), then calls arkd SubmitTx, merges arkd's checkpoint signatures, calls FinalizeTx with retry, and returns the final tx. The code's stated reason: stop co-signers from parking the tx as "pending" (service.go:127). CONFIRMED.
- Otherwise it returns its signatures without calling arkd. CONFIRMED.
- INFERRED: put the tweaked key last among non-arkd keys. Otherwise a co-signer can hold an approved tx, and a "before deadline" OP_CHECKTIME gate stops binding.

**1.4 SubmitIntent**, E:pkg/emulator/intent.go:19-119. CONFIRMED:
- Allowed types: register, estimate-intent-fee, delete, get-pending-tx, get-intent, get-data. A `register` with a non-empty `onchain_output_indexes` is rejected. `valid_at`/`expire_at` are checked against the emulator's clock (217-249).
- The canonical message must match proof input 0, the BIP322 toSpend (193-215). Input 0 must be `{0 sat, input1.pkScript}`, and every input ≥1 needs `prevarktx` (prevout.go:15-62).
- vin-0 entries are skipped. The script runs with the intent message bound. If vin 1 is signed, input 0 is signed too after a pkScript equality check (95-109).
- There is no arkd call; only an indexer lookup for OP_PUSHEXPIRY (E:internal/application/service.go:243-254).
- Neither the emulator nor arkd `intent.Verify` validates the proof's version or locktime (A:pkg/ark-lib/intent/proof.go:59-129).

**1.5 SubmitFinalization**, E@rc.1:pkg/emulator/finalization.go:19-139. CONFIRMED:
- No script re-execution. It signs only inputs whose submitted proof carries a valid emulator BIP342 signature (175-272).
- Preconditions: arkd's indexer must know the commitment txid, checked with retry (E:internal/application/service.go:256-276). The connector tree must be valid and its root must spend the commitment tx (E:internal/interface/grpc/handlers/emulator_handler.go:179-194, 254-269).
- Forfeit checks: exactly 2 inputs. The VTXO input must equal the proof's witness UTXO and leaf, and at rc.1 the leaf must contain the arkd key (147-152). The other input must be a non-anchor output of a connector-tree **leaf** (66-72, 333-360).
- Outputs must be exactly `[vtxo + connector − anchor, anchor]`. The **destination script is not checked** (280-329).
- Leftover signed inputs are treated as boarding inputs, and their commitment-tx inputs get signed (103-137).
- INFERRED: once a proof is signed, the covenant is not re-checked at finalization.

**1.6 Who enforces what**
- **Bitcoin consensus:** only the tapleaf (keys, CSV/CLTV, hashlock conditions), on unroll or onchain. CONFIRMED E:README.md:44-49.
- **Emulator:** every Arkade opcode, prevout authentication, checkpoint and forfeit shape, sighash type, intent type and time window, compute limits. CONFIRMED (above).
- **arkd v0.9.16**, all CONFIRMED (`A:` paths):
  - Rebuilds every Arkade tx and requires an exact txid match: version 3, nLockTime = max CLTV of the spent leaves, Σin = Σout (internal/core/application/service.go:1025-1068; pkg/ark-lib/offchain/tx.go:63-65, 126-152).
  - The spend leaf must be Multisig, ConditionMultisig or CLTVMultisig, so **no CSV leaf can be spent offchain**. A CLTV leaf must be ≤ the chain tip (service.go:887-933).
  - Every forfeit leaf must contain the arkd key. Exit leaves must be CSV, but **zero exit leaves is accepted** (pkg/ark-lib/script/vtxo_script.go:97-165).
  - Verifies all non-arkd signatures (service.go:1070-1075, 1919-1933), plus assets (section 4), fees, dust, expiry gap, bans and tx weight.

## 2. OP_TUNNEL and the delegate pattern

**Semantics**, E:pkg/arkade/tunnel.go:12-130. CONFIRMED, including the unit tests that ran.
- Stack: `<out_idx> <flags> [<asset_txid> <asset_gidx>]×n <n> OP_TUNNEL`. All numbers are 4-byte CScriptNums.
- flags must be in 1..7. Exceptions require flag 4. Success pushes 1; any mismatch is a script **error**, never false (39-48, 98-99).
- **Flag 1:** the output pkScript must equal the "logical VTXO scriptPubKey" (63-76; E:pkg/emulator/prevout.go:85-127, 236-253):
  - in an Arkade tx, the previous Arkade tx output **behind the checkpoint**, not the checkpoint script;
  - in an intent proof or onchain tx, the spent output itself;
  - otherwise it falls back to the direct prevout.
- **Flag 2:** compares against the *directly* spent value. In an Arkade tx that is the checkpoint output, which is pinned to the VTXO value (77-89; tx.go:210-212).
- **Flag 4:** for every asset group not listed as an exception, two per-asset maps must be equal: LOCAL inputs whose vin = the current input index, and LOCAL outputs whose vout = `out_idx` (102-129).
  - So the output can carry no other asset, and merging is impossible.
  - Fresh issuance resolves to (this txid, k). Exceptions are ignored on both sides. A missing packet counts as empty and passes (E:pkg/arkade/tunnel_test.go:86-179).
- Gotcha: in an Arkade tx, OP_INSPECTINPUTOUTPOINT returns the **checkpoint** outpoint, not the VTXO outpoint; in an intent proof it returns the VTXO outpoint. CONFIRMED E:pkg/arkade/opcode.go:2026-2047; tx.go:190-196.

**Delegate pattern**, E:test/delegate_test.go:35-136.
- Script: `OP_PUSHEXPIRY 1024 OP_SUB OP_CHECKTIME OP_VERIFY`, then intent checks (`type == "register"`, `onchain_output_indexes == "[]"`, `cosigners_public_keys.0 == pinned`, no `.1`), then `OP_PUSHCURRENTINPUTINDEX OP_1SUB 7 0 OP_TUNNEL`.
- VTXO script: `Multisig[arkd, tweaked]` plus `CSVMultisig[alice, 512s]`.
- **Why output i−1:** proof input 0 is the BIP322 message and the outputs have no placeholder. Binding to the index also stops two equal VTXOs from being "preserved" by one output. CONFIRMED A:pkg/ark-lib/intent/proof.go:324-346; E:test/delegate_test.go:344-349; E:README.md:83.
- **Why OP_INSPECTVERSION == 2** (`enforceSelfSend`, 350-366): Arkade txs are v3 (A:offchain/tx.go:152) and proofs are v2 (proof.go:346), so it blocks Arkade-tx self-send loops ("burning fees without ever refreshing", 59-61). CONFIRMED.
  - TestCovenantDelegate gates on `type` instead. OP_INSPECTINTENTMESSAGE pushes `<empty> 0` outside SubmitIntent (E:pkg/arkade/intent_message.go:26-29), and the test asserts SubmitTx fails (251-272). CONFIRMED.
  - Arkade txs carry zero fee, so "fees" probably means unroll and CPFP depth. INFERRED.
  - Proof version and locktime are spender-chosen and unvalidated, so `v==2` only means "not an Arkade tx". INFERRED.
- **End-to-end flow** (172-341; E:test/utils_test.go:58-222). CONFIRMED as test code:
  1. Solver builds the register proof: VTXO in, same script and value out, covenant leaf on inputs 0 and 1, taptree, emulator packet for vin 1, `prevarktx`.
  2. SubmitIntent; the emulator signs inputs 1 and 0.
  3. arkd RegisterIntent.
  4. The pinned cosigner signs the VTXO tree.
  5. Solver builds the forfeit with the covenant leaf.
  6. SubmitFinalization; the emulator signs; the forfeit is sent to arkd.
  7. Result: a new non-preconfirmed leaf VTXO with the same script and value.
- **Who can trigger:** anyone with the public taptree and funding tx ("any solver", 54-55). The test pins cosigner #0 and forbids a second (116-127), so only the delegate key can co-sign the new VTXO tree. `enforceSelfSend` has no pin. CONFIRMED.
  - Why pin: tree trust, and avoiding griefing registrations. INFERRED.
- **Siphoning and merging:** flag 2 forces value out = value in, so the VTXO cannot pay fees. arkd needs `fees ≥ ComputeIntentFees` (A:internal/core/application/service.go:2209-2251), so the solver must add a fee input if the operator charges. INFERRED; regtest paid 0. The expiry window limits *when*. Index pairing plus exact asset maps block merging.

**Renewing an asset-bearing covenant VTXO through a batch: supported by the machinery.**
- arkd keys a VTXO's assets by **proof input index** (A:service.go:1913-1916). Every held asset must appear as a LOCAL input with the exact amount (A:pkg/ark-lib/asset/tx_validation.go:199-238, 295-364).
- Issuance inside an intent is rejected (service.go:2155-2165).
- The packet is rewritten into the batch leaf with INTENT-type inputs (2167-2188; asset_group.go:215-228). Custom packets are copied too (E:test/batch_continuation_test.go:26-38). CONFIRMED.
- **TestSettlementWithAsset** (E:test/asset_test.go:182-507) settles an asset-bearing covenant VTXO through SubmitIntent → batch → SubmitFinalization, with packet `vin 1 → vout 0` (421-428). CONFIRMED as source. Its leaf is 3-of-3 including Bob (E:test/utils_test.go:997-1018), so it is interactive.
- **No test** combines OP_TUNNEL flag 4 with an asset VTXO in a batch; the delegate VTXO holds no assets. A packet `{in: local vin i, out: local vout i−1}` should work. INFERRED.

## 3. Time

**OP_PUSHEXPIRY.** CONFIRMED:
- Value: the arkd indexer `GetVtxos.expiresAt`, as int64 **Unix seconds** (`time.Unix(...)` then `.Unix()`; E:internal/application/vtxo.go:15-49).
- It looks up the logical VTXO in SubmitTx (tx.go:62-72, 113-139) and the proof input in SubmitIntent (intent.go:121-191).
- It is fetched only if the script contains byte 0xdb (intent.go:166-174), and pushed as a scriptNum (E:pkg/arkade/opcode.go:2545-2551).
- It fails if the value is missing or ≤0, and **always fails in SubmitOnchainTx** (E:README.md:369).
- A batch VTXO's expiry = batch-swap end + `VtxoTreeExpiry.Seconds()` (A:internal/core/domain/round.go:273-280; service.go:3365-3367; utils.go:280-318). Arkade-tx outputs inherit the **minimum** expiry of what they spend (service.go:645-654).

**OP_CHECKTIME.** CONFIRMED: pops a BigNum and pushes `ts ≤ now`. `now` is the **emulator host's** `time.Now().Unix()` at engine creation (E:pkg/arkade/engine.go:704; opcode.go:985-996). Negative is an error; future is false. Neither arkd nor Bitcoin checks it.

**tx.locktime and OP_INSPECTLOCKTIME.** CONFIRMED:
- An Arkade tx's nLockTime = max `CLTVMultisigClosure` locktime of the spent leaves (sequence 0xfffffffe), otherwise 0. It is fixed by arkd's rebuild (A:offchain/tx.go:126-152; service.go:1059-1068).
- arkd rejects a CLTV leaf above the current block **height** (or above block **time** if ≥5e8) per its wallet (service.go:902-933). So arkd checks against the chain tip, not the wall clock. Header time vs MTP is not specified.
- Proof locktime is 0 by construction (proof.go:346) but unchecked.
- In-script OP_CHECKLOCKTIMEVERIFY applies BIP65 against tx.LockTime (E:pkg/arkade/opcode.go:930-980).

**Consequences.** Compiler `tx.time` = OP_INSPECTLOCKTIME and `checkTime()` = OP_CHECKTIME (K:README.md:459-463; src/compiler/expr.rs:94). INFERRED:
- `tx.time < deadline` is vacuous offchain; `tx.time ≥ X` needs a CLTV leaf; neither is trustworthy in intent proofs.
- Use OP_CHECKTIME for oracle and deadline gates (trusting the emulator's clock), and CLTV/CSV leaves for consensus time.

## 4. Assets

**Envelope.** CONFIRMED:
- `OP_RETURN <push "ARK" || (type u8 || uvarint len || data)*>`. Duplicate types are rejected; there is no 520-byte cap (L:extension/extension.go:16-19, 57-114, 177-237).
- `uvarint` is Go **LEB128** `binary.PutUvarint` (extension.go:267-269). The emulator packet's inner fields use Bitcoin **CompactSize** (E:pkg/arkade/emulator_packet.go:80-117). E:README.md:244 calls the outer length "varint", but it is LEB128.

**Asset packet (type 0x00).** CONFIRMED (A:pkg/ark-lib/asset/packet.go:12-20, 118-131; asset_group.go:13-18, 160-213; L:asset/asset_input.go:172-201, 222-243; asset_ref.go:11-21; utils.go:19-33, 98-114):
- Header: `uvarint group_count` (≤1000).
- Each group, in order:
  - presence byte: 0x01 assetId, 0x02 control, 0x04 metadata;
  - [AssetId = 32-byte txid in **display order** + u16 LE gidx];
  - [AssetRef = u8 type: 1 = by id (AssetId), 2 = by group (u16 LE)];
  - [metadata list];
  - inputs: `uvarint n`, then each `u8 type` — 1 local: u16 LE vin + uvarint amount; 2 intent: txid + u16 vin + uvarint amount;
  - outputs: `uvarint n`, then each `u8 1` + u16 LE vout + uvarint amount.
- A group's inputs must share one type and have unique vins.

**Byte order.** CONFIRMED:
- Packet bytes and ts-sdk `AssetId.txid` (`hex.decode(txidHex)`, T:src/extension/asset/assetId.ts:36-57, 161-164) use **display order**.
- Stack values use **internal chainhash order = reversed display hex**. This applies to OP_INSPECTASSETGROUPASSETID, OP_INSPECTASSETGROUPCTRL, OP_INSPECTOUTASSETAT, OP_INSPECTINASSETAT, the lookups, FINDASSETGROUPBYASSETID and OP_TUNNEL exceptions (E:pkg/arkade/asset_opcodes.go:42-43, 75, 90, 359, 480, 635-658).
- It is the same order as OP_TXID and OP_INSPECTINPUTOUTPOINT (opcode.go:2042, 2969-2970). A test pins `TxHash()[:]` (E:test/contract_id_test.go:206-208, 388).
- So reverse ts-sdk txids before embedding them; OP_REVERSEBYTES (0xd9, opcode.go:1691-1712) does it in-script.

**Issuance, reissuance, burn, transfer.** CONFIRMED:
- **Issuance:** a group with no AssetId, giving id = (this txid, k). It has no inputs and an optional control (by id = an existing asset; by group = issued in the same tx) (asset_group.go:72-75, 132-140; tx_validation.go:147-197; E:asset_opcodes.go:597-629).
- **Transfer:** an AssetId with inputs and outputs.
- **Reissuance:** Σout > Σin (asset_group.go:77-92). The asset's registered control asset must be in the packet **with inputs** (tx_validation.go:109-145).
- **Burn:** Σout < Σin. No rule forbids it (INFERRED from absence).
- Every asset held by a spent VTXO must be listed with its exact amount (199-238).
- **Who rejects:** arkd, via `validateAssetTransaction` on Arkade txs and intents (A:internal/core/application/asset_validation.go:13-52; service.go:1018-1023, 2148-2153).
  - Inflating an asset that has no control asset → `CONTROL_ASSET_INVALID`.
  - **A fresh uncontrolled issuance is allowed.**
- The emulator never validates asset semantics; it only exposes the packet (E:pkg/arkade/script.go:240-248; `ValidateAssetTransaction` is never called in `E:`).

**Gotcha: metadata hash.** OP_INSPECTASSETGROUPMETADATAHASH plain-SHA256-hashes the **current group's** metadata (E:asset_opcodes.go:131-154, 545-577). That is not ark-lib's tagged `GenerateMetadataListHash` (L:asset/metadata.go:75-85; utils.go:124-168). CONFIRMED. Don't use it as identity (INFERRED).

**Test patterns.**
- TestOffchainTxWithAsset: issuance → vout 0; the script checks output 0's script, `NUMASSETGROUPS == 1` and the group sum (E:test/asset_test.go:30-180).
- TestAssetAccountCovenant: per-output `OP_INSPECTOUTASSETAT` amounts via `OP_NIP OP_NIP`. It warns the asset id is *not* pinned, so pin `(asset_txid, asset_gidx)` in production (E:test/asset_account_covenant_test.go:63-68, 263-291). Its leaf is a bare `[arkd, tweaked]` with no exit leaf (E:test/utils_test.go:1136-1151).

## 5. Signatures

**OP_CHECKSIGFROMSTACK.** CONFIRMED:
- Stack is `sig msg pubkey`, pubkey on top (E:pkg/arkade/opcode.go:2596-2628).
- Keys: 32 bytes = BIP340 x-only Schnorr; `0x10||33B` = ECDSA secp256k1; `0x11||33B` = ECDSA P-256 (sigscheme.go:34-89).
- The message is used **verbatim**: no hash, no tag (91-101).
- Schnorr requires **msg = 32 bytes and sig = 64 bytes** (btcec/v2@v2.5.0 schnorr/signature.go:70-82, 132-136). ECDSA requires a 32-byte digest, 64-byte r||s and low-S.
- Empty sig pushes empty. An invalid non-empty sig is a script **error** (NULLFAIL). Success pushes 1 (E:pkg/arkade/sigscheme_test.go:190-198).

**OP_CHECKSIG / VERIFY / ADD inside Arkade Script.** CONFIRMED:
- BIP342 sigMsg, with every emulator-packet witness blob masked out of sha_outputs (and out of the SIGHASH_SINGLE output), and final tag `"ArkadeTapSighash"`.
- The leaf hash is the Bitcoin spending closure leaf; codesep is blank (sigvalidate.go:16-22, 43-73, 156-354; script.go:278-283).
- A 64-byte sig means DEFAULT; 65 bytes with a non-zero last byte is an explicit sighash type (375-386).
- OP_SIGHASH pushes the same digest (opcode.go:2981-3028; the matching test passed locally).

## 6. Limits

All CONFIRMED unless marked.
- **Script:** ≤10,000 B (E:pkg/arkade/emulator_packet.go:22; engine.go:716-722).
- **Packet:** ≤1000 entries; witness ≤1,000,000 B per entry; Σ(script + witness) ≤1,010,000 B; vins unique (16-31, 151-229).
- **Stack elements:**
  - pushes and OP_CAT results ≤520 B (engine.go:297-301; opcode.go:2238-2242);
  - initial witness items are not size-checked (script.go:259-261);
  - after each step: ≤1000 items and ≤128 KiB combined (engine.go:26-34, 489-505);
  - clean stack (exactly one true item), with minimal pushes and numbers (engine.go:309-315, 423-451, 735-736).
- **Numbers:** BigNum ≤520 B (bignum.go:15-17); OP_MODEXP operands ≤64 B (opcode.go:2483-2540); CScriptNum arguments ≤4 B (stack.go:81-88).
- **OP_INSPECTPACKET / OP_INSPECTINPUTPACKET:** error if the content is >520 B (opcode.go:3083-3087, 3145-3149), so large asset packets can't be read raw; the asset opcodes still work. Intent message ≤1 MiB, each result ≤520 B (intent_message.go:15, 104-114).
- **Compute limits, per input:** CHECKSIG, CHECKSIGVERIFY, CHECKSIGADD and CSFS 50 each; ECADD 1000; ECMUL, ECMULSCALARVERIFY and TWEAKVERIFY 50; ECPAIRING 2 (≤16 pairs); MODEXP 64; INSPECTINTENTMESSAGE 16; everything else unlimited.
  - The **per-request** budget is 4× these, shared across all inputs of a PSBT (e.g. ≤200 CSFS). Override with `EMULATOR_COMPUTE_LIMITS` (E:pkg/arkade/compute_limits.go:31-79; tx.go:42; README.md:274).
- **Transport:** `prevouttx` field ≤1,000,000 B (psbt_fields.go:16); gRPC messages ≤4 MiB (E:internal/interface/grpc/service.go:96).
- **Outputs:** I found no emulator cap. Asset packets allow ≤1000 groups and ≤1000 inputs, outputs and metadata per group (A:pkg/ark-lib/asset/packet.go:15-20).
- **arkd:** max tx weight defaults to 1% of a block; MaxAssetsPerVtxo is derived from weight (A:internal/config/config.go:280-298; internal/core/domain/settings.go:442-454). Mutinynet values are not confirmed.

## 7. Integer encoding

**VM.** CONFIRMED:
- One byte format (minimal sign-magnitude LE), read at two widths.
- `PopInt` reads a CScriptNum of ≤4 B. Used for indexes, counts, flags, k/j/source/gidx, packet type, sighash flag, shift count, PICK/ROLL/PUT, the NUM2BIN size and OP_TUNNEL arguments (stack.go:81-88; scriptnum.go:184-224).
- `PopBigNum` reads ≤520 B, always minimal. Used by all arithmetic and comparison opcodes, CHECKTIME, and CLTV/CSV (≤uint32) (stack.go:151-171; bignum.go:325-348; opcode.go:956-1047, 1298-1645).
- **BigNum pushers:** INPUTVALUE, OUTPUTVALUE, INPUTSEQUENCE, VERSION, LOCKTIME, TXWEIGHT, asset amounts and sums, intent integers.
- **scriptNum pushers:** NUMINPUTS, NUMOUTPUTS, CURRENTINPUTINDEX, vout, gidx/k, flags, PUSHEXPIRY.
- So values above 2^31−1 work in arithmetic but cannot feed a `PopInt` consumer.

**OP_MUL / OP_DIV / OP_MOD.** CONFIRMED (bignum.go:177-218, 297-309; opcode.go:2433-2481):
- int64 fast path with auto-promotion to big.Int; the result must fit in 520 B.
- DIV truncates toward 0. MOD takes the dividend's sign. Dividing by 0 is an error. RSHIFT floors.

**Compiler (K:).** CONFIRMED:
- `int` is documented as "CScriptNum" (README.md:335), but `+ - * /` emit OP_ADD/OP_SUB/OP_MUL/OP_DIV (src/operators.rs:71-74), so runtime values are BigNums.
- Constants are checked i64 (src/compiler/constants.rs:163-168; README.md:404).
- `==` emits bytewise **OP_EQUAL** (operators.rs:80), which is safe only for minimal encodings (INFERRED).
- `int(0x..)` is read **big-endian** (README.md:475).
- The ts-sdk BigNum codec matches the VM (T:src/arkade/bignum.ts:1-41).

## 8. Unilateral exit

- A leaf without the tweaked key, such as the delegate's `CSV[alice]`, exits with no emulator involvement (E:test/delegate_test.go:149-158). CONFIRMED.
- A leaf with the tweaked key needs **SubmitOnchainTx** (E@rc.1:pkg/emulator/onchain.go:23-85). CONFIRMED:
  - an emulator packet is required;
  - `prevouttx` is required on **every** input (E:pkg/emulator/prevout.go:132-168), although the README says optional;
  - there is no expiry and no intent message.
- **At rc.1 it rejects a leaf whose closure contains the arkd key** (onchain.go@rc.1:54-59); master drops this (#166).
- The test "CSV exit closure" spends a `CSV[bob, tweaked]` leaf onchain (E:test/onchain_test.go:306-418). CONFIRMED as source.
- arkd requires the arkd key in every forfeit leaf (A:script/vtxo_script.go:101-133), so offchain covenant leaves are `[arkd, tweaked]`. Those need arkd's signature onchain, so they are not an exit path. INFERRED.
- Design rule: give every contract VTXO a CSV exit leaf, either user-only or tweaked-key-without-arkd (the latter for onchain covenant continuation through SubmitOnchainTx). INFERRED.
- arkd **accepts VTXOs with no exit leaf** (vtxo_script.go:152-157). CONFIRMED. Those VTXOs, e.g. `createArkadeOnlyVtxoScript`, cannot exit unilaterally (INFERRED). E:README.md:46 "every contract carries" an exit leaf is a convention, not a rule.
- Assets after unroll:
  - the emulator exposes the onchain tx's asset packet to opcodes (script.go:240-248);
  - arkd lets unrolled asset VTXOs rejoin a batch as boarding inputs (A:service.go:1811-1829);
  - asset tracking through other onchain spends is **not specified** in the sources reviewed.

## 9. Version differences that matter

- **v0.0.8:** added OP_TUNNEL (#141), OP_PUT (#136), OP_INSPECTINTENTMESSAGE (#144), OP_PUSHEXPIRY (#143), and OP_CHECKTIME replacing OP_CHECKTIMEVERIFY (#156). CONFIRMED by `git log v0.0.7..v0.0.8`.
- **v0.0.8 → rc.0:** CONFIRMED by `git diff v0.0.8 v0.0.9-rc.1 -- pkg/arkade`, which is imports only:
  - `pkg/emulator` library refactor, with indexer fetches moved to the app layer (#102, #162);
  - btcd v2 and client-lib (#161);
  - connector-tree check relaxed (#163);
  - no opcode-semantic change.
- **rc.0 → rc.1:** README and go.mod pins only. CONFIRMED.
- **rc.1 → master (da929b7, #166):** the arkd-key checks were removed from SubmitOnchainTx and SubmitFinalization, so arkd-keyed leaves can now be signed onchain. CONFIRMED. E:README.md:201 still claims the rejection (stale on master).
- **ark-lib f863e48 (emulator pin) vs arkd v0.9.16:** 6 commits apart; asset/extension/intent/offchain differ by imports only. CONFIRMED.
