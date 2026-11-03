# Dashboard control inventory

Audit target: `agentguard/build-v1`
Audit date: 2026-11-03
Scope: read-only inspection of the current dashboard page, its directly invoked API routes, and the V1 SQL schema. This document records observed behaviour, not proposed or implemented functionality.

## Current UI structure

The dashboard is implemented in one client component: `app/page.tsx`. It combines agent-facing balance lookup, administrator controls, transaction operations, audit views, and a test request form. There are no separate dashboard route modules or feature components in the inspected paths.

## Control-to-backend inventory

| UI control / interaction | Current frontend action | Backend / data operation | Current behaviour and disposition |
|---|---|---|---|
| Check NEAR balance | GET `/api/agent/balance` with bearer token | OutLayer balance GET; agent auth and persistent rate limit | Read-only wallet balance lookup. Retain as agent utility, separate from admin dashboard. |
| Load / refresh dashboard | GET `/api/admin/dashboard` | Reads `agent_budgets`, `agents`, `spend_reservations`, `agentguard_system_controls`, `agent_policies`, admin audit and security events | Admin-only aggregate read. Retain; later split into domain-specific dashboard data hooks/routes only if justified. |
| Check system health | GET `/api/health` | Supabase budget read, OutLayer executor-address check, NEAR RPC chain check | Operational diagnostics; public endpoint returns connection state and public executor account. Retain under System health. |
| Update shared budget limit | PATCH `/api/admin/budget` | `update_agent_budget_limit` RPC locks the single `default` budget row and rejects limit below spent + reserved | This is one global budget, not a treasury plus agent allocation model. Retain as treasury ceiling; do not present it as agent allocation. |
| Emergency stop / Enable transfers | PATCH `/api/admin/transfers` | `set_agentguard_transfers_enabled` updates one global `agentguard_system_controls` row and writes admin audit | Global stop for new reservations and unclaimed submissions. It cannot recall provider submissions already in flight. Retain and clarify state/scope. |
| Save per-agent policy | PATCH `/api/admin/agents/policy` | `set_agent_policy` writes max transfer, rolling 24h/7d caps, nullable recipient allowlist and audit | Policy is currently mutable in place; no policy version history is exposed. Recipient list is embedded in each agent policy, not a dedicated recipient registry. Retain current enforcement while versioning and recipient lifecycle are designed. |
| Activate / deactivate agent | PATCH `/api/admin/agents/status` | `set_agent_active` RPC | Prevents new reservations from inactive agents; primary identity cannot be deactivated. Retain under Agents. |
| Provision agent credential | POST `/api/agent/agents` | Generates random bearer token, stores SHA-256 hash through `create_agent_with_audit` | Admin-only; token is shown once. Retain under Agents. New agent currently inherits no explicit budget allocation because allocations do not exist. |
| Rotate agent credential | POST `/api/agent/agents/rotate` | Generates replacement token and calls `rotate_agent_credential` | Old token becomes invalid; primary identity cannot be rotated through this route. Retain under Agent security. |
| Approve and submit | POST `/api/admin/approvals` | Verifies OutLayer signer, checks pending reservation/global cap, calls `approve_agent_transfer`, then `transferNear`, records provider metadata | This is the only inspected UI path that submits a transfer. Every new request currently waits for admin approval. Retain for manual-approval mode; autonomous execution is not implemented. |
| Reject | POST `/api/admin/approvals` | `reject_agent_transfer` RPC | Rejects a pending request with a fixed UI reason. Retain for manual mode and human-reviewed exceptions. |
| Cancel expired request | POST `/api/admin/reservations/resolve` with `cancel_expired` | `cancel_expired_agent_transfer` RPC | Intended only for expired, unsubmitted requests; retain with strict state checks. |
| Check provider | POST `/api/agent/provider-status` | Looks up OutLayer request status; may recover provider transaction hash | Provider status is informational and does not settle the ledger. Retain in transaction detail. |
| Reconcile on NEAR | POST `/api/agent/reconcile` | Queries NEAR transaction at FINAL and verifies signer, recipient, single transfer action and exact amount before settlement | Critical settlement operation. Retain; never equate provider acceptance with finality. |
| Resolve verified final failure | POST `/api/admin/reservations/resolve` with `failed_final` | Independently queries NEAR FINAL, verifies exact transaction details and failure, then calls failure-resolution RPC | Controlled exceptional resolution. Retain under reconciliation tools; do not expose as a generic cancel/release action. |
| Transaction search | Query parameter `q` to dashboard GET | Searches request ID, agent, recipient, provider tx/request IDs | Retain. |
| Transaction status filter | Query parameter `status` to dashboard GET | Filters awaiting approval, reserved, needs review, executed, failed, rejected, cancelled, aged | Retain. Separate operational review queue from full transaction history in the redesigned information architecture. |
| Transaction pagination | Dashboard GET page/pageSize | Paginated `spend_reservations` query | Retain. |
| Admin audit pagination | Dashboard GET auditPage | Paginated `agentguard_admin_audit` read | Retain under Audit. |
| Security event pagination | Dashboard GET securityPage | Paginated `agentguard_security_events` read | Retain under Security events. |
| Live agent request test | POST `/api/agent/transfer` | Authenticates agent, consumes fixed transfer-prepare rate limit, validates global cap, calls atomic `reserve_agent_spend` RPC | Creates a reservation only. It explicitly does not call OutLayer; current status is awaiting approval. Keep clearly labelled as a test/developer tool, not as an admin payment control. |
| Copy newly provisioned/rotated token | Browser clipboard | No backend call | Retain; token is only displayed once. Avoid persistence in browser storage. |

## Confirmed backend and schema limits

1. The database has one `agent_budgets` row with ID `default`. Reservations atomically increase the single `reserved_yocto` total. There is no treasury entity plus per-agent allocation table or allocation RPC.
2. Per-agent policy currently contains only max transfer, rolling daily/weekly limits, and a nullable recipient allowlist. A null allowlist is unrestricted; an empty array blocks all recipients.
3. Recipient authorization is currently a list embedded in each agent policy. There is no dedicated recipient record, admin authorization lifecycle, revocation timestamp, or explicit revalidation endpoint.
4. Policy updates overwrite the current `agent_policies` row. The row stores updated_at/updated_by but no immutable policy versions or version binding on reservations.
5. Agent request rate limiting is currently hard-coded at 20 transfer-preparation requests per 60 seconds in `app/api/agent/transfer/route.ts`. The persistent rate-limit primitive exists, but no per-agent configurable execution profile is exposed.
6. The transfer request path always creates `awaiting_approval`. OutLayer submission happens in the administrator approval route. Autonomous policy-authorized execution is not implemented.
7. The approval route verifies the OutLayer signer before consuming approval, then rechecks approval constraints through the database RPC. The signer endpoint contract still requires validation against authoritative OutLayer documentation.
8. Provider status does not settle budget. NEAR FINAL reconciliation is the normal settlement path. Ambiguous provider submission remains reserved/needs_review and must not be blindly retried.
9. The UI uses one administrator token held in component memory. Agent credentials are separate. The primary identity has special restrictions for deactivation/rotation.

## UI disposition

### Preserve and reorganize

- Treasury overview: current shared budget figures, global stop, and budget ceiling editor.
- Agents: provisioning, activation/deactivation, credential rotation, current policy editor, and agent status.
- Transactions: full searchable/filterable history and pagination.
- Review queue: pending manual approvals plus suspicious/ambiguous cases, once risk-hold semantics exist.
- Reconciliation: provider lookup, NEAR finality check, and verified-final-failure resolution.
- Audit and security: retain both paginated event streams.
- System health: retain connection and signer diagnostics.
- Developer tools: keep balance lookup and reservation-only test request clearly separated from administrator controls.

### Add only after backend enforcement exists

- Per-agent allocations subordinate to the global treasury ceiling, with atomic shared treasury + agent allocation reservation.
- Dedicated recipient registry with exact account-ID authorization, administrator attribution, activation/revocation and execution-time revocation checks.
- Versioned agent policies, policy version recorded on each authorization, and revalidation immediately before provider submission.
- Explicit per-agent execution profiles and configurable rate limits, bounded by a mandatory system/provider hard ceiling.
- Autonomous execution for deterministic ALLOW decisions, retaining manual-approval mode and human review for HOLD decisions.
- Risk review queue quotas, deduplication, escalation and reservation lifecycle controls.

## Next implementation gate

Do not begin visual rearrangement until the existing controls have been mapped to the intended navigation and the underlying treasury/allocation, recipient, policy-version and execution-profile contracts are specified. UI work must not imply enforcement that the API and database do not yet provide. Preserve existing endpoints and operational controls during the refactor.


## Allocation-control addendum (2026-11-03)

The dashboard now reads the per-agent allocation ledger and exposes an administrator control for assigning each agent a cumulative allocation ceiling.

- Dashboard read: `GET /api/admin/dashboard` now returns `allocations[]` with agent ID, allocation limit, spent, reserved, updated time and actor.
- Allocation write: `PATCH /api/admin/agents/allocation` accepts an exact agent ID and integer yocto allocation. It is admin-authenticated and rate-limited. It calls `set_agent_allocation`; the database enforces committed-exposure and aggregate treasury ceilings.
- Dashboard UI: the Shared budget dashboard now displays total allocated authority and unallocated authority, plus a per-agent allocation editor showing spent, reserved and available amounts.
- Provisioning: new agents receive a zero allocation in `create_agent_with_audit`; credential creation does not grant spending authority.
- Treasury limit: `update_agent_budget_limit` rejects a new ceiling below either spent + reserved or the sum of agent allocation limits.
- Transfer preparation: `reserve_agent_spend` returns a policy block when the request would exceed the agent allocation. It reserves both ledgers atomically.
- Settlement: reject, safe expiry cancellation, final execution, final failure and NEAR-FINAL failed resolution update both ledgers atomically. Provider submission and `needs_review` retain reserved exposure.
- Lock order: treasury row, agent allocation row, reservation row. The enforcement migration re-backfills under the treasury lock and takes a table lock on agents to cover legacy provisioning between the additive schema and enforcement migrations.

The two migrations are applied to the isolated AgentGuard Test Supabase project only. Production remains unchanged. The Vercel Preview deployment has not yet been updated because the Hobby team build-rate limit is still outstanding.
