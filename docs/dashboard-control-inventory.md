# AgentGuard dashboard control inventory

Audit target: `agentguard/build-v1`  
Audit date: 2026-11-03  
Purpose: preserve every working control while reorganizing the existing administrator interface around treasury operations. This document distinguishes controls present in the UI from enforcement implemented in the API/database and from future work.

## Current presentation

The dashboard remains a single client component in `app/page.tsx`. It currently renders:
- Token entry and authenticated dashboard loading.
- Shared budget dashboard and system health.
- Treasury budget summary and global transfer control.
- Agent policy editor and treasury allocation editor.
- Authorized-recipient management.
- Agent list and status controls.
- Pending approval list.
- Searchable/filterable transaction history.
- Administrator audit and security events.
- Live agent request test.
- Agent provisioning and credential rotation.
- Agent balance lookup.

These controls are functionally meaningful. They must not be deleted to simplify the display. The current issue is information architecture: multiple operator jobs are presented in one long page, without a clear hierarchy or navigation between overview, access control, payment operations and audit.

## Control-to-backend inventory

| Control | Backend operation | Why it remains |
|---|---|---|
| Administrator authentication | Admin token gate on `/api/admin/*` | Establishes human authority. Never combine admin and agent permissions. |
| Load / refresh dashboard | GET `/api/admin/dashboard` | Loads treasury, agents, policies, allocations, recipients, reservations and event streams. |
| System health | GET `/api/health` | Diagnoses Supabase, configured execution provider and NEAR RPC. Keep read-only. |
| Shared treasury limit | PATCH `/api/admin/budget`, `update_agent_budget_limit` RPC | Sets the global exposure ceiling. Must not be confused with the sum of agent allocations. |
| Emergency stop / transfers enabled | PATCH `/api/admin/transfers`, `set_agentguard_transfers_enabled` RPC | Treasury-wide stop. Blocks new authorizations and eligible not-yet-submitted execution; cannot recall provider transactions already submitted. |
| Per-agent spend policy | PATCH `/api/admin/agents/policy`, `set_agent_policy` RPC | Sets per-transfer and rolling daily/weekly limits. Retain separately from allocation. |
| Agent treasury allocation | PATCH `/api/admin/agents/allocation`, `set_agent_allocation` RPC | Assigns an agent's maximum share of treasury authority. Allocation is not extra treasury money. |
| Recipient authorization | POST/DELETE `/api/admin/agents/recipients`; `agent_authorized_recipients` registry | Admin authorizes exact account IDs, optional label/expiry; revocation blocks future requests/approval. |
| Agent activate/deactivate | PATCH `/api/admin/agents/status`, `set_agent_active` RPC | Prevents new requests from inactive identities. Retain under agent access controls. |
| Provision agent | POST `/api/agent/agents` | Creates identity and one-time bearer credential; new agent starts with zero allocation. |
| Rotate agent credential | POST `/api/agent/agents/rotate` | Revokes old token and returns replacement once. Does not delete agent or alter its policy/allocation. |
| Approve transfer | POST `/api/admin/approvals` | Revalidates current agent state, policy, recipient, emergency stop and allocation before provider submission. Current execution mode requires human approval for every transfer. |
| Reject transfer | POST `/api/admin/approvals` | Marks pending request rejected and releases both treasury and agent reservations exactly once. |
| Cancel expired request | POST `/api/admin/reservations/resolve` with `cancel_expired` | Only safe when strict proof shows it was never approved or submitted. Releases both ledgers once. |
| Provider status | POST `/api/agent/provider-status` | OutLayer lookup/recovery. Informational; provider acceptance or a hash alone is not settlement. |
| NEAR finality reconciliation | POST `/api/agent/reconcile` | Verifies exact signer, recipient, amount, transfer action and NEAR FINAL before settling. |
| Resolve verified final failure | POST `/api/admin/reservations/resolve` with `failed_final` | Exceptional release path only after chain-verified final failure. Not a generic cancel button. |
| Transaction search/filter/pagination | GET `/api/admin/dashboard` query parameters | Retain full operational history and ability to locate a request by ID, agent, recipient or provider reference. |
| Admin audit pagination | Dashboard audit stream | Records administrator actions and policy changes. Retain. |
| Security event pagination | Dashboard security stream | Records denials and security-relevant events. Retain. |
| Agent balance lookup | GET `/api/agent/balance` | Read-only wallet utility. Separate from admin treasury authority. |
| Live agent request test | POST `/api/agent/transfer` | Test/developer tool. Creates a reservation only; it does not call OutLayer directly. Keep clearly separated from admin approval and payment controls. |
| Copy newly provisioned/rotated token | Browser clipboard | Token is shown once. Do not persist credentials in browser storage. |

## Accounting invariants

The allocation migrations `20261103000000_treasury_agent_allocations.sql` and `20261103010000_enforce_agent_allocations.sql` add the agent allocation ledger and enforce dual-ledger exposure.

Every money-moving RPC must preserve this lock order:
1. Treasury budget row.
2. Agent allocation row.
3. Reservation row.

New reservation checks treasury and agent headroom, inserts the reservation and increments both reserved counters in one transaction. Approval revalidates current authorization and makes no counter change. Rejection and safe expired cancellation release both counters exactly once. Provider submission and ambiguous `needs_review` outcomes retain both reservations. NEAR FINAL success/failure settlement updates both counters atomically with terminal status.

The disposable PostgreSQL concurrency workflow passed on commit `bb1a82a67fe20171155fb4c8ba73f0f8ea1c2350`: two concurrent 3 NEAR requests, each individually eligible under its agent allocation, raced against a 5 NEAR treasury. Exactly one reservation succeeded and the other was blocked by `total_budget_exceeded`; cleanup released the winning reservation. [Run 41599131269](https://github.com/BigWave45/agentguard/actions/runs/41599131269). Normal CI passed on the same commit: [run 41599131195](https://github.com/BigWave45/agentguard/actions/runs/41599131195).

Live Preview checks also confirmed unauthorized-recipient denial, approval denial after recipient revocation, and per-agent allocation-exceeded denial without creating a reservation. Read current database state before relying on any individual agent's allocation or recipient status.

## Recommended presentation hierarchy

Keep the existing controls and actions. Reorganize them in place into these top-level destinations or clearly separated page sections:

### 1. Overview
- Treasury limit.
- Total agent allocations and unallocated authority.
- Spent, reserved/committed and available headroom.
- Emergency-stop state.
- Recent payment activity.
- System health summary.

The global treasury limit is the ceiling; allocations are sub-limits within it. Do not add their values together as if they were independent funds.

### 2. Agents
- Agent identity and active/inactive status.
- Allocation limit, spent, reserved and available.
- Per-transfer, daily and weekly policy limits.
- Provision agent, rotate credential, activate/deactivate.
- Clear warning that a new agent starts with zero allocation.

### 3. Recipients
- Exact NEAR account ID as the authorization key.
- Display label as metadata only.
- Active/revoked status, authorizer and optional expiry.
- Revoke action with a clear explanation of pending, claimed and provider-submitted requests.
- Do not automatically release reservations on revocation.

### 4. Payments
- Pending approvals.
- Searchable transaction history and filters.
- Request, agent, recipient, amount, reservation, provider reference and finality state.
- Provider status and reconciliation actions within transaction detail.
- Keep manual approval visible while it remains the actual execution mode.

### 5. Security and audit
- Emergency stop.
- Security events.
- Administrator audit history.
- Reconciliation exceptions and ambiguous provider states.
- Policy-change history when versioning is implemented.

### 6. System health
- Supabase connectivity.
- NEAR RPC connectivity.
- Current execution backend and signer identity verification.
- Clear degraded/unavailable states.

### 7. Developer tools
- Agent balance lookup.
- Reservation-only request test.
- Test identity selection and token input.
- Explicit warning that a test request reserves funds and that it does not submit directly to the provider.

The navigation can be a compact left rail on desktop and a compact top/tab navigation on mobile. The overview should be the initial screen after admin authentication. Avoid making the first screen a giant form. Use compact metric cards for treasury figures, clear tables for agents and transactions, and detail panels for editing one entity at a time. Destructive actions such as revoke, deactivate and emergency stop require explicit confirmation and clear consequences.

## Native NEAR treasury integration: future UI, not current controls

The existing dashboard remains the administrator control plane if a native NEAR treasury contract is added. Do not remove current OutLayer controls or create duplicate policy editors.

When a native contract is implemented, add a treasury execution configuration/status panel showing:
- Selected backend for that treasury (OutLayer or native AgentGuard contract).
- Treasury contract account ID and network.
- Contract deployment/version and verification status.
- Restricted function-call key status and allowed methods.
- Contract pause state and last observed on-chain state.
- Reconciliation lag / pending promise state.

The backend selection must not become a cosmetic dropdown. It may only be exposed when treasury-to-provider assignment, signing authority, accounting and cross-provider replay protections are implemented. Initially, one treasury should use one execution backend. Do not allow simultaneous OutLayer and contract spending against the same treasury.

Do not show controls for on-chain agent policy, policy versioning, risk scores, autonomous execution or contract upgrades until their enforcement paths exist.

## Refactor rules

- Preserve every existing working action and API contract during the layout refactor.
- Separate administrator controls from agent/developer utilities.
- Do not change policy semantics while changing visual presentation.
- Do not hide manual approvals until autonomous execution and human HOLD review are actually implemented.
- Keep transaction status and finality language precise: submitted, needs review, final executed, final failed, rejected and safely cancelled are different states.
- Do not label provider acceptance as successful payment.
- Keep all credentials server-side where possible; tokens shown once must not be written to local storage.
- Test responsive display on iPhone as well as desktop; tables need a mobile card/scroll treatment without dropping fields or actions.

## Remaining UI work

1. Refactor the existing page into the information hierarchy above without deleting controls.
2. Verify each control still calls its current endpoint and renders server-confirmed results.
3. Add transaction detail views for provider references, reservation exposure and finality.
4. Add policy version history only after its schema and execution-time checks are implemented.
5. Add native contract status only after the contract and adapter exist.
