# AgentGuard

AgentGuard is a transaction-control gateway for AI agents making NEAR transfers on the explicitly selected network through OutLayer. Multiple independently authenticated agents share one spending budget. AgentGuard reserves budget before calling the provider, attributes each reservation to the authenticated agent, blocks replayed requests, and reconciles submitted transfers against NEAR finality before settling the ledger.

## Current scope

- NEAR native-token transfers through one configured OutLayer wallet on the selected network (testnet by default; mainnet requires explicit configuration).
- Multiple agents with separate bearer credentials and one shared budget.
- Atomic budget reservation in Supabase before a provider call.
- Request-ID idempotency and conflict detection.
- Per-agent reservation attribution.
- NEAR FINAL transaction reconciliation.
- Admin-only dashboard, emergency stop, per-agent spending policies and mandatory human approval before provider submission.
- Persistent per-agent rate limiting, recipient allowlists and rolling spend windows.

This is a testnet V1. It is not a custody provider, smart contract, marketplace, or multi-chain gateway. A transfer has not been confirmed merely because OutLayer accepted a request or returned a transaction hash.

## Architecture

```text
Agent
  -> AgentGuard API
  -> authenticated agent identity
  -> atomic policy and shared-budget reservation (Supabase)
  -> administrator approval bound to exact recipient and amount
  -> OutLayer transfer
  -> NEAR testnet
  -> NEAR FINAL reconciliation
  -> settled shared ledger
```

Supabase is the source of truth for the shared budget and reservation ledger. OutLayer is the configured transfer provider. NEAR RPC is used to independently verify final transaction execution.

**Product boundary:** OutLayer supplies a TEE-backed custody and wallet-policy boundary. Its owner policy can enforce wallet-wide limits and transaction restrictions before signing. AgentGuard adds a separate application authorization boundary: logical agent identities, per-agent allocations, shared-treasury exposure accounting, request idempotency, exact-recipient authorization, approval workflow, attributable audit and NEAR-finality-based ledger settlement. The current integration uses one OutLayer wallet/API credential and does not map each AgentGuard agent to a distinct OutLayer signer or provider policy. AgentGuard's per-agent allocation ledger is therefore enforced by AgentGuard, while OutLayer's wallet policy is an independent wallet-wide backstop. OutLayer is the only execution provider implemented in V1. See [`docs/outlayer-v1-backlog.md`](docs/outlayer-v1-backlog.md) for the provider-policy inspection and remaining integration tests.

## Environment variables

Configure these in the deployment environment:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase service-role key; never expose it to a browser |
| `AGENTGUARD_NETWORK` | `testnet` (default) or explicitly `mainnet`; must match provider and RPC hosts |
| `OUTLAYER_BASE_URL` | Testnet: `https://testnet-api.outlayer.ai`; mainnet: `https://api.outlayer.ai` |
| `OUTLAYER_API_KEY` | OutLayer server-side API credential |
| `OUTLAYER_NEAR_ADDRESS` | Exact NEAR account ID of the configured OutLayer wallet for the selected network |
| `NEAR_RPC_URL` | Optional; defaults to the canonical RPC host for the selected network |
| `AGENTGUARD_AGENT_TOKEN` | Primary agent bearer credential; no administrator privileges |
| `AGENTGUARD_ADMIN_TOKEN` | Separate administrator bearer credential for dashboard and management operations |
| `AGENTGUARD_MAX_TRANSFER_YOCTO` | Maximum amount allowed in one transfer, in yoctoNEAR |

`AGENTGUARD_NETWORK` defaults to `testnet`. Mainnet is supported by explicitly setting `AGENTGUARD_NETWORK=mainnet`, `OUTLAYER_BASE_URL=https://api.outlayer.ai`, and `NEAR_RPC_URL=https://rpc.mainnet.near.org`. The selected network must match the exact provider and RPC host allowlists. Local mock endpoints are accepted only outside production or in the explicit CI test harness. `OUTLAYER_NEAR_ADDRESS` is mandatory and must be the OutLayer executor account ID that signs native NEAR transfers. OutLayer may return this as a 64-character lowercase hexadecimal NEAR implicit account ID; it is not necessarily the named asset account the wallet acts for. Do not substitute a bound asset account such as `alice.near`. Health compares this value with OutLayer’s reported `executor_account_id`; reconciliation checks the same signer against chain transaction details.

Never commit real credentials or send them in issue reports, screenshots, or chat messages. Rotate any credential that may have been exposed.

## Database setup

The repository has two different database paths. Keep them separate.

### Fresh Supabase project

Run `supabase/setup.sql` once in the Supabase SQL Editor. It creates the baseline multi-agent schema and privileged RPCs. Then apply the forward migrations listed below in timestamp order to bring that baseline to the current V1 schema. The setup script is not an upgrade mechanism and must not be run against an existing database.

### Existing AgentGuard database

Do not assume that a database is at a particular migration step because a previous README version said so. Inspect both its schema and `supabase_migrations.schema_migrations` before applying anything. The SQL files are forward changes; do not replay a migration that is already represented in the database or whose effects are already present.

The V1 forward migrations, in required order, are:

1. `supabase/20261101190000_agentguard_v1_security_controls.sql`
2. `supabase/20261101230000_submission_audit_and_append_only.sql`
3. `supabase/20261102080000_admin_actor_self_approval_guard.sql`
4. `supabase/20261102090000_reserve_admin_agent_id.sql`
5. `supabase/20261102100000_revoke_public_core_table_access.sql`
6. `supabase/20261102110000_grant_service_role_core_reads.sql`

The security-controls migration adds fail-closed emergency-stop state, per-agent transfer/daily/weekly caps, recipient allowlists, persistent rate limiting, atomic agent provisioning and settlement audit, and mandatory administrator approval before provider submission. The submission-audit migration replaces the provider-submission RPC with an audited implementation and restricts `service_role` on both audit tables to SELECT and INSERT. The administrator-identity migration separates the admin audit identity from agent identities and blocks self-approval. The next migration reserves the `admin` agent identifier and intentionally aborts if that identifier is already occupied. Investigate the existing record and audit history rather than renaming or deleting it automatically. The fifth migration revokes direct table privileges on the core agent, budget and reservation tables from `PUBLIC`, `anon` and `authenticated`. The sixth explicitly grants the trusted `service_role` backend SELECT access to those tables for server-side dashboard reads; write operations remain behind privileged RPCs.

Older installations may also require the earlier multi-agent, request-ID, reconciliation, cleanup, admin-dashboard, security-event, privileged-RPC and atomic-submission scripts before the four V1 migrations above. Those scripts are:

- `supabase/multi-agent-v1-migration.sql`
- `supabase/outlayer-request-id-migration.sql`
- `supabase/reconcile-migration.sql`
- `supabase/multi-agent-v1-cleanup.sql`
- `supabase/20261101120000_admin_dashboard_controls.sql`
- `supabase/20261101140000_security_event_log.sql`
- `supabase/20261031221500_restrict_privileged_rpc_access.sql`
- `supabase/20261101090000_atomic_outlayer_submission.sql`

These earlier scripts are prerequisites only when their schema changes are absent. Establish the actual baseline before choosing an upgrade path. Do not apply the entire list blindly.

### Connected AgentGuard database: observed state on 2026-11-02

The connected Supabase project was inspected read-only. Its migration history contains these five entries:

- `20261031194550` — `add_agent_row_share_lock_to_reservation`
- `20261031221435` — `restrict_agentguard_privileged_rpc_access`
- `20261031232739` — `atomic_outlayer_submission`
- `20261031233841` — `admin_dashboard_controls`
- `20261031234140` — `security_event_log`

The core tables `agents`, `agent_budgets`, `spend_reservations`, `agentguard_admin_audit`, and `agentguard_security_events` exist, with RLS enabled. The V1 tables `agent_policies`, `agentguard_system_controls`, and `agentguard_rate_windows` were absent at the time of inspection. Therefore this database must not be described as having completed the V1 security-controls upgrade.

The audit-table privilege inspection also found that `service_role` still had UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER privileges on `agentguard_admin_audit` and `agentguard_security_events`. No append-only triggers were found on those tables. This does not match the intended restrictions in `20261101230000_submission_audit_and_append_only.sql`, which has not yet been applied to this database. Treat the audit tables as mutable in this connected environment until that migration is safely applied and verified.

### Original production database: observed state before V1 upgrade (2026-11-02)

The original production Supabase project was inspected read-only before the test environment was created. Its migration history contained the five entries listed above; the V1 tables `agent_policies`, `agentguard_system_controls`, and `agentguard_rate_windows` were absent, and the audit-table append-only restrictions had not yet been applied. No production migration or schema mutation was performed during the test-environment work. Re-inspect production before planning any future upgrade; do not infer its current state from this historical snapshot.

### Isolated Preview test environment: verified state (2026-11-02)

The Vercel `agentguard/build-v1` Preview has branch-specific testnet settings: `AGENTGUARD_NETWORK=testnet`, `OUTLAYER_BASE_URL=https://testnet-api.outlayer.ai`, and `NEAR_RPC_URL=https://rpc.testnet.near.org`. It also has branch-specific `SUPABASE_URL` and `AGENTGUARD_SUPABASE_SERVICE_ROLE_KEY` values pointing to the dedicated Supabase project `AgentGuard Test` (`rrvrlvitjithqizwutfl`, `eu-west-3`). The shared Production Supabase variables were left unchanged.

The test project was initialized from `supabase/setup.sql` and brought forward with all six V1 migrations listed above. Verification confirmed that `anon` and `authenticated` have no direct SELECT privileges on the core agent, budget and reservation tables, while `service_role` retains the SELECT access required by the backend. CI has passed the API security/lifecycle, upgrade migration, and PostgreSQL concurrency workflows on the commits recorded in the project handoff; the latest commit must still pass its own CI checks.

The Preview health endpoint now confirms Supabase connectivity, the default budget, and NEAR testnet RPC connectivity. The authenticated OutLayer address endpoint returns an executor account ID in 64-character lowercase hexadecimal form. The configured Preview `OUTLAYER_NEAR_ADDRESS` must match that exact executor ID, not a named bound asset account. No live transfer has been sent and no end-to-end transfer/finality test has yet been completed.

This is a verified test-environment snapshot, not a guarantee that later environment edits remain deployed. Re-check the branch-specific Preview settings and test database before running state-mutating tests. Never apply Preview migrations to Production.
 
### Isolated Preview environment: current handoff (2026-11-03)

This section supersedes the earlier test-agent and transfer-state snapshots above. The earlier entries are retained only as historical records; do not use them as current operational instructions.

- Preview uses the dedicated Supabase project `AgentGuard Test` (`rrvrlvitjithqizwutfl`). Production Supabase and Production Vercel have not been intentionally modified during this work.
- The isolated database contains the current multi-agent, security-control, treasury allocation and recipient-registry schema. The allocation migrations and recipient-registry migration have been applied to this test project.
- Test agents `test-agent-alpha` and `test-agent-beta` exist. Do not recreate them or reset their credentials without checking current state.
- Shared treasury ceiling is 5 NEAR. Alpha previously completed a 0.001 NEAR testnet transfer to `lensherr.testnet`; its transaction hash is `7oQL5u2Thnp895SVEqzEV574BJYZZXDY1YRxTfjK1aGM`. This is a historical transaction record, not authorization for another transfer.
- Beta's allocation was set to 0.001 NEAR for the controlled allocation tests. An authorized-recipient request was submitted, revoked while pending, correctly blocked at approval, then rejected by the administrator. The recipient was subsequently re-authorized. Re-check live state before relying on its current status.
- Verified live Preview behaviour: an unlisted recipient was blocked with `recipient_not_authorized`; an authorized Beta request entered `awaiting_approval` and reserved both treasury and agent allocation; revocation prevented its approval; administrator rejection was recorded; a 0.02 NEAR request against Beta's 0.001 NEAR allocation was blocked with `agent_allocation_exceeded` and created no reservation.
- A prior 0.001 NEAR transfer from Alpha was independently reconciled to NEAR FINAL and recorded as executed. Do not confuse this with Beta's approval/rejection test.
- The Vercel Preview branch has been used for authenticated UI testing. Verify the current deployment SHA and health before any further live test. No new transfer should be initiated without explicit user approval.

#### Verified allocation and reservation invariants

The migration `20261103010000_enforce_agent_allocations.sql` applies treasury-first, allocation-second, reservation-third row locking to money-moving RPCs. New reservations atomically reserve against both ledgers. Approval revalidates current authorization without changing exposure. Rejection and safe expired cancellation release both reservations once. Provider submission and `needs_review` retain exposure. NEAR FINAL success/failure settlement updates the counters with the terminal state.

The corrected disposable PostgreSQL concurrency workflow passed on commit `bb1a82a67fe20171155fb4c8ba73f0f8ea1c2350` (run [41599131269](https://github.com/BigWave45/agentguard/actions/runs/41599131269)). Its isolated race gave two agents 3 NEAR allocation each against a 5 NEAR treasury, submitted both reservations concurrently, verified exactly one 3 NEAR reservation and one `total_budget_exceeded` block, and verified cleanup released the winning reservation. The normal CI workflow for the same commit also passed (run [41599131195](https://github.com/BigWave45/agentguard/actions/runs/41599131195)).

These checks establish the shared-treasury race and CI suite on that commit. They do not establish production readiness, mainnet readiness, policy versioning, autonomous execution or native-contract enforcement.

#### Next safe verification

1. Re-check current Preview deployment SHA and health.
2. Read the current isolated database state before changing allocations, recipients, or transfer controls.
3. Verify final settlement, safe cancellation and ambiguous provider submission against both treasury and agent ledgers using disposable tests.
4. Keep Production untouched. Do not repeat the live transfer without explicit authorization.

## Authentication and agents

All agent endpoints use bearer authentication:

```http
Authorization: Bearer <agent-token>
```

The primary agent credential is `AGENTGUARD_AGENT_TOKEN`. It authenticates the primary agent for agent endpoints and does not grant administrator privileges. Configure a separate high-entropy `AGENTGUARD_ADMIN_TOKEN` for the dashboard, budget changes, agent provisioning, credential rotation and agent activation controls. The administrator credential is not accepted by agent transfer endpoints. Do not give it to autonomous agents.

### Create an agent

```http
POST /api/agent/agents
Content-Type: application/json
Authorization: Bearer <admin-token>
```

Body:

```json
{
  "id": "research-agent",
  "name": "Research Agent"
}
```

The API returns a generated bearer token once. The database stores only its SHA-256 hash. Save the returned token securely; it cannot be retrieved later.

### Rotate an agent credential

```http
POST /api/agent/agents/rotate
Content-Type: application/json
Authorization: Bearer <admin-token>
```

Body:

```json
{
  "id": "research-agent"
}
```

Rotation immediately invalidates the previous token and returns a replacement once. Update the agent's secret store before it makes another request.

Additional agents use their own tokens for balance, transfer, provider-status, and reconciliation endpoints. The agent identity is derived from the bearer token; clients cannot choose their identity in a transfer request. All active agents share the same default budget.

## API

### Health

`GET /api/health`

Read-only configuration and connectivity check. It does not initiate a transfer.

### Read the OutLayer wallet balance

`GET /api/agent/balance`

Requires any active agent credential. Returns the configured OutLayer wallet's NEAR balance response.

### Request a transfer

`POST /api/agent/transfer`

Body:

```json
{
  "requestId": "research-job-000001",
  "to": "recipient.testnet",
  "amountYocto": "100000000000000000000000"
}
```

- `requestId` must be a stable unique identifier for the intended payment and at least 8 characters long.
- `to` is the NEAR recipient account.
- `amountYocto` is a positive integer string in yoctoNEAR. Do not send a floating-point NEAR amount.
- Reuse the same request ID only when retrying the same logical request with the same agent, recipient, and amount.
- A repeated request does not call OutLayer again. Reusing the key with different request details is rejected.
- The request is checked against the global emergency stop, per-agent limits, recipient allowlist, rolling spend windows and shared budget in one database transaction.
- The reservation enters `awaiting_approval` and reserves budget for 15 minutes. Agent requests never call OutLayer directly.
- An administrator must approve the exact recipient and amount. Approval is single-use and consumes the submission claim immediately before the OutLayer call. Rejected requests release their reservations. An expired, never-approved request can be cancelled by an administrator; an approved or ambiguously submitted request remains held.

Current V1 behavior:

- `202 awaiting_approval`: the transfer is reserved and waiting for administrator review. No provider call has been made.
- `202 needs_review`: the administrator approved and submitted the transfer, but the provider response is not final settlement. The reservation remains held while the transaction is reconciled against NEAR finality.
- `403 blocked`: a per-transfer, agent policy, recipient, or shared-budget rule rejected the request.
- `429`: the agent transfer request rate limit was exceeded.
- `403 blocked`: the emergency stop or a spending policy prevents reservation. An approval blocked by the emergency stop returns `409` and remains pending.
- `409`: replay or idempotency conflict; do not create a new request ID just to bypass an unresolved payment.
- `401/503`: authentication or service availability issue.

The current transfer handler does not return a successful settled-payment response directly. A provider response and transaction hash still require the separate reconciliation step.

Rate limits use the shared PostgreSQL counter: agent transfer preparation is limited to 20 requests per agent per minute; admin mutations are limited to 20 per action per minute, with budget, emergency-stop, provisioning, credential-rotation, and reservation-resolution actions limited to 10 per minute. These application limits are not DDoS protection.

### Check provider status

`POST /api/agent/provider-status`

Body:

```json
{
  "requestId": "research-job-000001"
}
```

This checks an OutLayer request when a provider request ID was saved. Provider status is informational; it does not settle the budget. If a transaction hash is recovered, use the reconciliation endpoint next.

### Reconcile against NEAR finality

`POST /api/agent/reconcile`

Body:

```json
{
  "requestId": "research-job-000001"
}
```

AgentGuard queries NEAR testnet RPC for final execution and verifies the signer, recipient, and exact single transfer action against the reservation. Only a matching FINAL transaction can settle the reservation as executed or failed.

A pending transaction, unavailable RPC, missing hash, or transaction mismatch leaves the reservation held for review. The route does not retry the transfer.

### Admin dashboard

The homepage dashboard requires the separate administrator credential. It displays the shared budget, registered agents, transfer emergency stop, per-agent policy controls, pending approvals, and reservation history. Recipient policies distinguish an unrestricted `NULL` allowlist from an explicit empty allowlist that blocks every recipient. The aged/ambiguous filter highlights old `needs_review` records and reserved records with no provider references. For saved provider request IDs, the admin can request provider status; for transaction hashes, the admin can trigger NEAR finality reconciliation. These checks do not initiate or retry a transfer. The admin can cancel an expired request only while it remains unapproved and has no provider references. A submitted transfer can be manually resolved as failed only after the server verifies a matching NEAR `FINAL` failure, with a reason and evidence reference recorded in the audit log.

The admin reservation-resolution endpoint is:

`POST /api/admin/reservations/resolve`

It accepts either `{ action: "cancel_expired", requestId, reason }` or `{ action: "failed_final", requestId, reason, evidenceReference }`. The first path is restricted to expired, never-approved reservations with no provider references. The second independently queries NEAR for FINAL status and checks the saved signer, recipient, and amount before releasing a failed transfer. An ambiguous result remains held.

The dashboard data endpoint is:

`GET /api/admin/dashboard`

It is admin-only and returns the shared budget, agents, and latest 20 reservations, including saved provider request IDs.

## Safety and recovery behavior

- The shared budget row is locked during reservation, serialising competing agents' budget checks.
- The reservation is committed before the OutLayer call.
- An idempotency replay cannot initiate a second provider call.
- A provider response or transaction hash alone does not settle the budget.
- Ambiguous timeouts remain reserved because the provider may have accepted the transfer.
- There is no automatic transfer retry.
- Only the separate administrator credential can provision or rotate agent credentials, change the shared budget, change agent status or policy, toggle the emergency stop, approve/reject transfers, or read the admin dashboard.
- Non-admin agents can access or reconcile only their own reservations.

A reservation that has no provider request ID or transaction hash may require manual investigation. It stays held; do not release it or submit a replacement payment while the outcome is ambiguous. The emergency stop blocks new reservations and unclaimed approval/submission actions, but it cannot recall a provider request already submitted or in flight.

## Local development

Install dependencies and run the development server:

```bash
npm install
npm run dev
```

Run static linting:

```bash
npm run lint
```

Create a local `.env.local` with the required environment variables. Do not commit that file.

## Isolated reservation concurrency test

The repository includes a backend test that sends two simultaneous 3 NEAR calls to the real `reserve_agent_spend` RPC. With a dedicated disposable database seeded with the standard 5 NEAR budget and two active agents, exactly one request must reserve 3 NEAR and the other must be blocked. It also checks the persisted ledger, same-payload replay, changed-payload idempotency conflict, and restores the original budget snapshot.

**Never run this against the production AgentGuard database.** It temporarily writes reservation rows and budget counters. Use a dedicated disposable Supabase project with the same schema and seeded agents, no live app traffic, and a service-role key stored only in your local environment.

Run it with:

```bash
AGENTGUARD_TEST_DATABASE=true SUPABASE_URL="https://YOUR-TEST-PROJECT.supabase.co" SUPABASE_SERVICE_ROLE_KEY="YOUR_TEST_SERVICE_ROLE_KEY" npm run test:reservation-concurrency
```

The script refuses to run without the explicit isolation flag and refuses a database that is not empty with a 5 NEAR budget, zero spent/reserved, and both agents active. It never calls the AgentGuard transfer route or OutLayer.

## Known V1 limitations

- Testnet only.
- One OutLayer wallet/provider configuration.
- One shared budget, rather than per-agent sub-budgets.
- A provider timeout before OutLayer returns a request ID or transaction hash still requires manual investigation.
- No automated transfer retries.
- CI covers mocked API and finality lifecycle behavior plus isolated PostgreSQL concurrency; it does not prove a live OutLayer transfer or a real NEAR testnet settlement.

A successful health check confirms service connectivity, not that a transfer lifecycle has been tested. A live transfer, concurrent budget test, replay test, and finality reconciliation test must be recorded separately before claiming end-to-end validation.


---

## Architecture decisions and engineering handoff (2026-11-03)

**This section is the latest project handoff and supersedes older status snapshots above where they conflict.** Historical deployment and database notes are retained for traceability; always verify live state before performing mutations.

### Product direction

AgentGuard is being designed as an application-level financial authorization layer for autonomous agents, paired with OutLayer's independent TEE wallet custody and owner-policy enforcement. The agent can request an action, but it must not hold the OutLayer execution credential or be able to bypass AgentGuard to spend from the configured wallet. OutLayer policy is a second enforcement boundary, not a missing capability that AgentGuard replaces.

The intended operating model is **policy-authorized autonomous execution**: an administrator authorizes a bounded spending policy once, and AgentGuard automatically executes transactions that satisfy it. Human approval is reserved for suspicious activity, policy exceptions and administrative changes. The current implementation still requires human approval for every transfer; automatic policy-authorized execution is a design decision and is **not implemented yet**.

OutLayer remains the execution provider in the current NEAR hackathon scope. OutLayer's TEE and wallet owner policy protect the custody/signing boundary. AgentGuard independently owns logical agent identity, per-agent policy and allocation, shared-budget reservation, request authorization, execution gating, attribution, application audit and finality-based accounting. These controls complement OutLayer's wallet-wide policy. Multi-provider support is a future extension, not part of the current hackathon implementation.

### Agreed architecture decisions

These are approved design decisions, not claims about existing implementation.

1. **Treasury-wide limit is mandatory.** All agents belonging to a treasury must share one authoritative global spending and exposure ceiling.
2. **Agents also receive individual allocations.** Each agent has its own allocated authority and policy. The sum of allocations and all commitments must remain within treasury limits. An agent's allocation is not extra money.
3. **Treasury limits take precedence.** A request that passes its agent-level policy but breaches a treasury-level limit must be rejected.
4. **New recipients require explicit administrator authorization.** Match exact NEAR account IDs, not display names. Agents cannot authorize their own recipients.
5. **Suspicious transactions are held for human review.** Hard policy violations are rejected automatically. Risk-based holds must have quotas, deduplication and escalation controls so an attacker cannot flood the review queue.
6. **Transaction-rate limits are configurable per agent through an explicit execution profile.** The system must also enforce a hard infrastructure/provider safety ceiling. A high-throughput profile does not grant a higher spending allowance.
7. **Treasury exposure includes spent funds plus funds committed to unresolved transactions.** Pending reservations cannot be treated as available funds.
8. **Emergency stop is treasury-wide.** It blocks new authorizations and any not-yet-submitted execution. It cannot recall a provider transaction already submitted or in flight.
9. **Policy changes are administrator-controlled and versioned.** Before provider submission, the execution path must verify that the authorization remains valid under the current policy and emergency-stop state.
10. **Provider credentials remain server-side.** Agent credentials never grant direct OutLayer access.

### Required authorization hierarchy

Apply restrictions from the highest level down. Lower levels must never override higher-level controls.

- **Treasury policy:** global budget, global exposure ceiling, aggregate spending windows, emergency stop and infrastructure-level limits.
- **Agent policy:** agent allocation, per-transfer cap, daily/weekly caps, active status and configured execution profile.
- **Transaction authorization:** exact recipient, amount, idempotency, velocity and risk evaluation.
- **Execution:** atomic reservation, provider submission, provider request tracking, NEAR finality verification and ledger settlement.

Expected decision outcomes:

- `ALLOW`: all deterministic policy checks pass; eligible for automatic execution once that mode is implemented.
- `HOLD`: suspicious or requires human review; funds remain reserved while the outcome is unresolved.
- `DENY`: hard policy violation; no provider submission.
- `FREEZE`: emergency or systemic threat; stop new execution at treasury level.

Provider timeout or uncertain submission is an execution/reconciliation state, not a policy approval or proof of failure. Do not release reserved funds or retry blindly while provider execution may have occurred.

### Interface direction

The existing dashboard should evolve in place; do not create a separate application. Organize the interface around the treasury and its agents.

1. **Treasury overview:** total treasury limit, allocated authority, spent, reserved/committed, available headroom, emergency-stop state and recent activity.
2. **Agent management:** agent identity/status, individual allocation, per-transfer and rolling limits, execution profile, recipient permissions and credential controls.
3. **Recipient management:** exact NEAR account ID, label, active/revoked state, authorizing administrator and optional expiry. Show pending transactions affected by a revocation.
4. **Transaction activity:** searchable transaction lifecycle with policy decision, reason, amount, recipient, agent, reservation, provider reference and finality state.
5. **Review queue:** suspicious transactions only, with the triggering signals, policy version, reservation exposure and explicit approve/reject actions. Avoid turning every ordinary payment into an approval task.
6. **Security and audit:** emergency stop, policy-change history, admin actions, risk events and reconciliation exceptions.

The overview should make four things immediately visible: how much authority exists, how much is committed or spent, which agents can use it, and what requires intervention. Preserve the current dashboard's clear admin-only boundary.

### Threat model and mandatory safeguards

Prioritize these attack surfaces because failure would invalidate AgentGuard's core security promise:

- **Provider bypass / credential compromise:** agents must not possess OutLayer credentials; only the trusted server can call the provider.
- **Concurrent overspending:** treasury and agent reservations must be atomic against shared authoritative records. Application-side read-then-write checks are insufficient.
- **Agent multiplication:** multiple agents must not multiply the treasury's total spending authority.
- **Payment splitting and slow-drip attacks:** enforce aggregate spend windows and velocity controls, not just per-transfer caps.
- **Recipient substitution:** bind recipient and amount to the reservation and provider submission; revalidate current recipient authorization before execution.
- **Replay and duplicate submission:** use idempotency and durable submission claims; never blindly retry ambiguous provider outcomes.
- **Policy-change races:** record policy version at authorization and revalidate pending authorizations before provider submission.
- **Review-queue denial of service:** cap pending review count/exposure, deduplicate repeated requests and define escalation. Do not expire/release a reservation until it is established that no provider execution occurred.
- **Admin compromise:** keep policy mutation admin-only, authenticate admin actions, and audit policy/recipient/limit changes.
- **Reconciliation manipulation:** verify exact signer, recipient, amount and NEAR finality before settling the ledger.
- **Availability attacks:** protect request paths, provider capacity and reconciliation workers with rate/queue controls.

Behavioural anomaly detection and reputation scoring are possible later enhancements. They must supplement deterministic controls, never replace hard limits or authorization. A valid identity or approved recipient does not prove that an agent's intent or the recipient is trustworthy.

### Current implementation status (2026-11-03)

This is the current implementation record. Earlier dated database snapshots above are historical and must not be treated as current state.

**Implemented in the branch and isolated Preview test environment**
- Separate agent bearer credentials and administrator authentication.
- Agent provisioning, activation/deactivation and credential rotation.
- Shared treasury ceiling and atomic per-agent allocation ledger.
- Atomic reservation across treasury and agent exposure.
- Per-agent transfer, daily and weekly caps.
- Exact recipient registry with administrator authorization, expiry and revocation.
- Revalidation of agent state, recipient authorization, emergency stop and allocation exposure during approval.
- Mandatory administrator approval before OutLayer submission.
- Request-ID idempotency and conflict protection.
- Safe rejection and expired unsubmitted-request cancellation.
- OutLayer submission tracking, signer identity verification and NEAR FINAL reconciliation.
- Admin dashboard controls for treasury limits, agent allocation, agent policies, recipient authorization, approvals, transaction history, emergency stop, audit and security events.
- Disposable PostgreSQL concurrency test for cross-agent treasury reservations.

**Verified live or automated**
- Controlled Alpha 0.001 NEAR testnet transfer reconciled to NEAR FINAL and recorded as executed. Transaction: `7oQL5u2Thnp895SVEqzEV574BJYZZXDY1YRxTfjK1aGM`.
- Live Preview blocks an unauthorized recipient with `recipient_not_authorized`.
- Live Preview blocks a request exceeding an agent's allocation with `agent_allocation_exceeded` and creates no reservation.
- Live Preview prevents approval after the recipient is revoked.
- Disposable PostgreSQL race test passed on commit `bb1a82a67fe20171155fb4c8ba73f0f8ea1c2350`: two concurrent 3 NEAR reservations against a 5 NEAR treasury produced exactly one reservation and one `total_budget_exceeded` denial; cleanup released the reservation. See [workflow run 41599131269](https://github.com/BigWave45/agentguard/actions/runs/41599131269).
- Normal CI passed on the same commit. See [workflow run 41599131195](https://github.com/BigWave45/agentguard/actions/runs/41599131195).

These results are scoped to the tested commit and isolated environment. Re-check current branch, Preview deployment and database before further mutations.

**Not implemented or not yet fully verified**
- Autonomous execution for deterministic ALLOW decisions. All current transfers still require administrator approval.
- Immutable policy versioning and policy-version binding on reservations.
- Risk-based HOLD scoring, review quotas, deduplication and escalation.
- Native NEAR treasury smart contract and native contract execution adapter.
- Alternative execution providers.
- Mainnet readiness, high-throughput claims or production security certification.
- Full adversarial verification of every approval/rejection/cancellation/finality race in the current branch.

### Execution architecture and provider independence

OutLayer remains the only implemented execution provider. AgentGuard's authorization layer is designed to remain independent of the provider: it authenticates the logical agent, evaluates AgentGuard policy, reserves treasury and agent exposure, binds the request to an exact recipient and amount, gates execution, records the outcome and reconciles NEAR finality. The OutLayer adapter submits the approved transfer. OutLayer independently applies its own wallet owner policy inside its TEE before signing. The current repository does not configure or verify that owner policy through code; this must be inspected and evidenced for the deployed Preview wallet. See [`docs/outlayer-v1-backlog.md`](docs/outlayer-v1-backlog.md).

The native backend specification is documented in [`docs/native-near-treasury-contract-design.md`](docs/native-near-treasury-contract-design.md). The next execution backend is planned as a **dedicated AgentGuard treasury contract on NEAR testnet**, not as a server-held unrestricted treasury key. The contract would hold its own treasury funds and enforce on-chain authorization for narrowly scoped spending calls. A restricted NEAR function-call access key may call only the contract's permitted methods; it must not have direct unrestricted transfer authority. The contract must independently validate caller authority, agent allocation, recipient, amount, nonce/replay protection and emergency pause.

This is an approved architectural direction, not implemented functionality. Before deployment, specify and test contract ownership, key rotation/recovery, deposit and withdrawal authority, asynchronous transfer promises/callbacks, pending/failed settlement, duplicate calls, contract upgrades and emergency recovery. Supabase remains the off-chain policy, workflow and audit store; the contract becomes the authoritative on-chain enforcement boundary for funds held by that contract. Reconciliation must compare contract state and NEAR FINAL outcomes with the off-chain ledger.

OutLayer should remain available as the existing adapter. Initially, each treasury should be assigned to one execution backend; do not let the same treasury spend through OutLayer and a native contract concurrently until cross-provider exposure accounting and duplicate-spend prevention are explicitly designed and tested.

### Dashboard information architecture

Keep the current dashboard and preserve its working controls. Reorganize the existing interface in place; do not replace it with a new application or remove useful controls.

1. **Overview:** treasury ceiling, total allocated, spent, reserved/committed, available headroom, emergency-stop state, recent activity and system status.
2. **Agents:** identity, active state, allocation, per-transfer/daily/weekly limits, recipient permissions, credential provisioning and rotation.
3. **Recipients:** exact NEAR account ID, label, expiry, active/revoked state, authorizing administrator and affected pending requests.
4. **Payments:** searchable/filterable transaction history, amount, recipient, agent, request ID, provider reference, reservation and finality status.
5. **Review queue:** pending approvals in the current manual-approval mode; later, risk-based HOLD cases. Do not hide the current approval control until autonomous execution and risk review are implemented.
6. **Security and audit:** emergency stop, admin actions, policy changes, security events and reconciliation exceptions.
7. **System health:** Supabase, NEAR RPC and configured execution-provider diagnostics.
8. **Developer tools:** balance lookup and reservation-only agent request testing, clearly separated from administrator payment controls.

The first UI pass has widened the single-page layout and added sticky in-page navigation to the existing controls. It preserves the current forms and API actions; it does not yet split the page into independent routes or tab panels. Continue the refactor incrementally without deleting actions. Keep the admin-only boundary. Controls must remain visible only where the authenticated administrator can use them. Clearly distinguish current OutLayer execution status from the future native-contract backend. Do not add UI switches for unimplemented policy versioning, risk scoring or provider selection.

### Next engineering sequence

1. Complete remaining lifecycle and adversarial tests for both ledgers: final success, final failure, safe expiry cancellation, rejection, ambiguous provider submission, replay, recipient revocation, emergency-stop races and exact-once counter changes.
2. Verify the current Preview deployment SHA, environment and database state. Do not rely on historical README snapshots for live state.
3. Specify the NEAR treasury contract's authority model, storage, methods, state transitions, event schema and asynchronous transfer settlement.
4. Build and test the contract in a disposable/local NEAR environment before deploying to testnet.
5. Implement a separate native-contract execution adapter behind the existing AgentGuard authorization boundary. Preserve the OutLayer adapter.
6. Reconcile contract events and NEAR FINAL transaction outcomes against the treasury and agent ledgers.
7. Reorganize the existing dashboard in place, preserving all current controls and clearly displaying the selected execution backend.
8. Run the full security suite and a controlled, low-value NEAR testnet transfer through the new contract only after explicit approval.

Production Supabase and Production Vercel remain out of scope unless the user explicitly authorizes changes. Do not merge the pull request or initiate another live transfer without authorization.


## Planned execution backends

The developer-facing AgentGuard payment API is intended to remain provider-neutral. An administrator configures the execution backend for each treasury; an agent requests a payment against an authorized treasury and cannot choose a different backend in the request.

Planned backend types are distinct:
- **OutLayer wallet:** current V1, using OutLayer custody and its native NEAR transfer endpoint.
- **Native NEAR contract:** planned dedicated contract treasury for on-chain enforcement of native NEAR spending.
- **NEAR Intents via OutLayer:** future extension using OutLayer's Intents endpoints and custody.
- **Direct NEAR Intents:** separate future signer/solver-relay integration. Deploying the native treasury contract does not automatically provide this capability.

The first native contract release is scoped to native NEAR transfers. NEP-141 tokens and NEAR Intents swaps/cross-chain transfers require separate adapters and lifecycle tests. See [native NEAR treasury design](docs/native-near-treasury-contract-design.md) and [OutLayer V1 backlog](docs/outlayer-v1-backlog.md).


## NEAR Intents and other NEAR payment infrastructure

OutLayer's Agent Custody product already documents NEAR Intents deposits, swaps, withdrawals, cross-chain transfers and limit orders. AgentGuard does not currently integrate those endpoints. OutLayer also documents that Intents-dependent endpoints are mainnet-only because testnet has no solvers. Our hackathon testnet flow therefore remains the existing native NEAR transfer route.

The planned native AgentGuard contract is narrower: native NEAR transfers first. It can be extended to call specific NEAR token or payment contracts through audited adapters, but it will not automatically support NEAR Intents or every NEAR payment protocol. Direct Intents signing and settlement require a separate integration and signer security model. See [native NEAR design](docs/native-near-treasury-contract-design.md) and [OutLayer V1 backlog](docs/outlayer-v1-backlog.md).
