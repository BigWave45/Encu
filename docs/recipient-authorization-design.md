# AgentGuard recipient authorization registry

Status: approved design for the next implementation phase. This document is not an applied migration.

## Objective

Replace the nullable per-agent `agent_policies.allowed_recipients` array as the authorization source with a dedicated, auditable recipient registry. An agent may request a transfer only to an exact NEAR account ID that an administrator has authorized for that agent.

A display label is metadata only. It never participates in authorization matching.

## Authorization model

- Registry scope is per agent: the same NEAR account can be authorized for one agent and denied for another.
- Authorization key is the exact pair `(agent_id, account_id)`.
- Account IDs are lowercase and must satisfy NEAR account-ID syntax (2–64 characters; lowercase letters/digits with single separators `.`, `-`, or `_`; no leading, trailing, or repeated separators).
- Only the admin API may authorize or revoke recipients. Agent credentials cannot call these RPCs.
- Each record has a label, active/revoked status, authorizing admin, authorization timestamp, optional expiry, and revocation actor/time.
- Reauthorization updates the existing record to active and clears the current revocation fields. Append-only audit events retain the prior authorize/revoke history.
- Expired records are not eligible, even if their stored status is active.
- New agents have no authorized recipients.

## Legacy backfill and default semantics

The existing policy column has three meanings: `NULL` currently means unrestricted, an array means an allowlist, and an empty array means deny all. The new model must not carry the unsafe unrestricted default forward.

- Copy every explicitly listed account ID from each non-NULL legacy allowlist into the registry.
- Treat legacy `NULL` as no authorized recipients. Do not infer authorization from transaction history or from a previous transfer.
- After cutover, reservation and approval RPCs consult only the registry. The legacy column becomes deprecated and is no longer an authorization source.
- Remove the editable recipient textarea from the general policy form. Recipient authorization gets its own admin workflow.

This intentionally tightens existing agents that relied on NULL/unrestricted behavior. They will be unable to create new transfers until an administrator authorizes the required exact account IDs.

## Transaction enforcement

1. Spend paths lock treasury first, then agent allocation, then reservation. `reserve_agent_spend` locks/checks the exact recipient authorization after the idempotency reservation lookup and before creating a new reservation.
2. `approve_agent_transfer` locks treasury, allocation, and reservation, then rechecks the exact recipient authorization while holding its row lock. Recipient-admin mutations lock treasury, allocation, then recipient. The treasury row serializes all these mutation paths, preventing cross-path deadlocks and authorization races.
3. A reservation that already has `submission_claimed_at` represents a submission claim. Revoking the recipient cannot recall a request whose provider submission has already been claimed or sent. The revoke response must disclose counts of awaiting approvals and claimed/in-flight submissions.
4. Reject/cancel/finality settlement continues to update treasury and agent allocation ledgers exactly as in the allocation phase.
5. Revocation does not silently cancel pending reservations or release funds. Pending requests remain reserved until an administrator rejects them or a safe expiry cancellation succeeds. This avoids treating an ambiguous provider state as a failed transfer.

## Database design

Table: `agent_authorized_recipients`

- `agent_id` FK to `agents`
- `account_id` exact NEAR account ID
- `label` optional display label
- `status` active or revoked
- `authorized_at`, `authorized_by`
- `expires_at` nullable
- `revoked_at`, `revoked_by` nullable
- `updated_at`
- primary key `(agent_id, account_id)`
- constraints for account syntax and consistent active/revoked fields

RLS is enabled. No direct anon/authenticated access is granted. Service role receives SELECT only; SECURITY DEFINER RPCs own mutations.

Administrator RPCs:

- `authorize_agent_recipient(agent_id, account_id, label, expires_at, actor)`
- `revoke_agent_recipient(agent_id, account_id, reason, actor)`

Both serialize on the treasury row before allocation/recipient locks, write append-only audit records, and return the exact account ID plus relevant pending/in-flight counts.

## API and dashboard

- `GET /api/admin/dashboard` includes the recipient registry.
- `POST /api/admin/agents/recipients` authorizes an exact account ID.
- `DELETE /api/admin/agents/recipients` revokes an exact agent/account pair (or a dedicated PATCH action if that better matches existing route conventions).
- Dedicated Recipients panel: agent selector, exact account ID, optional label/expiry, active/revoked state, authorizer, and affected pending/in-flight reservation counts.
- No agent-facing endpoint can create, edit, or revoke recipient authorizations.
- General policy form retains max transfer, daily and weekly limits only.

## Required tests

- Backfill copies explicit legacy arrays and converts NULL to no registry entries.
- Exact account ID match; display label never grants authorization.
- Unknown recipient denied at reservation.
- Expired and revoked recipient denied at reservation.
- Agent credential cannot authorize or revoke.
- Admin can authorize, reauthorize and revoke; every action is audited.
- Revocation blocks a pending approval before submission claim.
- Revocation reports already-claimed/in-flight requests and does not claim to recall them.
- Revocation leaves reservations/counters unchanged; explicit reject/safe cancellation releases both ledgers.
- Concurrent authorize/revoke/reserve/approve operations preserve lock order and never bypass the registry.
- Existing allocation, treasury, idempotency, audit rollback and NEAR finality suites remain green.

## Rollout constraints

- Apply only to isolated Preview after disposable PostgreSQL migration and lifecycle tests pass.
- Do not apply to Production until explicitly authorized.
- Do not authorize historical recipients automatically when the legacy policy was NULL.
- Do not enable autonomous execution as part of this phase. Manual approval remains the execution mode.
