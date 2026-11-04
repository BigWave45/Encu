# ENCU V1 developer experience workflow

Status: implementation plan, 2026-11-03. This document describes the first operator-approved developer experience for the current single-operator Testnet product. It is not a specification for multi-tenant SaaS.

## Product boundary

The current deployment has one operator-controlled ENCU environment, one configured OutLayer execution wallet/API credential, and multiple logical agents with distinct ENCU credentials and policy allocations. Do not present this as a customer workspace with isolated funds. Do not add public signup, billing, customer wallet provisioning, automated deposits/withdrawals or tenant switching in this V1.

The administrator token is an operator credential. It is not a developer login and must never be given to an agent. Each logical agent receives a separate bearer credential. The OutLayer API key and Supabase service-role key remain server-side.

## Actors and credentials

| Actor | Credential | Allowed work |
| --- | --- | --- |
| ENCU operator/admin | `AGENTGUARD_ADMIN_TOKEN` | Configure treasury controls, create/manage agents, policies, allocations, recipients, approvals and audit |
| Developer/integrator | No separate self-service identity in V1 | Receives operator-approved integration details and an agent credential; stores it in their own server-side secret manager |
| Logical agent process | Agent-scoped bearer token | Read its permitted agent endpoints and submit transfer requests; cannot administer ENCU or choose another agent identity |
| OutLayer provider | Server-side provider API key | Executes/signs through the configured wallet; never exposed to developer browser or agent |

## Experience sequence

### 1. Operator access and environment readiness

**Current capability:** administrator-token entry in the existing dashboard; health and provider-policy inspection.

**Experience requirement:** make the first screen state clear that this is an operator console. Show Testnet/network, service health, connected Supabase/provider status and configured executor identity. Never echo secrets. Distinguish configuration readiness from proof that a transfer will execute.

**Acceptance:** invalid admin credentials cannot reveal dashboard data; agent credentials cannot open admin controls; health checks do not initiate a transfer.

### 2. Create and configure an agent

**Current capability:** `POST /api/agent/agents` creates an agent and returns its generated bearer token once. Allocation and policy controls exist in the dashboard/API.

**Experience requirement:** collect a stable agent ID and display name, then configure its allocation, per-transfer cap, rolling spend limits and autonomous allowance. Explain that autonomous allowance is a cumulative sub-limit, not an increase to the agent allocation or shared treasury ceiling. The current provisioning endpoint issues the token at creation; until setup is complete, the operator must not hand it to an active agent.

**Acceptance:** creation is admin-only; generated token is shown once with an explicit copy/save warning; only its hash is persisted; duplicate/reserved IDs fail safely; allocation and policy updates cannot exceed treasury or committed exposure.

### 3. Authorize recipients

**Current capability:** dashboard management of active/revoked recipient records scoped to an agent. Current data model and routes must be inspected before extending.

**Planned enhancement:** allow multiple exact NEAR account IDs per agent, independently add/revoke each, and introduce explicit deny rules. A deny takes precedence over allow. Treasury-wide deny overrides agent-level allow. Revocation and explicit blocking are distinct audited actions. No wildcard or pattern matching in V1.

**Acceptance:** recipient authorization is checked before reservation and rechecked immediately before provider submission; a blocked destination cannot be re-authorized accidentally; pending requests are stopped if policy changes before submission. Schema, route, UI and concurrency tests must cover these cases before describing the feature as implemented.

### 4. Issue developer integration credentials

**Current capability:** agent creation/rotation endpoints return a new random bearer token once; previous token is invalidated on rotation.

**Experience requirement:** show the token only at creation/rotation, provide copy action, explain server-side storage, and provide a minimal API example using the agent token. Do not show the admin token or provider API key in the integration panel.

**Acceptance:** credential rotation invalidates the old token; the dashboard cannot retrieve a token after the one-time response; API examples use the agent-scoped token and a stable request ID.

### 5. Integrate and submit a request

**Current capability:** `POST /api/agent/transfer` accepts a stable `requestId`, exact recipient account and integer `amountYocto`. The authenticated credential determines agent identity.

**Experience requirement:** provide a copyable HTTP request example, explain yoctoNEAR amounts, idempotency and response states. The developer should be able to run a non-broadcasting validation/health check before any value-moving request. Do not invent a dry-run endpoint unless one is implemented.

**Acceptance:** invalid recipient/amount, wrong identity, duplicate request ID and changed-payload replay have clear outcomes. Replays never create a second provider submission.

## Copy-ready integration quickstart

The following is the agent-side contract. Substitute values from the operator; never put the administrator token, OutLayer API key or Supabase service-role key in agent code.

1. Check service readiness with `GET /api/health`. This endpoint is read-only and does not validate a particular transfer.
2. Check the agent wallet balance with `GET /api/agent/balance`, using the agent bearer token.
3. Submit a transfer only when the operator has completed allocation, spending-policy and recipient setup.

Example request shape:

```http
POST /api/agent/transfer
Authorization: Bearer <AGENT_TOKEN>
Content-Type: application/json

{
  "requestId": "<STABLE_ID_FOR_THIS_LOGICAL_PAYMENT>",
  "to": "<EXACT_AUTHORIZED_NEAR_ACCOUNT_ID>",
  "amountYocto": "<POSITIVE_INTEGER_STRING>"
}
```

`amountYocto` is an integer string in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR). Do not use floating-point arithmetic. Generate a request ID once for a logical payment and reuse that exact ID only when retrying the same agent/recipient/amount operation. A changed payload under the same ID is an idempotency conflict.

Interpret responses conservatively:
- `202 awaiting_approval`: funds are reserved; ENCU has not called OutLayer. An administrator must review the request.
- `202 needs_review`: the provider may have accepted the request or its outcome is ambiguous. Do not create a new request ID or blindly resubmit.
- `403`: policy, recipient, allocation, limit or emergency-stop denial.
- `409`: idempotency conflict.
- `429`: rate limit.
- `401`/`503`: authentication or service availability problem.

A successful HTTP response is not proof of payment. Provider status is diagnostic only. ENCU settles the reservation only after reconciliation verifies the matching transaction on NEAR with FINAL execution evidence. The dashboard's Testnet request panel is a live request path, not a dry run.

## 6. Authorization, approval and execution

**Current capability:** ENCU atomically reserves shared treasury and agent allocation. Requests within the configured autonomous allowance can be submitted once after an atomic policy revalidation. Requests outside the allowance enter administrator approval. Tightened policy, revoked recipient or emergency stop before provider claim prevents autonomous submission and can downgrade it to approval.

**Experience requirement:** show separate states for request received, policy authorized, funds reserved, awaiting ENCU admin approval, submitted to OutLayer, provider-held/ambiguous, NEAR finality verified, and settled. Do not collapse ENCU approval and provider-side approval into one status.

**Acceptance:** no UI status claims a payment is complete before matching NEAR FINAL evidence and exact-once ledger settlement exist.

### 7. Monitor and reconcile

**Current capability:** dashboard transaction history, approval queue, audit/security events, provider status and NEAR reconciliation.

**Experience requirement:** each request should have a detail view that binds the ENCU request ID, agent, exact recipient/amount, reservation state, provider request ID/status, transaction hash, signer/recipient/action verification, NEAR finality and treasury/agent ledger settlement. Clearly label unavailable evidence.

**Acceptance:** ambiguous provider outcomes remain held; no blind retries; provider status alone does not settle the ledger; only matching NEAR FINAL evidence settles.

## Implementation phases

### Phase A — experience map and information architecture
- Label the current dashboard as an operator console.
- Define navigation and page states for Setup, Agents, Recipients & Policies, Integration, Approvals, Transactions and Audit.
- Map each UI action to an existing API route and its authorization boundary.
- Identify missing APIs before adding UI controls.

### Phase B — agent onboarding slice
- Improve the create-agent flow and one-time credential presentation.
- Provide a copyable, accurate integration example.
- Make allocation, per-transfer, rolling and autonomous limits understandable and visibly distinct.
- Add tests for UI state and API error handling.

### Phase C — recipient controls
- Inspect actual schema and management route implementation.
- Design and implement explicit allow/deny semantics with audit and policy revalidation.
- Add migration and regression tests before enabling the UI.

### Phase D — request-to-settlement experience
- Improve developer request examples and response explanations.
- Add transaction detail with provider and NEAR finality evidence.
- Verify that all displayed states derive from persisted records, not optimistic UI assumptions.

## Out of scope

Public developer registration, customer login/workspaces, tenant isolation, per-customer treasury/wallet provisioning, self-service deposits/withdrawals, billing, native NEAR treasury contract, additional execution providers, multi-chain payments and mainnet deployment.

## Release discipline

All implementation stays on `agentguard/build-v1` and the existing draft PR until reviewed. Run CI after each meaningful slice. Do not merge, modify Production, promote a deployment or initiate another live transfer without explicit approval. The latest Preview deployment is READY, but the user’s mobile visual review is pending.
