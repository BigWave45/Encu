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

**Product boundary:** AgentGuard owns agent identity and authentication, policy evaluation, authorization, shared-budget reservation, idempotency, approval, attribution, audit, and finality-based ledger settlement. OutLayer submits approved transfers; it does not decide which agent may spend, how much it may spend, or whether a request is authorized. OutLayer is the only execution provider implemented in V1. Additional execution-provider adapters are a future extension point; multi-provider support is not part of the current NEAR hackathon scope.

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
 
### Live multi-agent test checkpoint (2026-11-03)

This section supersedes the earlier statement that the isolated Preview database had no test agents. It records the latest verified state and is the handoff point for the next engineering session.

- Preview deployment: `https://agentguard-iy27t3qjn-resonances-projects-13e560cd.vercel.app`, commit `0507d40213de4952d5aafa576737390b554bfa4a`. The deployment was READY and its health endpoint returned HTTP 200 on 2026-11-02.
- Health verification passed for the isolated Supabase project, NEAR testnet RPC, OutLayer API connectivity, and the configured OutLayer executor signer.
- The isolated Supabase project is `AgentGuard Test` (`rrvrlvitjithqizwutfl`, region `eu-west-3`). Do not use the original/production Supabase project for these tests.
- Current agent rows verified directly from the test database: `primary` (Primary Agent, active) and `test-agent-alpha` (AgentGuard Multi-Agent Alpha, active). `test-agent-beta` does not exist yet.
- Shared test budget remains 5 NEAR (`5000000000000000000000000` yoctoNEAR), spent = 0, reserved = 0.
- `agentguard_system_controls.transfers_enabled` is currently `false`. No test reservations exist. No OutLayer transfer has been submitted.
- The Preview admin dashboard and admin-control endpoints reject unauthenticated requests with `admin_required`, as expected. This only verifies that the admin gate is active; it does not verify the configured admin token.
- A previous attempt to provision the second test agent and change test policies via a multi-statement SQL tool call was interrupted. A fresh read-only query confirmed that none of those attempted changes took effect. Do not assume they succeeded.

#### Next test sequence

1. Obtain authenticated access to the Preview admin dashboard without exposing the administrator token in chat. Verify the dashboard loads and confirms the above state.
2. Provision `test-agent-beta` through `POST /api/agent/agents` (the application endpoint), then store each returned agent token securely. Tokens are shown only once. Do not create credentials by inserting guessed token hashes.
3. Set both test-agent policies to a 0.004 NEAR maximum transfer, 0.004 NEAR daily and weekly caps, and an allowlist containing only `lensherr.testnet`. Confirm these settings through the dashboard.
4. Enable transfers only in the isolated test environment so requests can reach the atomic reservation path. Keep every request unapproved while testing policy blocks, shared-budget contention, idempotent replay, and conflicting request IDs. The global emergency stop blocks reservation itself, so it cannot remain enabled during these reservation tests.
5. Reject pending requests and verify reservations are released. Then activate the emergency stop and verify that new requests and approval/submission attempts are blocked. Re-check the budget ledger and reservation states.
6. Re-enable transfers only for the final controlled test. Before approval, verify the exact destination, amount, testnet, executor identity, and available balance. The user has explicitly authorized one test transfer only: 0.001 NEAR from the configured OutLayer executor to `lensherr.testnet`. Submit it only through AgentGuard's authenticated request → reservation → admin approval → OutLayer → NEAR finality reconciliation path. Never send directly through OutLayer.
7. Verify the final NEAR transaction and AgentGuard settlement, then replay the same request ID and confirm no second provider submission occurs. Record the transaction hash, finality result, reservation state, and budget counters here.

**Credential/access blocker:** the administrator token is configured as a sensitive Preview environment variable and is not readable through the deployment configuration API. Do not retrieve or print it, and do not ask the user to paste it into chat. Until there is a safe authenticated way to submit admin requests, agent provisioning and policy configuration remain blocked. Do not bypass the application authorization layer with direct provider calls.

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
