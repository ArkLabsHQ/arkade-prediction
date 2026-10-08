# Independent reviews (2026-10-07/08)

Four read-only reviews ran against commit `24ccc96`: collateral covenants, oracle binding and import, order
arithmetic, and durability/secrets. Each finding was checked against the code before acting. Fixes were
written test-first where a unit harness could reproduce the defect.

## Collateral covenants (`market_vault`, `resolved_vault`, `claim_box`)

No critical or high findings. Mint/merge integrity, one-shot resolution, redemption rounding, renewal tunnels,
the NUMS exit leaf and the genesis audit were traced through the compiled asm and upstream emulator/arkd code.

| Finding | Severity | Disposition | Evidence |
|---|---|---|---|
| Browser built claim boxes and vault actions from unaudited server terms (forged CTRL could burn a user's claims) | medium | fixed: shared `src/core/audit.ts`, browser verifies before money moves | `test/unit/core/audit.test.ts`, `test/unit/web/verify.test.ts` |
| Threat model said vault collateral is "locked forever" if arkd disappears; the operator's sweep leaf takes it | low | doc fixed | `docs/threat-model.md` §3 |
| Custom markets could set `timeoutAt = 0`, disabling the INVALID fallback | low | fixed: close < timeout <= close + 365 d | `src/server/markets.ts`, e2e fixtures |

## Oracle binding and import

The attestation message, binding, vector checks and finality policy were found sound.

| Finding | Severity | Disposition | Evidence |
|---|---|---|---|
| Source resolving before its end date was never detected; LP and resting orders stayed exposed | medium | fixed: batched early-resolution screen, `halted` status, LP cancel, LP expiry <= close | `test/unit/server/resolver.test.ts`, `keeper-liquidity.test.ts`; live batch check against Polygon (2758339 flagged, 593972 not) |
| Server or Gamma can force INVALID by withholding the certificate | medium | documented (design limit) | `docs/threat-model.md` §2a, §3 |
| Keeper resolution was one-shot; a contended vault left markets unresolvable | medium | fixed with the durability item below | `test/unit/server/keeper.test.ts` |
| Body cap checked only `Content-Length`; negative `limit` unbounded | medium | fixed | `test/unit/server/api.test.ts` |
| Polygon RPC URLs (possible API keys) in public resolution detail and logs | low | fixed: provider labels, URL redaction | `test/unit/server/config.test.ts`, `polymarket.test.ts` |
| Attestor signed whatever labels/question the server sent | low | fixed: labels in order and question must match the source | `test/unit/oracle/identity.test.ts` |

## Order arithmetic

Both offer covenants were found sound (partial fills, rounding, dust, expiry, mint-match, arithmetic); a
200,000-case brute force found no mismatch between the fill planner and the covenants.

| Finding | Severity | Disposition | Evidence |
|---|---|---|---|
| Server tracked the newest coin at an offer's script: a stray coin hijacked tracking and renewals | high | fixed: coin lineage | `test/unit/server/offers-refresh.test.ts` |
| Refresh stuck on a dead coin after two quick spends; phantom bids stalled matching | medium | fixed: lineage walk + match re-planning | same, `keeper.test.ts` |
| Browser trusted the server's outcome label for offers | medium | fixed: asset, side and script checked per leg | `test/unit/web/verify.test.ts` |
| Mint-match ignored min fill and the vault cap; one bad pair blocked a market | low | fixed | `keeper.test.ts` |
| Terminal classification (filled vs settled vs cancelled) fragile near expiry | low | fixed: classified from the bound output | `offers-refresh.test.ts` |

## Durability and secrets

Lease fencing, write-ahead ordering, idempotent handlers, backups and secret handling were found sound apart
from the items below.

| Finding | Severity | Disposition | Evidence |
|---|---|---|---|
| Failed workflows never ran again (resolve, renew, match, activate) | high | fixed: re-arm with growing cooldown, keeps progress; `lost` rebuilds | `keeper.test.ts` |
| Multi-step workflows (activate, LP) marked done when one sub-transaction landed | high | fixed: step recorded, progress resumed; LP offer terms stored before funding | `keeper.test.ts`, `keeper-liquidity.test.ts` |
| Interrupted submit/finalize never finalized | medium | fixed: checkpoints stored before finalize, finalize retried on recovery (arkd semantics confirmed in source) | `keeper.test.ts`; not driven on regtest |
| Restore misses everything first recorded after the backup | medium | documented; SSE id rewind handled | `docs/operations.md`, `api.test.ts` |
| Renewal had no deadline | medium | fixed: 10 min deadline | not driven against a hung batch |
| Lease heartbeat only at tick start | medium | fixed: own 5 s timer | `keeper.test.ts` |
| SSE replay gaps and unbounded queues | low | fixed | `api.test.ts` |
| Concurrent refresh double-counted trades | low | fixed by lineage + conditional update | `offers-refresh.test.ts` |
| URLs logged verbatim | low | fixed | `config.test.ts` |

Found during integration: re-arming dropped a workflow's progress (a re-armed activation would issue a second
genesis) — fixed, `keeper.test.ts`. Added `POST /api/admin/workflows/:id/retry` for workflows the keeper does
not re-plan.
