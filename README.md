# AgentGuard

AgentGuard is a transaction-control gateway for AI agents making NEAR testnet transfers through OutLayer. Multiple independently authenticated agents share one spending budget. AgentGuard reserves budget before calling the provider, attributes each reservation to the authenticated agent, blocks replayed requests, and reconciles submitted transfers against NEAR finality before settling the ledger.

## Current scope

- NEAR testnet native-token transfers through one configured OutLayer wallet.
- Multiple agents with separate bearer credentials and one shared budget.
- Atomic budget reservation in Supabase before a provider call.
- Request-ID idempotency and conflict detection.
- Per-agent reservation attribution.
- NEAR FINAL transaction reconciliation.
- Admin-only read dashboard and agent credential provisioning/rotation.

This is a testnet V1. It is not a custody provider, smart contract, marketplace, or multi-chain gateway. A transfer has not been confirmed merely because OutLayer accepted a request or returned a transaction hash.

## Architecture

```text
Agent
  -> AgentGuard API
  -> authenticated agent identity
  -> atomic shared-budget reservation (Supabase)
  -> OutLayer transfer
  -> NEAR testnet
  -> NEAR FINAL reconciliation
  -> settled shared ledger
```

Supabase is the source of truth for the shared budget and reservation ledger. OutLayer is the configured transfer provider. NEAR RPC is used to independently verify final transaction execution.

## Environment variables

Configure these in the deployment environment:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase service-role key; never expose it to a browser |
| `OUTLAYER_BASE_URL` | OutLayer API base URL, for example the testnet API |
| `OUTLAYER_API_KEY` | OutLayer server-side API credential |\n| `OUTLAYER_NEAR_ADDRESS` | Exact NEAR account ID for the configured OutLayer testnet wallet; health verifies the provider-reported address matches |\n| `NEAR_RPC_URL` | Optional NEAR testnet RPC URL; defaults to `https://rpc.testnet.near.org` |\n| `OUTLAYER_NEAR_ADDRESS` | Exact NEAR account ID for the configured OutLayer testnet wallet; health verifies the provider-reported address matches |\n| `NEAR_RPC_URL` | Optional NEAR testnet RPC URL; defaults to `https://rpc.testnet.near.org` |
| `OUTLAYER_NEAR_ADDRESS` | Exact NEAR account ID of the configured OutLayer testnet wallet; must match the wallet address returned by OutLayer |
| `NEAR_RPC_URL` | Optional NEAR testnet RPC URL; defaults to `https://rpc.testnet.near.org` and production deployments are restricted to that host |
| `AGENTGUARD_AGENT_TOKEN` | Primary agent and administrator bearer credential |
| `AGENTGUARD_MAX_TRANSFER_YOCTO` | Maximum amount allowed in one transfer, in yoctoNEAR |

`OUTLAYER_NEAR_ADDRESS` is mandatory. Health checks compare it with the wallet account ID returned by OutLayer, and reconciliation uses this configured value as the expected transaction signer. A mismatch makes health return 503 and prevents reconciliation.

Never commit real credentials or send them in issue reports, screenshots, or chat messages. Rotate any credential that may have been exposed.

## Database setup

### Fresh Supabase project

Run `supabase/setup.sql` once in the Supabase SQL Editor. It creates the current multi-agent schema and RPC functions and seeds a shared default budget of 5 NEAR.

Do not run this fresh-install script on an existing database. It is not an upgrade migration and does not preserve or migrate an existing ledger.

### Existing AgentGuard database

Apply the upgrade scripts in this order, each once:

1. `supabase/multi-agent-v1-migration.sql`
2. `supabase/reconcile-migration.sql`
3. `supabase/multi-agent-v1-cleanup.sql`\n4. `supabase/20261031221500_restrict_privileged_rpc_access.sql` (already applied on the current AgentGuard project)\n5. `supabase/20261101090000_atomic_outlayer_submission.sql`\n4. `supabase/20261031221500_restrict_privileged_rpc_access.sql` (already applied on the current AgentGuard project)\n5. `supabase/20261101090000_atomic_outlayer_submission.sql`
4. `supabase/20261101090000_atomic_outlayer_submission.sql`

The multi-agent migration creates the agent table, attributes existing reservations to `primary`, and adds the four-argument reservation RPC. The reconciliation migration installs the settlement function used after chain verification. The cleanup script removes the legacy three-argument reservation function. The security migration restricts privileged RPCs and ledger tables to server-side service-role access. The final migration adds a service-role-only RPC that atomically stores the OutLayer request ID and transaction hash while marking the reservation `needs_review`; it never settles budget. The security migration restricts privileged RPCs and ledger tables to server-side service-role access. The final migration adds a service-role-only RPC that atomically stores the OutLayer request ID and transaction hash while marking the reservation `needs_review`; it never settles budget. The final migration adds a service-role-only RPC that atomically stores the OutLayer request ID and transaction hash while marking the reservation `needs_review`; it never settles budget.

Do not reset the database or rerun the fresh-install setup against a live project. Confirm the migration output and inspect the resulting tables/functions before deploying code that depends on them.

## Authentication and agents

All agent endpoints use bearer authentication:

```http
Authorization: Bearer <agent-token>
```

The primary credential is `AGENTGUARD_AGENT_TOKEN`. It authenticates the primary agent and grants administrator access to agent provisioning and the dashboard.

### Create an agent

```http
POST /api/agent/agents
Content-Type: application/json
Authorization: Bearer <primary-admin-token>
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
Authorization: Bearer <primary-admin-token>
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
- The request is first reserved against the shared budget. Only the request that creates the reservation is allowed to call OutLayer.

Current V1 behavior:

- `202 needs_review`: the provider response is not treated as final settlement. The reservation remains held while the transaction is reconciled against NEAR finality.
- `403 blocked`: the per-transfer or shared-budget limit rejected the request.
- `409`: replay or idempotency conflict; do not create a new request ID just to bypass an unresolved payment.
- `401/503`: authentication or service availability issue.

The current transfer handler does not return a successful settled-payment response directly. A provider response and transaction hash still require the separate reconciliation step.

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

The homepage dashboard requires the primary administrator credential. It displays the shared budget, registered agents, and latest 20 reservations. For pending reservations with a saved provider request ID, the admin can request the provider status. For reservations with a transaction hash, the admin can trigger NEAR finality reconciliation. These actions do not initiate or retry a transfer.

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
- Only the primary administrator can provision or rotate agent credentials and read the admin dashboard.
- Non-admin agents can access or reconcile only their own reservations.

A reservation that has no provider request ID or transaction hash may require manual investigation. Do not release it or submit a replacement payment until the original request's outcome has been established.

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
