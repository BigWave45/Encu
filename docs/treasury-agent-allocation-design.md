# Treasury and agent allocation design

Status: design reviewed against the current Preview schema and RPC definitions. This document is not a migration and does not change database state.

## Current implementation verified

- `agent_budgets` has one `default` row with treasury ceiling, spent and reserved counters.
- `spend_reservations` is the transaction history and stores `agent_id`, amount and lifecycle status.
- `reserve_agent_spend` serializes on the treasury row, checks agent active state, current per-agent policy, recipient array, daily/weekly exposure and treasury headroom, then inserts an `awaiting_approval` reservation and increments treasury reserved.
- `approve_agent_transfer` serializes on the treasury row and revalidates active state, current policy and recipient. It changes status to `reserved` but does not change exposure counters.
- `reject_agent_transfer` releases treasury reserved and marks the request rejected.
- `cancel_expired_agent_transfer` releases treasury reserved only for an expired, never-approved, never-submitted request.
- `record_outlayer_submission` stores provider references and changes the reservation to `needs_review`; it does not release exposure.
- `finish_agent_spend` converts reserved to spent on executed finality, releases reserved on failed finality, and retains exposure on `needs_review`.
- `resolve_agent_transfer_failed_final` releases reserved only after the API verifies matching NEAR FINAL failure evidence.
- `update_agent_budget_limit` prevents the treasury ceiling being lowered below treasury spent plus reserved.
- These privileged RPCs are executable by service_role and not anon/authenticated. The live Preview schema has no allocation table or allocation RPC.

Preview ledger observation at review time: treasury ceiling 5 NEAR, spent 0.001 NEAR, reserved 0. The reservation history contains one executed 0.001 NEAR transfer, one rejected 3 NEAR request and one cancelled 3 NEAR request. The current counters reconcile to the executed and open reservation totals. No Preview data was changed during this review.

## Required invariant

Agent allocation is a sub-limit of treasury authority, never additive authority.

- Sum of all agent allocation limits must be less than or equal to the treasury ceiling.
- For each agent: spent + reserved must be less than or equal to its allocation.
- For the treasury: spent + reserved must be less than or equal to its ceiling.
- Treasury available = treasury ceiling - treasury spent - treasury reserved.
- Agent available = agent allocation - agent spent - agent reserved.
- Unallocated authority = treasury ceiling - sum(agent allocations).
- A reservation is accepted only if both treasury available and that agent's available allocation cover the amount.
- An agent created without an explicit allocation starts with zero spending authority.

## Data model

Add `agent_allocations`, keyed by `agent_id` and referencing `agents(id)`:

- `agent_id`
- `allocation_limit_yocto numeric(78,0) not null check >= 0`
- `spent_yocto numeric(78,0) not null default 0 check >= 0`
- `reserved_yocto numeric(78,0) not null default 0 check >= 0`
- `updated_at`, `updated_by`

Enable RLS, revoke public/anon/authenticated access, and grant only the minimum service_role access. Do not expose direct table mutation.

The counters are deliberately duplicated for efficient authorization and dashboard reads. Their only writers must be the security-definer RPCs below. Add a reconciliation query/test that compares allocation counters with reservation history and treasury counters. Treat any mismatch as an operational security incident; do not silently repair it in a request path.

## Atomic locking and lifecycle

All money-moving RPCs keep the existing lock order: treasury row first, then allocation row, then reservation row. Every path that changes exposure must follow this order to avoid deadlocks and serialize cross-agent spending against the same treasury ceiling.

- New reservation: check treasury headroom and agent allocation headroom; insert reservation; increment treasury reserved and that agent's reserved in one transaction.
- Approval: revalidate the current agent policy, recipient authorization, active state, emergency stop and allocation exposure. No counter change.
- Rejection: decrement treasury reserved and agent reserved exactly once; mark rejected in the same transaction.
- Safe expired cancellation: decrement both reserved counters exactly once; retain existing strict proof that the request was never approved or submitted.
- Provider submission / needs_review: retain both reserved counters. Provider ambiguity is not failure.
- NEAR FINAL success: decrement both reserved counters and increment both spent counters atomically with terminal status and audit.
- NEAR FINAL failure: decrement both reserved counters atomically with terminal status and audit.
- Repeated finality or terminal resolution: idempotent; no second counter movement.
- Emergency stop: no new reservation or submission claim; already submitted/in-flight transactions remain reserved until reconciled.

The current `finish_agent_spend` accepts `needs_review` while retaining reservation exposure. Preserve this behaviour for both ledgers.

## RPCs requiring coordinated changes

1. `reserve_agent_spend`: require an allocation row and enforce agent allocation and treasury ceilings; update both reserved counters.
2. `reject_agent_transfer`: release both reserved counters.
3. `cancel_expired_agent_transfer`: release both reserved counters.
4. `finish_agent_spend`: update both counters on executed/failed outcomes; retain both on needs_review.
5. `resolve_agent_transfer_failed_final`: release both reserved counters.
6. `approve_agent_transfer`: revalidate allocation row and exposure before provider submission; no counter movement.
7. `update_agent_budget_limit`: reject a new treasury ceiling below spent + reserved or below sum of agent allocations.
8. New `set_agent_allocation`: admin-only RPC, validates agent exists, nonnegative integer amount, allocation >= that agent's spent + reserved, and sum of allocations after change <= treasury ceiling. Audit old/new values.
9. `create_agent_with_audit`: create the agent's allocation row at zero in the same transaction as identity, policy and audit creation.
10. Any other future RPC that creates or mutates a reservation must participate in this same lock and counter protocol.

`record_outlayer_submission` does not change allocation counters, but must retain the treasury-first lock order and must never release exposure.

## Migration and existing Preview data

- Add an additive migration; do not rewrite or reset the existing ledger.
- Backfill allocation spent from `executed` reservations grouped by agent.
- Backfill allocation reserved from `awaiting_approval`, `reserved`, and `needs_review` reservations grouped by agent.
- Reconcile those aggregates against the existing treasury `spent_yocto` and `reserved_yocto` before enabling enforcement. Abort migration if they do not reconcile.
- Seed each existing agent's allocation limit to exactly its historical spent + reserved amount. This preserves existing commitments without granting additional authority. Administrators must explicitly assign new headroom.
- For current Preview history, this implies alpha starts with 0.001 NEAR spent and 0 reserved; beta and primary start with 0 spent and 0 reserved. Their initial allocation ceilings should equal those exposures, so zero for beta and primary. Do not carry over the current 5 NEAR treasury limit as an agent allocation.

## API and dashboard

- Keep the existing shared budget editor as the treasury ceiling.
- Add a per-agent allocation editor. Do not conflate it with max transfer, daily limit or weekly limit.
- Display treasury ceiling, allocated total, unallocated authority, treasury spent, treasury reserved and available headroom.
- Per agent display allocation, spent, reserved, available, plus the existing transfer/daily/weekly limits.
- Provisioning creates a zero-allocation agent; administrator must allocate funds separately.
- Preserve the existing manual approval workflow. Autonomous policy-authorized execution is a later stage and must not bypass these allocation checks.

## Required tests before Preview rollout

- Zero-allocation agent cannot reserve.
- One agent cannot exceed its own allocation even when treasury headroom exists.
- Multiple agents cannot collectively exceed the treasury ceiling under concurrent reservations.
- Sum of allocation ceilings cannot exceed treasury ceiling.
- Lowering an allocation below its spent + reserved exposure is rejected.
- Lowering treasury below spent + reserved or below sum of allocations is rejected.
- Reject, safe cancel, final success and verified final failure update both ledgers exactly once.
- needs_review and ambiguous provider submission retain both reservations.
- Repeated terminal reconciliation cannot double-debit or double-release.
- Audit failure rolls back both ledgers and reservation state.
- Agent creation creates zero allocation atomically.
- RLS and function grants prevent anon/authenticated direct access.
- Reconciliation query detects any mismatch between counters and reservation history.

## Explicitly out of scope for this change

Recipient registry/versioning, immutable policy versions, suspicious-transaction scoring/hold quotas, execution profiles, and autonomous execution are separate workstreams. Do not imply they are implemented by allocation support.


## Implementation update (2026-11-03)

The allocation model described above has since been implemented on `agentguard/build-v1`.

- Migration: `supabase/20261103010000_enforce_agent_allocations.sql`.
- Added `agent_allocations` with per-agent limit, spent and reserved counters.
- Backfill reconciles historical reservation states against treasury counters and aborts on mismatch.
- Reservation, approval, rejection, expiry cancellation, settlement and final-failure resolution maintain treasury and agent counters atomically.
- Agent provisioning creates a zero-allocation row.
- Admin allocation RPC, API and dashboard controls expose allocated, spent, reserved, available and unallocated authority.
- The isolated AgentGuard Preview Supabase database has this migration applied. Preview state at last check: treasury ceiling 5 NEAR, spent 0.001 NEAR, reserved 0. Production was not modified.
- CI passed the build, API lifecycle/security and PostgreSQL concurrency coverage for the allocation phase.

The subsequent recipient-authorization phase is documented separately in `docs/recipient-authorization-design.md`; its migration is still awaiting the final upgrade-suite pass and has not been applied to Preview.
