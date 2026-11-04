# ENCU V1 Security Architecture

Status: implemented V1 architecture for the NEAR Testnet hackathon prototype.
Scope: native NEAR transfers requested by authenticated logical agents through the ENCU API.

This document describes the current implementation. It is not a claim of production readiness, independent customer custody, or a formal third-party security audit.

## 1. System boundary

ENCU is an application-level authorization and transaction-control layer. It sits between an AI agent and the configured execution provider:

1. An agent sends a native NEAR transfer request to ENCU with a stable request ID.
2. ENCU authenticates the agent and validates the request.
3. ENCU checks global and agent-level controls and reserves the amount in the database ledger.
4. ENCU revalidates the current policy and claims the right to submit.
5. The OutLayer adapter submits the transfer.
6. ENCU records provider references and independently reconciles the transaction against NEAR finality before settling the ledger.

The policy and ledger logic live in ENCU. OutLayer is the only implemented V1 execution provider. The provider interface is an initial seam for future adapters, not evidence that other providers are already supported.

## 2. Trust boundaries and credentials

- **Agent credential:** each logical agent authenticates with its own bearer credential. Stored agent credentials are looked up by SHA-256 hash. The primary agent credential is compared using a timing-safe equality check.
- **Administrator credential:** the admin bearer credential is separate from agent credentials. Agent authentication never grants administrator privileges.
- **Developer session:** developer workspace routes authenticate the developer's Supabase session and scope agent operations to agents owned by that developer. The developer audit endpoint returns events associated with that developer and their agents.
- **Execution-provider credential:** the OutLayer API credential is held server-side. It is shared by the configured V1 execution wallet and is never an agent credential.
- **Database:** privileged database access is performed server-side. Core tables and security-control tables use row-level security and restricted grants; application RPCs perform privileged ledger mutations.

Do not put agent tokens, administrator tokens, Supabase service credentials, or the OutLayer API credential in client-side code, public examples, screenshots, or logs.

## 3. Spending controls

V1 uses one operator-configured shared treasury budget. Multiple authenticated agents share that global ceiling, with independently enforced agent allocations inside it.

The database reservation path serializes changes using the treasury row, then the agent allocation row, then the reservation row. It accounts for committed spend and active reservations so concurrent requests cannot each spend the same remaining balance.

Controls include:

- Global treasury spending ceiling.
- Per-agent allocation, with new agents provisioned at zero allocation until configured.
- Global emergency stop, persisted in the database and checked during reservation and submission-claim paths.
- Global per-transfer ceiling configured by the server.
- Per-agent per-transfer, daily and weekly policy limits where configured.
- Per-agent autonomous-spend allowance.
- Exact NEAR recipient authorization, including expiry and revocation.
- Agent active/inactive status.

The database rechecks policy at the provider-submission claim. This matters because an agent can be deactivated, an allocation changed, or a recipient authorization revoked after the initial reservation but before submission.

A request blocked before provider submission is not sent to OutLayer. A transfer already submitted to the provider or already in flight cannot reliably be recalled by switching on the emergency stop or revoking a recipient.

## 4. Replay and concurrency protection

Each transfer includes a stable request ID. The database binds that ID to the authenticated agent, recipient and amount.

- Reusing a request ID with different transfer parameters is rejected as an idempotency conflict.
- Replaying an already-created reservation does not create a second provider submission.
- A separate database claim is required before the provider call.
- The submission claim is serialized against recipient revocation and revalidates the current policy.
- Reservations are made atomically against both the shared treasury and the agent allocation.

ENCU does not automatically retry ambiguous provider submissions. This avoids turning a timeout into a duplicate transfer.

## 5. Provider and settlement verification

Before submission, the OutLayer adapter reads the configured NEAR execution account and verifies that the returned account identifier matches the server-configured executor identifier.

The adapter then submits the native transfer through OutLayer. ENCU records the provider request ID and/or transaction hash when returned.

A provider response is not treated as final settlement. The reconciliation path checks the transaction against NEAR finality and verifies the expected transfer effect, including signer, recipient and amount, before the ledger is settled.

If the provider outcome is ambiguous, the reservation remains in a review state for investigation. A `needs_review` status means reconciliation or operator investigation is required; it does not mean a human approval queue has authorized the transfer. ENCU does not blindly retry an ambiguous submission.

## 6. Rate limits and security events

Transfer preparation is rate-limited per authenticated agent using a database-backed rate-limit store. The current transfer endpoint allows 20 preparation requests per 60-second window per agent. If the rate-limit store is unavailable, the endpoint fails closed. Rate-limit denials are recorded as security events.

The application records security events for authentication failures, invalid requests, rate-limit denials, policy blocks, replay rejection and transfer submission outcomes. Administrative and developer audit views expose scoped event history without exposing bearer credentials.

Application-level rate limiting is not a substitute for infrastructure-level DDoS protection.

## 7. Known limitations and threat boundaries

- V1 is a single-operator NEAR Testnet prototype.
- All logical agents use one configured OutLayer execution wallet and one server-side OutLayer API credential. Per-agent allocations are accounting and policy controls inside a shared treasury; they are not separate on-chain wallets or independently funded customer treasuries.
- V1 does not provide customer wallet provisioning, isolated developer custody, deposits, withdrawals, billing, or multi-tenant treasury segregation.
- OutLayer is the only implemented execution provider. The provider interface does not make another provider usable without a complete adapter and lifecycle verification.
- V1 is not mainnet-ready and is not represented as a production custody service.
- An emergency stop prevents new reservations and submission claims. It cannot cancel a transfer already submitted or an in-flight provider request.
- A timeout without a provider request ID or transaction hash can require manual investigation. ENCU does not automatically retry such requests.
- Automated CI tests cover application/API behavior, database concurrency and reconciliation logic. They do not prove a live OutLayer transfer or a real NEAR Testnet settlement.
- No formal independent penetration test or external security audit is claimed.

## 8. Evidence in the repository

Key implementation locations:

- Agent authentication: `lib/agent-auth.ts`
- Developer authentication and ownership checks: `lib/developer-auth.ts`, `lib/developer-agent-access.ts`
- Transfer authorization and provider lifecycle: `app/api/agent/transfer/route.ts`
- Provider boundary and OutLayer signer verification: `lib/execution-provider.ts`, `lib/outlayer.ts`
- Security event writes: `lib/security-audit.ts`
- Database security controls and policies: `supabase/20261101190000_agentguard_v1_security_controls.sql`
- Atomic treasury and allocation enforcement: `supabase/20261103010000_enforce_agent_allocations.sql`
- Recipient authorization and revocation: `supabase/20261103020000_agent_recipient_registry.sql`
- Developer-scoped audit feed: `app/api/developer/audit/route.ts`

The current release branch is `agentguard/build-v1`. Database migrations must be applied deliberately to the intended environment; this document does not authorize any production or live database change.
