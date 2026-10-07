# Polymarket: market import and on-chain outcome verification

Snapshot 2026-10-07 (live calls 16:29-17:15 UTC). Read-only: docs, source, public APIs, public Polygon RPC. No accounts, trades or transactions.

**Labels:** **C** = CONFIRMED (seen in the cited doc, source or live response). **I** = INFERRED (reasoning; states what would confirm it).
**Citations:** docs were fetched as raw markdown (`https://docs.polymarket.com/<page>.md`) and are cited `page.md:line`. Repos: `Polymarket/polymarket-v2-external@741f8bb` (2026-09-24), `Polymarket/uma-ctf-adapter` tag `v3.1.0` and `main@8b76cc9`, `gnosis/conditional-tokens-contracts@eeefca6`. Gamma spec: `https://docs.polymarket.com/api-spec/gamma-openapi.yaml` (cited `yaml:line`). UMA docs: `https://docs.uma.xyz/llms-full.txt`.
**Evidence** (`evidence/polymarket/`, every file has `fetchedAt`): `gamma-markets-keyset-page.json`, `live-proof-2758339-btc-67500-july.json` (NO), `live-proof-3409541-yes-example.json` (YES), `live-proof-4737427-fifty-fifty.json` (50-50), `supporting-observations.json` (RPC probes, adapter classification, V2 checks), `gamma-status-vs-chain.json`.

## Key findings
- **C** Every market Gamma lists today is `version:"v1"` (legacy CTF). `version=v2` returns `[]` for open and closed markets, and the filter is real: `version=zzz` gets HTTP 422 `expected value to be one of "v1, v2"` (supporting-observations.json, `gammaVersionFilter`).
- **C** Current ordinary binary markets use CTF oracle `0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7`. This UMA CTF adapter is **not** on the docs contracts page and is not in any tagged release. Its selectors and constants match uma-ctf-adapter `main` (`resolveManually`, `SAFETY_PERIOD`=3600). An allowlist built only from the docs would reject every current market.
- **C** Gamma and Data API status fields lag or point at the wrong event. Examples: 2022 markets still read `"proposed"` but are resolved on-chain; the API's `transaction_hash` pointed at the init tx; the API's `resolved_block` was the V2 mirror's block. Only CTF state at a finalized block is authoritative.
- **C** 50-50 (`[1,1]`) is routine. One window of about 1M blocks contained at least 7,511 adapter `QuestionResolved` logs with settledPrice 0.5e18. That is a lower bound, because the provider truncates (§5). All 4 sampled were sports sub-markets.
- **C** Free RPCs behave differently. `finalized` lagged head by 2-6 blocks on four providers but by 898-2,004 blocks on 1rpc. publicnode prunes old receipts. Tenderly silently truncated wide `eth_getLogs` ranges.

## 1. Discovery API (Gamma)
| Item | Value | Status / source |
|---|---|---|
| Base URLs | Gamma `https://gamma-api.polymarket.com`; Data API `https://data-api.polymarket.com`; CLOB `https://clob.polymarket.com` | C rate-limits.md:29,45,72 |
| List | `GET /markets/keyset` returns `{markets[], next_cursor}`. `GET /events/keyset` returns `{events[], next_cursor}` with markets nested | C yaml:863-1294, 3334-3359; discover-markets.md:472-494, 758-781 |
| Single | `GET /markets/{id}`, `/markets/slug/{slug}`, `/events/{id}`, `/events/slug/{slug}` | C discover-markets.md:240-246, 652-658 |
| Pagination | Cursor based: send the previous `next_cursor` as `after_cursor`. `limit` is 1..100 (default 20). `next_cursor` is omitted on the last page. `offset` returns 422 | C yaml:874-902, 3342-3346 |
| Filters (`/markets/keyset`) | `closed` (default false), `id[]`, `slug[]`, `condition_ids[]`, `question_ids[]`, `clob_token_ids[]`, `tag_id[]`, `related_tags`, `tag_match`, `liquidity_num_min/max`, `volume_num_min/max`, `start_date_min/max`, `end_date_min/max`, `uma_resolution_status`, `sports_market_types[]`, `game_id`, `rfq_enabled`, `cyom`, `order` + `ascending`, `include_tag`. Also `version` (`v1`/`v2`), which is not in the spec | C yaml:903-1022; version: live |
| active/archived | Only the legacy offset `GET /events` has `active` and `archived` filters. `/markets/keyset?archived=true` still returned `archived:false` rows, so filter client-side | C yaml:326-333; live |

| Concept | Gamma market field (live names) | Notes |
|---|---|---|
| ID / slug / question | `id` (string), `slug`, `question` | C |
| Rules | `description` (full rules text, including edge cases such as 50-50 conditions) | C live 559651, 4737427 |
| Resolution source | `resolutionSource` (often `""`; the rules text names the source) | C live |
| Outcomes and order | `outcomes` is a JSON-encoded string, e.g. `"[\"Yes\", \"No\"]"`. Index `i` aligns with `outcomePrices[i]`, `clobTokenIds[i]` and `positionIds[i]`. Labels are **not** always Yes/No: `["Over","Under"]`, `["Up","Down"]` and player names were all seen. Index `i` corresponds to CTF indexSet `1<<i` and to `payoutNumerators[i]`: recomputing `getPositionId(USDC.e, getCollectionId(0, cond, 1<<i))` on-chain reproduced both `clobTokenIds` of 2758339 | C market-details.md:180-211; live |
| Token / position IDs | `clobTokenIds` (JSON string; v1 trading IDs), `positionIds` (array; V2 IDs) | C api-integrations.md:23-35 |
| Condition / question | `conditionId` (bytes32 for v1), `questionID` | C yaml:1843, 1975 |
| CTF oracle | `resolvedBy`. It is the CTF oracle for non-negRisk markets, verified by derivation on 6 markets. It is `null` for Chainlink up/down markets (5379000's condition was prepared by `0x58e1745bedda7312c4cddb72618923da1b90efde`) | C live |
| negRisk | market: `negRisk`, `negRiskOther`, `negRiskRequestID`, `groupItemTitle`. Event: `enableNegRisk`, `negRiskAugmented`, `negRiskMarketID`. `negRisk` is **absent** (not `false`) on 2022 markets | C market-details.md:347, 353-404; live |
| Dates | `endDate`, `endDateIso`, `umaEndDate`, `closedTime`, `startDate` | C yaml:1854, 1978, 2002 |
| Status | `active`, `closed`, `archived`, `acceptingOrders`; `umaResolutionStatus` (values seen: `proposed`, `disputed`, `resolved`, including on open markets; absent on the sampled open markets that had no proposal yet); `umaResolutionStatuses` (history, as a JSON string); `resolutionStatus` (V2 only: `inactive`/`active`/`resolved`) | C market-details.md:342-349; api-integrations.md:111-121; live |
| Protocol | `version`: `"v1"` = CTF, `"v2"` = Protocol V2. Docs: select IDs by `version`; "presence does not select the protocol" | C api-integrations.md:23-35; market-details.md:188-190 |

## 2. Legacy CTF vs Protocol V2
- **C** V2 is made of PositionManager (an ERC-1155 ledger), BinaryModule (id 1), NegRiskModule (2), CombinatorialModule (3), Router and ExchangeV3. Results come from the OracleAggregator, which collects votes from reporter modules (UMA OOReporter, Chainlink, EOA) (how-positions-work.md:15-18, 109-126; v2 `docs/oracle.md`).
- **C** Position ID layout: `[moduleId 8 | baseHash 128 | arity 16 | reserved 64 | resolutionChain 16 | conditionIndex 16 | outcomeIndex 8]`. A V2 condition ID is `bytes31` (the outcome byte is dropped). Outcome 0 = YES, 1 = NO (v2 README:7-23; contract-integrations.md:54).
- **C** V2 result getters:
  - `BinaryModule.getResult(bytes31)` (`0xe4939c77`) returns `uint256[]`: empty until resolved, otherwise `[yes,no]` summing to `RESULT_DENOMINATOR=1_000_000`.
  - `hasResult(bytes31)` (`0x8b005065`).
  - `PositionManager.getPayout(uint256,uint256)` (`0x4c619e4c`) reverts while unresolved.
  - Events: `ConditionResolved(bytes31 indexed,uint256[])` (topic `0xe560c1a2…`) and `ResultReported(address indexed,bytes31 indexed,uint256[])` (`0x669c053f…`).
  - Sources: BaseModule.sol:25,101,145-147,166-177,287-289; BinaryModule.sol:59-105.
- **C** OracleAggregator lifecycle: statuses are `None`, `Active`, `ArbitrationRequested`, `Resolved`. `getRequestState(bytes32)` (`0xf0689417`) returns `(status, proposedResultHash, disputeWindowEnd, disputeCount)`. A binary result `[v]` is reported to the module as `[v, 1e6-v]`. An admin `resolveResult` can force-finalize any non-Resolved request (v2 `docs/oracle.md`).
- **C** UMA price to V2 payout: `1e18` gives `[1e6,0]`, `0` gives `[0,1e6]`, `0.5e18` gives `[5e5,5e5]`. Too-early (P4) is `int256.min` (OptimisticOraclePayoutLib.sol:18-27, 52).
- **C, trap:** v1 market 559651 has `positionIds` populated. Decoded, `positionIds[0]` has moduleId 1 and equals `BinaryModule.getMigrationConditionId(conditionId)`, so it is a V2 *migration mirror* of the CTF condition. The mirror copies CTF payouts (`MigrationResolved`, BaseMigrationMixin.sol:292-303) and can lag: by 26 blocks for the 50-50 example. For v1 markets the CTF stays authoritative.
- **C** Native V2 binary markets exist on-chain: 67 OracleAggregator-reported results in one 10k-block window. The Data API tags the 2 checked as `market_type:BINARY`, `reporter:CHAINLINK` (5 minutes apart). Gamma `condition_ids` returned nothing for the one looked up. Since Gamma lists no v2 markets, no Gamma-listed UMA binary market is V2 today (**C**). **I** The 67 are Chainlink up/down markets; only 2 of 67 were checked.

| Polygon (137) | Address | Status / source |
|---|---|---|
| ConditionalTokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | C contracts.md:31; `ctf()` of the adapters |
| CTF Exchange / NegRisk CTF Exchange | `0xE111180000d2663C0091e4f400237545B87B996B` / `0xe2222d279d744050d28e00520010520000310F59` | C contracts.md:28-29 |
| NegRiskAdapter (CTF oracle of negRisk conditions) | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | C contracts.md:30; derivation live |
| UmaCtfAdapter v1.0.0 / v1.0.1 / v2.0.0 / v3.0.0 / v3.1.0 | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` / `0xB97455fcF78eb37375e8be6f26df895341CA073d` / `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` / `0x71392E133063CC0D16F40E1F9B60227404Bc03f7` / `0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49` | C GitHub release notes. contracts.md:103-104 mislabels `0xCB18…` as "UMA Optimistic Oracle", but it is the CTF oracle of 2022 market 240587 (derivation live) |
| UMA CTF adapter in current use (undocumented) | `0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7`: `SAFETY_PERIOD()`=3600, has `resolveManually`, OO = MOOv2 | C live (code and selectors) |
| NegRisk UMA adapters | `0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d`, `0x69c47De9D4D3Dad79590d61b9e05918E03775f24` | C `resolvedBy` of negRisk markets. **I** their `ctf()` targets (`0x7152…b820`, `0x6619…2e93`) are NegRiskOperators |
| UMA OO used by v2.0.0-v3.1.0 / ManagedOptimisticOracleV2 | `0xee3afe347d5c74317041e2618c49534daf887c24` / `0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1` | C `optimisticOracle()` live. **I** the first is OOv2 by name. MOOv2: C UMA docs llms-full.txt:797 |
| V2 PositionManager / Router / ExchangeV3 | `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` / `0x12121212006e4CD160D18e3f00711DA5c3372600` / `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` | C contracts.md:32-37 |
| V2 Binary / NegRisk / Combinatorial module | `0x1000008dD9001B968442c1000017eaE6E0dA00Ba` / `0x200000900045e3B6259600682756002200028933` / `0x30000034706C7d8e12009DAB006Be20000c031A8` | C contracts.md:34-36 |
| V2 OracleAggregator / OOReporter / ChainlinkReporter / EOAReporter | `0x0A0a0A0A8B00C51b7D810501b03F230028C04a87` / `0x000012e0009c84078c4924fba808A41b9f67527f` / `0xc12EC12E0000326890Ca5560dEf5EB5C22b16814` / `0x8Ef9D6d668798b1f363b305D916F30739d2b0419` | C contracts.md:105-108 |
| Legacy CTF collateral | USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`, not pUSD (how-positions-work.md:91 says pUSD). The token-ID recomputation for 2758339 matches USDC.e only | C live |

## 3. Verifying a legacy CTF ordinary binary market
- **C** Condition ID: `conditionId = keccak256(abi.encodePacked(address oracle, bytes32 questionId, uint256 2))` (CTHelpers.sol:10-12). The oracle is the adapter that called `prepareCondition(address(this), questionID, 2)` (adapter `initialize`). Gamma `conditionId` was reproduced locally for 2758339, 3409541, 4737427, 5390488 (oracle `0x6507…`), 559651 (`0x157C…`) and 240587 (`0xCB18…`), and also on-chain via `CTF.getConditionId` for the three proof markets.
- **C** CTF getters (selectors cross-checked against the ABI `methodIdentifiers`):

  | Getter | Selector |
  |---|---|
  | `payoutDenominator(bytes32)` | `0xdd34de67` |
  | `payoutNumerators(bytes32,uint256)` | `0x0504c814` |
  | `getOutcomeSlotCount(bytes32)` | `0xd42dc0c2` |
  | `getConditionId(address,bytes32,uint256)` | `0x852c6ae2` |

  `payoutDenominator` is nonzero if and only if the condition is resolved. `reportPayouts` reverts with "payout denominator already set", so payouts are immutable once written (ConditionalTokens.sol:57-59, 78-97).
- **C** CTF events: `ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount, uint[] payoutNumerators)` (topic0 `0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894`) and `ConditionPreparation` (`0xab3760c3…`) (ConditionalTokens.sol:13-26).
- **C** Adapter events (topic0):

  | Event | topic0 |
  |---|---|
  | `QuestionResolved(bytes32 indexed questionID, int256 indexed settledPrice, uint256[] payouts)` | `0x566c3fbd…` |
  | `QuestionInitialized` | `0xeee0897a…` |
  | `QuestionReset` | `0x7981b583…` |
  | `QuestionFlagged` / `QuestionUnflagged` | `0x2435a034…` / `0x052435bc…` |
  | `QuestionPaused` / `QuestionUnpaused` | `0x6ded7250…` / `0x92d28918…` |
  | `QuestionEmergencyResolved` (v3.1.0) | `0x6edb5841…` |
  | `QuestionManuallyResolved` (`0x6507…`, `main`) | `0x5909815f…` |

  Full hashes are in the evidence files.
- **C** Payout vectors: YES = `[1,0]`/1, NO = `[0,1]`/1, 50-50 ("unknown") = `[1,1]`/2. Any OO price other than 0, 0.5e18 or 1e18 reverts `InvalidOOPrice`. Admin payouts are restricted to the same three vectors (v3.1.0 UmaCtfAdapter.sol:460-481; PayoutHelperLib.sol:6-19). There is no other "invalid" outcome for binary markets.

| Adapter state | Signal | CTF | Source |
|---|---|---|---|
| initialized | `QuestionInitialized` + CTF `ConditionPreparation`; slots = 2 | den 0 | C v3.1.0 :87-115 |
| proposed (liveness) | OO proposal; `ready()` stays false until the OO has a price. Per-question `liveness` was 600 s and 1800 s live (0 = OO default). MOOv2 can extend review | den 0 | C live; UMA docs :735-737 |
| disputed, 1st | `priceDisputed` auto-resets the question with a new OO request (`QuestionReset`, `reset=true`) | den 0 | C :162-181 |
| disputed, 2nd | Escalates to the DVM; adapter sets `refund=true` | den 0 | C :174-177; resolution.md:52-62 |
| too early | OO settles to ignore price `int256.min`; `resolve()` resets instead of resolving | den 0 | C :422 |
| paused | `pause()` sets `paused`; `resolve()` reverts | den 0 | C :128-137, 274 |
| flagged | `flag()` pauses. Admin may then resolve with a chosen vector: `emergencyResolve` after 2 days (v3.1.0; `EMERGENCY_SAFETY_PERIOD()`=172800 live), or `resolveManually` after 1 h (`0x6507…`/main) | admin-set | C :38, 208-270; main :38, 256 |
| resolved | `QuestionResolved` + `ConditionResolution` in the same tx | den > 0, final | C live |

- **C** V2 equivalent: read `BinaryModule.getResult(bytes31)` and accept only length-2 results summing to 1e6. 50-50 is `[500000,500000]`. Not needed for the first profile (§2).

## 4. Resolution-state API
- **C** `GET https://data-api.polymarket.com/v2/resolutions` with exactly one of `question_id`, `condition` (up to 20, comma-separated) or `event_id` (up to 20). No auth. A miss returns `{"data":[]}`. Errors use `{error, code, retryable, trace_id}` (get-resolution-state.md:9-12, 131-177).
- **C** Fields: `status`, `condition_id`, `question_id`, `market_type` (`BINARY`/`INCREMENTAL_NEGRISK`/`ATOMIC_NEGRISK`), `payouts` (micro-USDC per share), `price`, `proposed_price`, `reproposed_price` (`"69"` = unset), `was_disputed`, `was_arbitrated`, `extended_review`, `new_version_q`, `reporter` (`UMA_OO`/`CHAINLINK`/`EOA`), `resolution_source` (`reported`/`derived`), `resolved_block`, `resolved_at`, `expected_settlement_time`, `transaction_hash`, `log_index`, `last_update_timestamp` (epoch string on question rows, RFC3339 on condition rows) (:273-420).
- **C** Status values: `initialized`, `posed`, `proposed`, `challenged`, `reproposed`, `disputed`, `resolved`. Condition rows can also show `active` and `arbitration` (:399-407). Row precedence: native V2, then UMA, then terminal CTF (:9-12).
- **C, observed pitfalls:**
  - For 2758339 and 3409541, `transaction_hash` was the question's *initialization* tx, not the settlement tx.
  - For 4737427, the condition row's `resolved_block` (94125638) was the V2 migration mirror's block, not the CTF resolution (94125612).
  - `condition` must be the 32-byte form; the 31-byte form returns 400.
  - Use this API as a trigger or hint only.

## 5. Polygon PoS finality
- **C** Docs: query `eth_getBlockByNumber("finalized", …)`. Finality is deterministic via Heimdall milestones, about 2-5 s (finality.md:9-10, 27-33, 44-55).
- **C** Live, 2026-10-07:

  | RPC | `finalized` lag vs head (probes) | Old receipts | `eth_getLogs` range | EIP-1898 `{blockHash, requireCanonical}` |
  |---|---|---|---|---|
  | `https://polygon-bor-rpc.publicnode.com` | 2 blocks | **no** (null) | 10,000 | yes |
  | `https://polygon.drpc.org` | 2 | yes | free plan rejected even a 1,000-block historical range ("ranges over 10000 blocks are not supported on free plan") | yes |
  | `https://polygon.gateway.tenderly.co` | 2 | yes | wide ranges **silently truncated** (2M-block query returned 76 recent logs and missed a known one); 200k range returned "more than 20000 results" | yes |
  | `https://rpc-mainnet.matic.quiknode.pro` | 3 | yes | 10,000 | yes |
  | `https://1rpc.io/matic` | **898-2,004** | no | not tested | not tested |

  Failed: `polygon-rpc.com` (tenant disabled), Ankr (key required), Nodies (paid), BlockPI and Omnia (HTTP 521), OnFinality (rate-limited, -32029). publicnode returned 403 to a request carrying Python-urllib's default User-Agent; the same request with a custom UA succeeded.
- **I** Typical depth: head minus finalized was 2-6 blocks. The two pinned blocks imply about 1.5 s per block (410 blocks in 615 s), so roughly 3-9 s. To confirm, sample over a longer period.

## 6. Live proof
All reads were made at a pinned `finalized` block from publicnode, with the same hash confirmed on drpc and Tenderly. All three providers returned identical payouts. Raw `eth_call`, `eth_getLogs` and receipt request/response pairs are in each file's `rpcExchanges`.

| | 2758339 "Will Bitcoin reach $67,500 in July?" | 3409541 "Will Kai and Speed beat the Minecraft challenge by Aug 17?" | 4737427 "Galus vs. Jindacek: Match O/U 23.5" |
|---|---|---|---|
| conditionId | `0xbe20fcfd54937c2a48a7b8521ca349e6a2c4373566328ebb950a8c35ab1be3d9` | `0x60613b262912ce2e3138ec5610a31a2f932b6300843c094053cb33aaff9f2238` | `0x5aad5e06b8246a4c1a17d6794712bbaa855e8d70c70344a860f9c98fde2fb9a6` |
| questionID | `0x8fa725f0bd0b1f3fc6a2d07be5145fdd80d4a738feda70177dfdaddab49c61fd` | `0x24f034d2102744218ac250623ed0f6ac279bb6d63ecc0bc0599798a65a3e56c9` | `0xc412b81fa1f5db32874c6d685ed4d098d8890aded4fd653213b62d6af38cb25b` |
| oracle / outcomes | `0x6507…f2A7` / `[Yes, No]` | `0x6507…f2A7` / `[Yes, No]` | `0x6507…f2A7` / `[Over, Under]` |
| pinned finalized block | 95124407 `0xe362f8fdf41ac94813ea01969524c1ac64789b81ac58511a9237b3b9b5732d01` | 95124446 `0x26985c455b7c39c0d2cb2ee5df060dff9e9744b2c53a7783cc6d0a04229f8f19` | 95124752 `0x182d9404fb6dd6305154b6d00d46e23d12c3ee9dadf974b385a12c33ba48dcbb` |
| den / num[0] / num[1] | 1 / 0 / 1, so **No** | 1 / 1 / 0, so **Yes** | 2 / 1 / 1, so **50-50** |
| ConditionResolution | block 91235439, tx `0xf427ae8f8eb0a3c20505c2e2687e7f5acad434eb573f52ade690fe51a8101287`, logIndex 441 | block 91916513, tx `0x3e42b2dbb198a58664a344c2e6b8b100ba74ed99731f345838891f082999a8e6`, logIndex 2435 | block 94125612, tx `0x661ad9193e752be4eb47809236018a63a5e90ecde841c2e7df862fd801098a8c`, logIndex 633 |
| adapter QuestionResolved | settledPrice 0, logIndex 442 | settledPrice 1e18, logIndex 2436 | settledPrice 0.5e18, logIndex 634 |

**C** The 2758339 settlement tx is a batch that resolved 15 questions. Adapter state at the pinned block: `resolved=1`, `paused=0`, `reset=0`, not flagged. Primary RPC for the reads: `https://polygon-bor-rpc.publicnode.com`.

## 7. Rate limits
- **C** Limits are Cloudflare, per IP, sliding window, and requests are throttled (delayed) rather than rejected (rate-limits.md:9).
  - Gamma: general 4,000/10 s; `/markets` 300; `/events` 500; `/markets`+`/events` listing 900; `/public-search` 350 (:27-39).
  - Data API v2: 800/10 s overall; `/v2/trades` 300; positions, activity and prices-history 200 each. `/v2/resolutions` has no specific line (:57-66).
  - CLOB general: 9,000/10 s (:76-78).
- **C** The Data API returns 429 with `Retry-After`, or 503 `request_timeout` (get-resolution-state.md:47-54).
- **C** A `/markets/keyset` response carried `Cache-Control: public, max-age=300` with `cf-cache-status: HIT`. **I** Gamma data can therefore be up to 5 minutes stale.

## 8. Detecting negRisk, augmented and "Other" markets (exclude initially)
- **C** Market-level signals: `negRisk:true`, `negRiskOther:true` (the explicit "Other" market), a non-empty `negRiskRequestID`, and `groupItemTitle` (e.g. "Other"). Event-level signals: `enableNegRisk:true`, and augmented when `enableNegRisk && negRiskAugmented` (market-details.md:353-404; live event 30829 has 128 markets and an `Other` market 559779).
- **C** The CTF oracle of a negRisk condition is the NegRiskAdapter `0xd91E…5296`, not `resolvedBy`. The conditionId of 559652 derives from `0xd91E…` and does not derive from its `resolvedBy` `0x2F5e…`. So the §3 derivation check rejects negRisk markets on its own.
- **C** `negRisk` can be absent on old markets. Treat missing as "unknown", not as `false`.

## Recommended supported profile: `ctf-uma-binary-v1`
Support first: Gamma `version=="v1"`, standalone (non-negRisk) binary markets resolved by an allowlisted UMA CTF adapter into the CTF. Accept YES, NO and 50-50. Exclude negRisk/augmented/Other, `resolvedBy == null` (Chainlink up/down), and anything V2-native.

1. **Import gate.** Fetch `GET /markets/{id}` and require all of the following:
   - `version=="v1"`, `negRisk===false`, `negRiskOther!==true`;
   - parent event `enableNegRisk===false`;
   - `outcomes` and `clobTokenIds` each parse to length 2;
   - `resolvedBy` is in the allowlist `{0x65070BE9…f2A7, 0x157Ce2d6…6a49}` (add older versions only for legacy backfill).
2. **Bind identity.** Require `keccak256(resolvedBy ‖ questionID ‖ uint256(2)) == conditionId`. Require `CTF.getOutcomeSlotCount(conditionId)==2` at a finalized block. Optionally re-derive `clobTokenIds[i]` via `getCollectionId(0,cond,1<<i)` and `getPositionId(USDC.e,·)`.
3. **Snapshot terms.** Store `outcomes[0..1]` (the index mapping), `description`, `resolutionSource`, `endDate`, `questionID`, `conditionId`, the oracle and a hash of the snapshot.
4. **Pin finality.** Read `eth_getBlockByNumber("finalized")` on RPC A, then confirm the same hash at that number on RPC B (and C).
5. **Read state.** Read `payoutDenominator(cond)` and `payoutNumerators(cond,0..1)` with `eth_call` at `{blockHash, requireCanonical:true}` on two or more providers. If they disagree, halt.
6. **Decide.**
   - `den==0` means unresolved, so keep waiting whatever Gamma says.
   - Otherwise require `den == n0+n1` and `(n0,n1)` in `{(1,0),(0,1),(1,1)}`, else halt for manual review.
   - `(1,0)`: outcomes[0] wins. `(0,1)`: outcomes[1] wins. `(1,1)`: split 50/50.
7. **Audit (optional).** Locate `ConditionResolution` (topic0 above, topic1 = conditionId, topic2 = oracle) using windows of at most 10k blocks, and check that it matches the state read. Never read an empty `eth_getLogs` result as "unresolved".
8. **Use Gamma and the Data API only as triggers.** That covers `closed`, `umaResolutionStatus` and `/v2/resolutions`.

**Trust inherited (C):** a UMA adapter admin can flag a question and choose the payout after 1 h (`0x6507`) or 2 days (v3.1.0). MOOv2 restricts proposers to a whitelist, and Risk Labs can extend review. Once CTF payouts are written they are immutable.

**Most likely to be wrong (I):** that the allowlist is complete. `0x6507…` was identified by sampling roughly 300 markets. Polymarket deployed it without updating the docs and could do so again, so alert on any unknown `resolvedBy` rather than silently skipping it.
