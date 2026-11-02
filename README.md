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

`AGENTGUARD_NETWORK` defaults to `testnet`. Mainnet is supported by explicitly setting `AGENTGUARD_NETWORK=mainnet`, `OUTLAYER_BASE_URL=https://api.outlayer.ai`, and `NEAR_RPC_URL=https://rpc.mainnet.near.org`. The selected network must match the exact provider and RPC host allowlists. Local mock endpoints are accepted only outside production or in the explicit CI test harness. `OUTLAYER_NEAR_ADDRESS` is mandatory and must be the OutLayer executor account ID that signs native NEAR transfers. Health compares it with OutLayer’s reported executor account ID; reconciliation checks the same signer against chain transaction details.

Never commit real credentials or send them in issue reports, screenshots, or chat messages. Rotate any credential that may have been exposed.

## Database setup

For an existing database, apply the forward-only migrations in timestamp order after the legacy setup/migration sequence: `20261101190000_agentguard_v1_security_controls.sql`, `20261101230000_submission_audit_and_append_only.sql`, `20261102080000_admin_actor_self_approval_guard.sql`, then `20261102090000_reserve_admin_agent_id.sql`. The last migration reserves the `admin` identifier at the database layer. It intentionally aborts if an agent with that ID already exists; investigate that record and its audit history rather than renaming or deleting it automatically.



### Fresh Supabase project

Run `supabase/setup.sql` once in the Supabase SQL Editor. It creates the current multi-agent schema, privileged RPCs, and a shared default budget of 5 NEAR.

Do not run this fresh-install script on an existing database. It is not an upgrade migration and does not preserve or migrate an existing ledger.

### Existing AgentGuard database

For a database that has only the legacy setup and has not yet received the multi-agent/admin migrations, apply the upgrade scripts below in order, each once. Do not replay any step already present in that database's migration history or schema. The connected AgentGuard database has already received steps 1–8; its remaining V1 sequence is steps 9–12 only.

1. `supabase/multi-agent-v1-migration.sql`
2. `supabase/outlayer-request-id-migration.sql`
3. `supabase/reconcile-migration.sql`
4. `supabase/multi-agent-v1-cleanup.sql`
5. `supabase/20261101120000_admin_dashboard_controls.sql`
6. `supabase/20261101140000_security_event_log.sql`
7. `supabase/20261031221500_restrict_privileged_rpc_access.sql`
8. `supabase/20261101090000_atomic_outlayer_submission.sql`
9. `supabase/20261101190000_agentguard_v1_security_controls.sql`
10. `supabase/20261101230000_submission_audit_and_append_only.sql`
11. `supabase/20261102080000_admin_actor_self_approval_guard.sql`
12. `supabase/20261102090000_reserve_admin_agent_id.sql`

The multi-agent migration creates the agent table and attributes existing reservations to the primary agent. The request-ID migration adds the OutLayer provider request reference. The reconciliation migration installs the finality settlement function. The cleanup migration removes the legacy reservation function. The admin-dashboard migration creates the audit table and budget/agent control RPCs. The security-event migration creates the server-only security event log. The privileged-access migration restricts ledger RPCs and tables to server-side service-role access. The atomic-submission migration adds a service-role-only RPC that atomically persists the OutLayer request ID and transaction hash while keeping the reservation in `needs_review`; it does not settle or release budget. The V1 security-controls migration adds fail-closed emergency-stop state, per-agent transfer/daily/weekly caps, explicit recipient allowlists, persistent rate limiting, atomic agent provisioning and settlement audit, and mandatory 15-minute administrator approval before provider submission. It also adds safe cancellation for expired unapproved requests and evidence-checked resolution for matching NEAR FINAL failures. The admin-audit and security-event tables must exist before the atomic-submission and V1 security-controls migrations are applied. The forward-only submission-audit correction replaces the older provider-submission RPC with its audited implementation and restricts `service_role` to SELECT and INSERT on both audit tables; apply it after the V1 security-controls migration. The administrator-identity correction gives the administrator a distinct `admin` audit identity and makes the approval RPC reject an actor matching the requesting agent. The reserved-ID migration runs last and prevents any agent from claiming `admin`; it aborts if that ID already exists.

Do not run this sequence against the connected live database as part of development. The current database has not been upgraded to the full V1 schema in this work session. Do not reset it or rerun the fresh-install setup against a live project.

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
