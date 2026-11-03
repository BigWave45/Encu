# ENCU V1 security implementation plan

Status: implementation specification for `agentguard/build-v1`.
Target: testnet V1 submission. This document is a fixed scope boundary, not a commitment to add unrelated platform features.

## Existing controls to preserve

- Separate administrator and agent credentials.
- Agent activation/deactivation and one-time credential provisioning/rotation.
- One shared budget, atomically reserved in Supabase before provider submission.
- A global per-transfer cap through `AGENTGUARD_MAX_TRANSFER_YOCTO`.
- Request-ID idempotency and conflict detection.
- No automatic transfer retries.
- Provider status lookup and NEAR FINAL reconciliation with signer, recipient, and amount verification.
- Ambiguous outcomes remain reserved for review.

Do not replace or weaken these controls while adding the items below.

## Required V1 additions

### 1. Global emergency stop

- Persist one system-control record in Supabase; do not use a process-local flag or Vercel environment variable.
- Admin-only API to read and change the transfer-enabled state.
- Enforce the state in the database reservation/claim path as well as the API. A hidden or disabled UI button is not a security control.
- When disabled, new reservations and new provider-submission claims fail closed and are audited.
- A provider call already claimed/in flight when the stop is activated cannot reliably be recalled. The UI and documentation must state this boundary.
- Default state on a fresh installation: disabled until explicitly enabled by an administrator. Existing database migration must preserve the current operational state only if it can be determined safely; otherwise fail closed and require explicit activation.

### 2. Per-agent and time-window spending policies

- Add an agent policy record with optional maximum per-transfer, daily spend, and rolling/seven-day spend limits.
- Enforce limits atomically in the same database transaction that reserves shared budget. Never calculate the limit from dashboard data or a non-transactional API read.
- Count both settled spend and active reservations in the applicable window so concurrent requests cannot exceed a cap.
- Use UTC windows and document them. Prefer rolling 24-hour and rolling 7-day windows if the SQL implementation can enforce them correctly; otherwise use UTC calendar day/week and label them accurately.
- A null policy limit means that particular additional limit is not configured; the existing global per-transfer cap and shared budget still apply.
- The primary agent must receive a policy row during migration. Additional agents receive a policy row at creation.

### 3. Recipient allowlists

- Support an explicit per-agent list of permitted NEAR account IDs.
- Normalize and validate account IDs consistently with the transfer request schema.
- Enforce recipient policy in the atomic reservation function before a reservation is created.
- A null allowlist means unrestricted recipients; an explicit list restricts transfers to those accounts. The dashboard must make this distinction visible.
- Do not silently convert an empty configured list into unrestricted access.

### 4. Human approval

- Financial transfers must have a reviewable, parameter-bound approval before OutLayer submission.
- Separate preparation from execution. Preparation records the authenticated agent, request ID, exact recipient, exact yocto amount, and policy decision, and reserves budget without calling OutLayer.
- The admin review screen must display the exact recipient, amount, requesting agent, request ID, and expiry.
- Approval must be admin-authenticated, single-use, expiring, and bound to the exact prepared transfer. Any changed parameter invalidates the approval.
- The execution path must atomically consume the approval immediately before the provider call. Replays cannot submit twice.
- Reject execution if the emergency stop is active, the agent is inactive, the approval is expired/used, or the reserved transfer no longer matches the approved parameters.
- A denied or expired request must not release an ambiguous provider submission. For a request that has not been submitted, a safe cancellation path may release its reservation with an audit record.
- Do not let an agent approve its own request. The administrator credential is the only approver in V1.

### 5. Rate limiting

- Add server-side rate limits for transfer preparation and sensitive admin mutations.
- Use a shared persistent/atomic store, not an in-memory map, because Vercel instances are ephemeral and concurrent.
- Key agent limits by authenticated agent identity; key admin limits by administrator identity and action.
- Return HTTP 429 with a retry hint and write a security event for repeated or abusive denials.
- Keep the configured limits conservative and documented. Do not claim DDoS protection from application-level rate limiting.

### 6. Reliable audit writes

- Security-critical mutations must fail closed if their audit record cannot be committed.
- Agent creation/rotation, policy changes, emergency-stop changes, approvals, denials, cancellations, and reservation state changes must be auditable.
- Prefer database functions that perform the state mutation and audit insert in the same transaction.
- Never log bearer tokens, provider secrets, or full authorization headers.

### 7. Safe stuck-reservation handling

- Preserve the existing provider lookup and NEAR FINAL reconciliation.
- Add an admin view/filter for aged `needs_review` and ambiguous reservations.
- Do not add a generic "release" button. Release is permitted only after authoritative evidence establishes that no transfer was submitted or that the transaction failed finally.
- Every resolution requires an explicit reason, evidence/reference, administrator identity, and atomic ledger update plus audit record.
- If the outcome is still ambiguous, keep the reservation held.

## API and dashboard boundaries

- Agent endpoints authenticate agent credentials only.
- Admin policy, emergency-stop, approval, and resolution endpoints authenticate the separate administrator credential only.
- Agent identity always comes from the bearer token, never from a client-supplied agent ID.
- The dashboard must distinguish configured policy from effective policy and clearly show when a recipient list is unrestricted.
- Keep balance lookup, health checks, and local-only simulation separate from actual transfer execution.

## Database and migration requirements

- Add an additive upgrade migration for the existing ENCU database; do not rerun `supabase/setup.sql` against an existing project.
- Update the fresh-install setup separately so a new project gets the same schema.
- Use constraints, indexes, row locks, and service-role-only RPC permissions.
- Ensure reservation creation, policy checks, rolling spend checks, and shared-budget reservation are one atomic operation.
- Ensure approval consumption and transition to provider-submission-eligible state are atomic.
- Preserve existing reservation history and do not reset counters or ledger data.
- Do not apply migrations to the user's live Supabase project without explicit approval.

## Verification gates

1. Agent and admin credentials remain isolated.
2. Emergency stop rejects new reservations and submission claims; in-flight boundary is tested/documented.
3. Per-agent, daily, and weekly limits reject over-limit requests, including concurrent requests.
4. Recipient allowlist rejects an unlisted recipient before reservation/provider submission.
5. Approval is exact-parameter-bound, admin-only, expires, and cannot be replayed or self-approved.
6. Rate limits work across simulated independent application instances.
7. Security-critical state changes roll back if audit insertion fails.
8. Stuck reservations cannot be released without the defined evidence path.
9. Existing idempotency, shared-budget concurrency, provider-status, and NEAR FINAL reconciliation tests continue to pass.
10. Lint, type-check, and production build pass.

## Explicitly out of scope for this V1 pass

- Multiple chains or providers.
- Smart contracts or custody.
- Forecasting, anomaly scoring, and AI-generated risk decisions.
- General-purpose visual policy builder.
- Analytics dashboards, webhooks, and exports unless a submission requirement is identified.
- Production/mainnet activation.

## Release discipline

All work stays on `agentguard/build-v1`. Do not merge to `main`, deploy Production, apply live database migrations, or initiate a real transfer without the user's explicit approval. A Preview deployment and mocked tests are not proof of live end-to-end settlement.
