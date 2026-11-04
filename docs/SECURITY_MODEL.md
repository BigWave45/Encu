# Encu Security Model

**Status:** documentation of the current OutLayer-backed NEAR Testnet V1. This is an implementation description, not an independent security audit or a claim of mainnet readiness.

## Security objective

Allow independently authenticated AI agents to request native NEAR transfers while limiting the authority of each logical agent and the aggregate exposure of the shared treasury. The system must reject unauthorized requests before execution, reserve exposure before calling the provider, prevent duplicate provider submissions on replay, and settle the off-chain ledger only after the corresponding transaction is verified at NEAR finality.

## Assets and security objectives

| Asset | Security objective |
|---|---|
| Shared Testnet treasury authority | Keep aggregate spent + reserved exposure within the configured ceiling |
| Per-agent allocation | Prevent one logical agent from consuming another agent's allocation |
| Agent bearer credentials | Authenticate one logical agent; do not expose the OutLayer API credential |
| Recipient registry | Permit transfers only to exact authorized NEAR account IDs |
| Policy configuration | Restrict who can change limits, allocations, recipients and emergency state |
| Reservation and transaction records | Preserve attributable, replay-resistant accounting |
| Provider credential | Keep OutLayer API access server-side |
| Finality evidence | Settle only when the NEAR transaction matches the reserved transfer |

## Actors and trust boundaries

- **Agent runtime:** holds an agent-scoped bearer credential and submits a request. It is not trusted to declare its own identity, allocation, recipient authorization or policy result.
- **Encu API:** authenticates the bearer credential, validates the request, applies rate limiting and coordinates policy reservation and provider execution.
- **Supabase/PostgreSQL:** stores agent identity mappings, policy, allocations, shared treasury budget, reservations, audit records and security events. Atomic database functions enforce exposure and lifecycle invariants.
- **Administrator:** configures policy, agent allocations, recipient authorization and platform emergency controls. Administrative authority is separate from an agent credential.
- **OutLayer:** the configured Testnet custody/signing and transfer-submission provider. The server-side API credential is shared by logical agents in V1.
- **NEAR RPC:** supplies transaction and finality evidence used by Encu to reconcile the submitted transfer.

The application-level agent identity is not an independent OutLayer principal. OutLayer's wallet policy is a separate wallet-level control and does not replace Encu's per-agent allocation ledger.

## Request authorization path

1. Authenticate the agent bearer token against the stored agent identity.
2. Validate the request schema: stable `requestId`, exact recipient account ID and positive integer-string `amountYocto`. If supplied, `expectedAgentId` must match the authenticated identity.
3. Apply the persistent per-agent request rate limit.
4. Verify that the execution provider is configured before reserving funds.
5. Enforce the configured hard per-transfer cap.
6. Call the atomic reservation function with the request ID, amount, recipient and authenticated agent ID.
7. The database evaluates current agent status, recipient authorization, per-agent policy, rolling limits, autonomous allowance, allocation exposure, shared treasury exposure and emergency state.
8. Only a newly created reservation that is authorized for autonomous execution may proceed to the provider. Replays do not create a second provider submission.
9. Revalidate the execution account and claim the provider submission against current policy/recipient state.
10. Submit through the configured OutLayer adapter.
11. Preserve uncertain outcomes as `needs_review`; do not release exposure or blindly retry an ambiguous provider call.
12. Reconcile the resulting transaction against NEAR finality and settle the reservation only when the on-chain transaction matches the expected signer, recipient, single native transfer action and exact yocto amount.

Requests that exceed the configured autonomous allowance can enter the administrator approval workflow. A `needs_review` state is a reconciliation/operator-review state; it is not synonymous with a human approval request.

## Accounting invariants

- Treasury exposure is spent + reserved and must remain within the global treasury ceiling.
- Agent exposure is spent + reserved and must remain within that agent's allocation.
- A reservation is created before provider submission.
- A reservation is settled at most once.
- Identical request replay must not create another reservation or provider attempt.
- Reusing a request ID with a changed payload is an idempotency conflict.
- A transfer is not considered successful merely because the provider accepted the request or returned a request ID.
- Unknown provider outcomes remain reserved for reconciliation rather than being optimistically released.
- Exposure paths use the lock order: treasury row → allocation row → reservation row.

## Enforcement layers

### Encu application policy

Encu enforces logical-agent identity, per-agent allocation, per-transfer and rolling spend limits, exact recipient authorization, autonomous allowance, shared treasury ceiling, emergency stop, rate limiting, replay protection, audit and NEAR finality reconciliation.

### OutLayer wallet policy

OutLayer has its own wallet-level policy and TEE signing controls. The current integration calls the wallet address and transfer endpoints. It does not create, read back or continuously verify every OutLayer owner-policy setting. Do not claim that the provider currently enforces Encu's per-agent allocations. Do not claim that Encu independently verifies a transfer-bound TEE attestation; the current integration does not implement that verification path.

### NEAR finality

Encu independently checks the transaction evidence against the reserved transfer. Provider acceptance, provider request status, transaction hash availability and NEAR FINAL are distinct lifecycle facts.

## Threats and mitigations

| Threat | Mitigation in V1 | Remaining caveat |
|---|---|---|
| Agent forges another agent's identity | Bearer-token lookup establishes identity; optional `expectedAgentId` assertion must match | Compromise of an agent token still grants that agent's configured authority |
| Agent exceeds its allocation | Atomic allocation reservation and exposure checks | Depends on correct database permissions and migrations |
| Concurrent agents overspend shared budget | Atomic shared-treasury reservation with serialized exposure checks | Automated concurrency test uses a disposable database fixture |
| Agent sends to an arbitrary account | Exact recipient authorization check | Administrator credential compromise can change policy |
| Replayed request duplicates a payment | Stable request ID, idempotency conflict detection and provider submission claim | Ambiguous provider outcomes require reconciliation, not blind retry |
| Policy changes after initial reservation | Submission claim revalidates relevant current policy and recipient state | Live concurrency races still require continued verification |
| Provider timeout hides submission result | Keep reservation in `needs_review`; provider status and NEAR reconciliation paths | Live OutLayer response semantics are not fully evidenced |
| Malicious or incorrect transaction hash | Verify final transaction signer, recipient, action count and exact amount | Depends on trusted NEAR RPC/finality source |
| Credential leakage | Agent and provider credentials are separate; newly issued agent token is held in page memory and cleared on null auth state | Server environment and administrator credential handling remain operator responsibilities |
| Excessive request volume | Persistent per-agent rate limit | Rate-limit store availability is a dependency; fail closed when unavailable |

## Evidence classification

The repository includes:
- Agent API security/lifecycle tests using local mock services.
- NEAR finality reconciliation tests using mocked RPC and provider responses.
- Reservation concurrency tests against a dedicated disposable Supabase/PostgreSQL project.
- Prior manual Testnet observations recorded in the repository's OutLayer V1 backlog.

Mocked tests establish behavior under their fixtures. They do not prove live OutLayer approval/hold semantics, current Supabase counters, production security or all concurrency behavior in the hosted environment. A previous low-value Testnet transfer was observed reaching NEAR FINAL and reconciling as executed; that historical result is not evidence that the current merged deployment has passed a fresh end-to-end test.

## Explicit limitations

- NEAR Testnet only.
- One configured OutLayer wallet and server-side API credential shared across logical agents.
- No independent customer custody, isolated customer treasury or customer wallet provisioning.
- No native NEAR treasury contract is implemented.
- No additional execution provider is implemented.
- No transfer-bound TEE attestation verification is implemented in Encu.
- No mainnet readiness, formal audit or production security certification is claimed.

Report a vulnerability privately to the project maintainers. Do not publish working exploit details or real credentials in issues or demo material.
