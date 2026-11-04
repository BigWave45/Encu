# Encu Architecture

This document describes the implemented V1 architecture. It distinguishes application-level controls from the custody and signing functions supplied by OutLayer.

## 1. System context

```mermaid
flowchart LR
    subgraph External["External actors and services"]
      DEV["Developer workspace user"]
      AG["Agent runtime"]
      OL["OutLayer Testnet wallet"]
      RPC["NEAR Testnet RPC"]
    end
    subgraph ENCU["Encu application boundary"]
      AUTH["Supabase Auth + developer API"]
      API["Transfer API"]
      POLICY["Policy evaluation"]
      LEDGER["Reservation and accounting"]
      RECON["Reconciliation API"]
      AUDIT["Audit and security events"]
    end
    DB[("Supabase / PostgreSQL")]
    DEV -->|"Developer session"| AUTH
    AUTH -->|"Owned logical agents + policy"| DB
    AG -->|"Agent bearer token + transfer request"| API
    API --> POLICY
    POLICY <--> LEDGER
    POLICY <--> DB
    LEDGER <--> DB
    API --> AUDIT
    AUDIT --> DB
    LEDGER -->|"Authorized submission"| OL
    OL -->|"Transaction hash / provider reference"| AG
    AG -->|"Separate reconcile request + request ID"| RECON
    RECON <--> RPC
    RECON -->|"Verified FINAL evidence"| LEDGER
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| Developer workspace | Supabase Auth signup/sign-in; provisions and manages developer-owned logical agents, allocations, policies and recipient permissions. |
| Agent runtime | Requests a payment using its agent-scoped bearer credential. The credential, not request-body data, establishes the logical agent identity. |
| Transfer API | Validates request shape, authenticates the agent, applies rate limits and coordinates policy reservation and provider submission. |
| Policy and reservation logic | Evaluates agent and treasury authority, recipient permission, emergency state, idempotency and autonomous allowance. |
| PostgreSQL | Persists developer ownership, policies, allocations, treasury exposure, reservations, audit and security events. Atomic database functions protect exposure invariants. |
| OutLayer | Supplies the configured Testnet wallet custody, signing and transaction-submission path shared by logical agents in V1. |
| Reconciliation API and NEAR RPC | A separate reconciliation request queries NEAR transaction evidence and verifies finality and transfer details before ledger settlement. |

## 2. Authorization and execution sequence

The transfer endpoint and reconciliation endpoint are separate requests. The first may submit through OutLayer and return a `needs_review` lifecycle state with a transaction hash or provider request reference. The agent or operator then calls the reconciliation endpoint with the same request ID.

```mermaid
sequenceDiagram
    participant Agent as Agent runtime
    participant API as POST /api/agent/transfer
    participant DB as PostgreSQL
    participant OL as OutLayer
    participant Reconcile as POST /api/agent/reconcile
    participant RPC as NEAR Testnet RPC
    Agent->>API: Transfer request + agent bearer token
    API->>API: Authenticate, validate and rate-limit
    API->>DB: Atomic policy evaluation and reservation
    DB->>DB: Check allocation, treasury, recipient, limits, stop and replay
    DB-->>API: Denied, awaiting approval, or authorized reservation
    alt Denied
        API-->>Agent: 403 policy denial
    else Awaiting approval / replay
        API-->>Agent: 409 with lifecycle status; no new provider submission
    else Authorized
        API->>DB: Revalidate policy and claim submission
        DB-->>API: Submission claim granted
        API->>OL: Submit native NEAR transfer
        OL-->>API: Provider response / transaction reference
        API-->>Agent: 202 needs_review + request / provider reference
        Agent->>Reconcile: POST requestId + agent bearer token
        Reconcile->>DB: Load reserved transfer and provider reference
        Reconcile->>RPC: Query transaction with wait_until FINAL
        RPC-->>Reconcile: NEAR transaction evidence
        Reconcile->>Reconcile: Verify signer, receiver, single transfer action, amount and FINAL
        Reconcile->>DB: Settle reservation exactly once
        Reconcile-->>Agent: executed / failed, or 202 needs_review
    end
```

A provider response is not proof of payment. The reconciliation endpoint may return a pending/review result while a transaction hash is unavailable or NEAR evidence cannot yet be verified. Settlement requires matching NEAR FINAL evidence.

## 3. Policy model

A transfer request is evaluated against several independent constraints:

- **Identity:** the bearer token resolves to one active logical agent. An optional `expectedAgentId` must match that authenticated identity.
- **Agent authority:** the agent's allocation, per-transfer cap, rolling limits and autonomous allowance.
- **Recipient authority:** the exact NEAR account ID must be authorized for that agent.
- **Treasury authority:** aggregate spent plus reserved exposure must remain within the global treasury ceiling.
- **Global controls:** emergency stop and persistent request rate limits.
- **Replay control:** request IDs bind a logical payment instruction. A changed payload under the same ID is rejected; an already processed or pending request does not trigger a second provider submission.

A newly created reservation is required before provider submission. Policy and recipient state are revalidated at the submission boundary to reduce time-of-check/time-of-use risk.

## 4. Accounting invariants and concurrency

The system tracks exposure as:

`treasury exposure = spent + reserved`

`agent exposure = spent + reserved`

The atomic reservation path must prevent concurrent agents from exceeding either the shared treasury ceiling or their individual allocations. Exposure paths use one consistent database lock order:

`treasury row → allocation row → reservation row`

A reservation is settled at most once. Unknown provider outcomes remain held for reconciliation; they are not optimistically released and must not be blindly resubmitted.

## 5. Trust boundaries and key handling

- Developer accounts authenticate through Supabase Auth. Developer session tokens authorize workspace operations; they are not agent payment credentials.
- Each logical agent has a separate bearer token. The developer workspace shows a newly issued token once; it must be stored in the agent runtime's server-side secret manager.
- The administrator credential controls platform-wide operations and must never be given to an agent.
- The Supabase service-role key and OutLayer API key remain server-side.
- Multiple logical agents share one configured OutLayer execution wallet and provider credential in V1. They do not have isolated custody or independent provider principals.
- OutLayer wallet-level policy is separate from Encu's application-level agent policy. The current integration does not manage or independently verify every provider-side policy setting.
- Encu does not currently verify a transfer-bound TEE attestation.

## 6. Implemented boundary

V1 supports native NEAR transfers on Testnet through OutLayer. Developers can have separate application accounts and own logical agent configurations, but those agents still share the configured OutLayer execution wallet. V1 does not implement independent customer custody, per-customer wallets, a native NEAR treasury contract, additional execution providers, mainnet execution or independent TEE attestation verification.

Automated API and reconciliation suites use mocks. They establish behavior under their fixtures, not live provider semantics. See [Security Model](SECURITY_MODEL.md) for the evidence classification and threat analysis.
