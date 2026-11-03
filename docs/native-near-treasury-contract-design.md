# Native NEAR treasury contract design

Status: approved architecture direction; specification only. No contract code, key provisioning or testnet deployment is implemented by this document.

## 1. Objective

Add a native NEAR execution backend without weakening or replacing AgentGuard's existing authorization model and without making OutLayer a permanent dependency.

The native backend must enforce critical spending restrictions on-chain. Supabase and the AgentGuard API remain useful for administration, workflow, reporting and audit, but a compromised API must not be able to bypass the on-chain treasury's hard limits.

The first native implementation is a dedicated AgentGuard treasury account with a contract deployed to that account. The contract holds the NEAR balance and initiates native transfers. It is not a wrapper around an externally held full-access key.

## 2. Actors and key boundaries

### Treasury contract account

A dedicated account, for example `agentguard-treasury.testnet`, holds the contract and treasury funds. It is separate from the administrator's personal account and from OutLayer's wallet.

### Administrator/controller

A separately controlled administrator account is the contract's `controller_id`. It calls privileged contract methods to configure treasury limits, register/revoke agent public keys, set allocations, authorize/revoke recipients, pause/unpause and perform explicitly governed withdrawals or recovery.

The treasury account's full-access key is a critical custody boundary. It must not be stored in the AgentGuard application or handed to agents. Keep it under offline/hardware or threshold/multisig control. The contract cannot prevent the holder of the treasury account's full-access key from bypassing the contract with direct account actions. The deployment must therefore minimize and protect full-access authority.

### Agent function-call access keys

Each agent receives a distinct NEAR function-call access key on the treasury account. Its receiver is the treasury contract account and its method allowlist contains only the public spending entrypoint, initially `request_transfer`. It must not have `FullAccess` and must not be allowed to call arbitrary receivers.

The contract identifies the agent using the transaction's signer public key (`env::signer_account_pk()`) and maps that key to an agent record. Do not trust an `agent_id` supplied in method arguments. The function-call key can invoke only the contract, while the contract independently enforces agent allocation, recipient authorization, amount limits, pause and replay protection.

The restricted key's private key can be held by the agent runtime, or by a separate hardened signing service if the agent cannot safely manage keys. If a signing service is used, it must not expose a treasury full-access key. The restricted function-call key still limits the damage from a compromised signer.

AgentGuard bearer tokens and NEAR function-call keys are different credentials. The bearer token authenticates an agent to the off-chain API; the public key identifies the agent to the on-chain contract. Provisioning must bind them explicitly. Rotating a bearer token must not silently rotate or delete the NEAR key, and vice versa.

## 3. Trust model

The contract is the authoritative enforcement boundary for NEAR held in its treasury account. It must not rely on Supabase reads, API-side checks, OutLayer policy or user-supplied agent IDs to decide whether an on-chain transfer is allowed.

Supabase remains the off-chain operational ledger and audit store. The API can prepare transactions, observe contract events and reconcile state, but a direct contract call by an agent must face the same on-chain rules as a call relayed by the API.

OutLayer remains the existing execution adapter for treasuries explicitly assigned to OutLayer. A native-contract treasury is funded and spent from its own contract account. Do not allow one logical treasury to spend through both OutLayer and the native contract concurrently in the first release.

## 4. On-chain state

Minimum state:

- `controller_id`: account allowed to administer contract policy.
- `paused`: treasury-wide emergency stop.
- `treasury_limit_yocto`: maximum cumulative committed exposure.
- `treasury_spent_yocto` and `treasury_reserved_yocto`.
- Agent registry keyed by public key, with stable agent ID, active/revoked state, allocation limit, spent and reserved exposure, per-transfer limit and rolling spend-window policy.
- Recipient registry keyed by exact `(agent_id, account_id)`, with active state and optional expiry.
- Reservation registry keyed by globally unique request ID, binding agent ID, signer public key, recipient, amount, creation time, nonce and lifecycle status.
- Used request IDs/nonces retained long enough to prevent replay. Terminal request IDs must not become reusable through ordinary expiry or deletion.
- Versioned policy state or an explicit policy revision counter, so a reservation can record the policy revision under which it was authorized.

All monetary quantities are integer yoctoNEAR. Never use floating-point values.

## 5. Contract interface

Names are provisional; final ABI follows the selected Rust SDK and implementation.

### Controller methods

- `set_paused(paused)`
- `set_treasury_limit(limit_yocto)`
- `register_agent(agent_id, public_key, allocation_limit, policy)`
- `update_agent_policy(agent_id, ...)`
- `revoke_agent_key(public_key)`
- `set_agent_allocation(agent_id, allocation_limit)`
- `authorize_recipient(agent_id, account_id, expires_at)`
- `revoke_recipient(agent_id, account_id)`
- `approve_transfer(request_id)`: revalidate current policy, recipient, agent state, pause and exposure; mark the exact reservation approved/executing and initiate the NEAR transfer promise.
- `reject_transfer(request_id, reason)`: reject the pending request and release both reserved counters exactly once.
- `withdraw(to, amount, request_id)`, only if withdrawal authority and multisig/confirmation policy are explicitly designed. This is not an agent method.

For the first native release, every request requires controller approval, matching the current AgentGuard operating mode. Do not let `request_transfer` auto-submit a transfer. Autonomous ALLOW execution is a later mode that needs its own policy and tests.

Controller methods must check `predecessor_account_id == controller_id`. The controller account must be different from the treasury account's agent restricted-key identity. The implementation must not treat every call from the treasury account as an administrator call.

### Agent method

`request_transfer(request_id, recipient, amount_yocto, client_nonce)`

The method derives the agent from the signer public key. It rejects unknown/revoked keys, inactive agents, paused treasury, unauthorized/expired recipients, invalid amount, per-transfer violations, agent allocation exhaustion, treasury exposure exhaustion and reused request IDs/nonces.

The contract reserves treasury and agent exposure in the same receipt and creates an `awaiting_approval` request. It does **not** initiate a transfer promise. The controller's separate `approve_transfer(request_id)` method revalidates current policy and recipient authorization, confirms the request is still pending and the treasury is not paused, then marks it executing and creates the transfer promise. Rejection releases both reservations exactly once. Because NEAR serializes state changes through receipts, concurrent requests are checked against the latest committed contract state. The second request cannot rely on a stale off-chain budget read.

## 6. Transfer lifecycle and asynchronous settlement

A native NEAR transfer initiated by a contract is asynchronous. Returning successfully from `request_transfer` means the request was accepted and the transfer promise was scheduled; it does not mean the recipient has received funds.

Required lifecycle:

1. Agent submits `request_transfer`; validate signer, agent, policy, recipient, pause, nonce and available contract balance.
2. Check `spent + reserved + amount <= treasury_limit` and the equivalent agent allocation constraint.
3. Persist `awaiting_approval` and increment both reserved counters. No transfer is submitted yet.
4. Controller calls `approve_transfer(request_id)`. Revalidate current agent status, policy revision, recipient authorization/expiry, pause state, request status and reservation amounts.
5. If valid, mark executing and initiate `Promise::new(recipient).transfer(amount)`.
6. Attach a private callback on the treasury contract with enough prepaid gas.
7. In the callback, verify it is a private self-call and inspect the promise result.
8. On successful transfer receipt, decrement both reserved counters, increment both spent counters and mark the reservation executed.
9. On final failed transfer promise, decrement both reserved counters and mark it failed with a durable failure reason.
10. Controller rejection releases both reserved counters exactly once. Expired cancellation is allowed only with proof no approval or submission occurred.
11. Emit structured events for request accepted, approval/rejection, transfer outcome, policy changes and emergency state.

The callback must be idempotent. Duplicate callback attempts or replayed settlement calls must not change counters twice. A missing/failed callback must leave exposure reserved and create a recoverable pending state; never infer failure from a timeout and release funds optimistically.

The implementation must explicitly test the NEAR runtime's promise-result semantics and callback gas requirements. A successful scheduling receipt is not final transfer success.

## 7. Accounting and policy invariants

- Treasury exposure is `spent + reserved`; it must never exceed the treasury ceiling.
- Agent exposure is `spent + reserved`; it must never exceed that agent's allocation.
- Sum of agent allocation limits must not exceed the treasury limit.
- New agents start with zero allocation.
- Allocation cannot be lowered below current spent plus reserved exposure.
- Recipient matching uses exact NEAR account IDs; labels are never authorization inputs.
- Agent requests cannot modify agent policy, recipient registry, allocation, controller, pause or withdrawal authority.
- Policy updates increment a revision. Pending requests must be revalidated against the current revision before a transfer promise is created. If the contract schedules the transfer in the same receipt as validation, there is no off-chain approval gap; otherwise a separate execute method must revalidate before scheduling.
- Emergency pause blocks new requests and any pending-but-not-yet-scheduled execution. It cannot recall a transfer promise already scheduled.
- Replay protection is contract-enforced, not just an API idempotency key.
- The contract checks available account balance after reserving a storage/gas safety margin. A policy-approved request must still fail closed if the contract lacks spendable balance.

Rolling 24-hour and 7-day caps must preserve their documented semantics. A fixed calendar-day bucket is not an equivalent substitute for a rolling window. Choose and test a bounded on-chain event-window representation before claiming parity with the off-chain policy engine.

## 8. Key provisioning and revocation sequence

Provision:
1. Generate a unique agent keypair in the agent runtime or hardened signer.
2. Add a function-call access key to the treasury account, restricted to receiver = treasury contract and method = `request_transfer`.
3. Register the public key and agent policy in the contract.
4. Bind the public key to the agent's off-chain identity in AgentGuard.
5. Verify that an unregistered key, wrong receiver, wrong method and wrong agent identity cannot spend.

The key must have no direct transfer authority. If the access-key addition and contract registration are separate transactions, keep the key unusable until both steps are complete.

Revoke:
1. Mark the public key revoked in contract state first.
2. Confirm further calls are rejected.
3. Delete the function-call access key from the treasury account.
4. Record the on-chain transaction references and off-chain audit event.

Rotating a key provisions and verifies a replacement before revoking the old key, unless there is an emergency compromise. Emergency rotation revokes first and may temporarily suspend the agent.

## 9. Native execution adapter

Implement a separate adapter behind the existing AgentGuard execution boundary. The adapter must:
- Build the contract method call with a stable request ID and nonce.
- Sign only with the agent's restricted function-call key or an explicitly isolated signer service.
- Submit to the configured NEAR network.
- Record transaction hash and contract request reference.
- Treat submission as pending until the contract event/callback outcome is observed at NEAR FINAL.
- Reconcile contract reservation state and events against Supabase.
- Never release off-chain reservation merely because RPC/provider submission timed out.

The OutLayer adapter remains unchanged. A treasury is pinned to one backend. Backend migration requires a pause, full reconciliation, zero unresolved exposure, explicit treasury funding/withdrawal movement and administrator authorization.

## 10. Required tests before testnet funds

Contract unit/integration tests:
- Unregistered and revoked public keys.
- Function-call key wrong receiver/method and direct transfer attempt.
- Agent ID spoofing in method arguments.
- Unauthorized and expired recipient.
- Per-transfer and allocation limits.
- Aggregate treasury limit with two concurrent agents.
- Duplicate request ID and nonce.
- Policy update while a request is pending.
- Emergency pause before request and before scheduling.
- Transfer promise success and failure.
- Callback replay, callback failure and missing callback recovery.
- Insufficient spendable balance and storage reserve.
- Key rotation and emergency revocation.
- Controller authorization and attempted agent invocation of admin methods.
- Contract upgrade/owner recovery path.

Testnet gate:
- Deploy to a dedicated new testnet treasury account with no production value.
- Verify contract code hash and account identity.
- Fund only a deliberately small amount.
- Provision two restricted agent keys.
- Demonstrate allowed payment, unlisted-recipient denial, per-agent allocation denial, shared-treasury race, pause, replay denial and final settlement.
- Compare contract counters, NEAR FINAL transaction details and Supabase mirror.
- Do not migrate existing OutLayer funds or disable OutLayer until the native path passes all gates.

## 11. Implementation phases

1. Select Rust SDK/toolchain and create an isolated contract workspace.
2. Implement storage, controller authorization, agent-key registry, recipient registry and pause.
3. Implement reservation accounting and replay protection without transfers.
4. Test multi-agent concurrency and authorization failures.
5. Add asynchronous native transfer promise and idempotent callback settlement.
6. Build the native execution adapter and Supabase reconciliation.
7. Add dashboard read-only contract status, then administrative controls only when the on-chain methods exist.
8. Deploy and test on NEAR testnet with explicit authorization.

No mainnet deployment, unrestricted server-side treasury key, dual-provider spending from one treasury, or automatic withdrawal path is in scope for this first native backend.


## 12. Developer integration and backend selection

### Stable developer-facing interface

The developer should integrate with AgentGuard's payment API/SDK, not directly choose or call an execution provider for each request. A conceptual request is:

```json
{
  "request_id": "invoice-2026-0042",
  "treasury_id": "operations-treasury",
  "asset": { "network": "near", "standard": "native", "symbol": "NEAR" },
  "amount": "0.25",
  "destination": { "type": "near_account", "account_id": "vendor.near" },
  "purpose": "Invoice 0042"
}
```

The API authenticates the agent, resolves its treasury membership, evaluates policy and reserves exposure before selecting the configured adapter. The caller must not be able to submit `backend: "native"` or `backend: "outlayer"` to bypass treasury configuration. The administrator chooses the backend when creating/configuring the treasury. A developer may choose which treasury/payment profile their application uses, but cannot silently change that treasury's custody or execution backend.

The stable response should expose a provider-neutral lifecycle such as `accepted`, `awaiting_approval`, `submitted`, `processing`, `succeeded`, `failed`, `blocked` and `needs_review`, plus provider-specific references in a separate metadata object. Do not collapse provider acceptance into payment success.

### Backend types are not interchangeable

Use explicit treasury backend types:

- `outlayer_wallet`: current V1. OutLayer holds/signs from its custody wallet; AgentGuard calls its API and independently reconciles NEAR finality.
- `near_contract`: planned native treasury. A dedicated AgentGuard contract account holds native NEAR and enforces agent keys, recipients, allocations, pause and reservation accounting on-chain.
- `near_intents_outlayer`: future Intents route using OutLayer's custody wallet and its Intents API. This remains OutLayer custody/execution even though NEAR Intents performs the swap/settlement.
- `near_intents_direct`: separate future integration in which AgentGuard or a designated signer controls an account/key registered for NEAR Intents and signs the required intent payloads before submitting them to the solver relay.

Do not present `near_contract` and `near_intents_direct` as the same backend. A contract can custody NEAR and make supported on-chain calls. NEAR Intents uses signed intents, a solver/message-bus flow and Verifier settlement. A contract's ordinary `request_transfer` method does not automatically create or authorize a solver-routed cross-chain intent. Direct Intents support needs its own signer/key lifecycle, intent construction, quote/solver integration, approval binding and asynchronous settlement adapter. OutLayer already exposes Intents operations through its own Agent Custody API, so an AgentGuard adapter calling those endpoints would be an OutLayer-backed Intents route, not native AgentGuard contract execution.

### Initial native scope and extension path

The first native contract release should support native NEAR transfers only. NEP-141 tokens require a separate token adapter and token-contract storage/transfer handling. NEAR Intents swaps, cross-chain withdrawals, limit orders and confidential flows are separate capabilities and must not be implied by a native NEAR transfer implementation.

A later Intents adapter can support cross-chain payments and swaps without changing the developer-facing AgentGuard request interface, provided the asset and destination schema can represent the route and the selected treasury backend supports it. The adapter must bind the exact token, amount, destination, quote/route artifact and expiry to the AgentGuard request before approval. It must not approve a vague instruction such as "swap to USDC" and then accept a materially different route at execution.

### Backend selection and treasury isolation

Backend selection is an administrator-level treasury setting, not a per-agent override. One logical treasury must have one active spending backend in the first release. Do not let the same treasury balance be spendable through OutLayer and the native contract simultaneously: they are separate custody pools and cannot share a hard atomic exposure counter without an explicit cross-system reservation/settlement design.

A migration from OutLayer to a native contract requires pausing new requests, resolving all pending/ambiguous reservations, reconciling finality, funding the new treasury, verifying policy/key configuration, and then switching the treasury's backend. Do not automatically sweep funds or silently fail over between providers.

## 13. NEAR Intents integration considerations

NEAR Intents is a protocol route, not simply another native transfer method. Its documented flow has users sign intents, publish them to a solver relay/message bus, receive competing quotes from solvers, and settle selected intents through the Verifier contract. Account keys are registered with the Verifier for named accounts; supported external wallets can also derive implicit accounts.

There are two practical AgentGuard routes:

1. **Fastest extension from current V1:** add an OutLayer Intents adapter. OutLayer documents endpoints for Intents deposits, withdrawals, swaps and transfers. AgentGuard would still authenticate agents, reserve its own budget and bind the approved operation, while OutLayer owns the custody/signing step. This is not a native-contract backend.
2. **Independent direct integration:** implement a dedicated NEAR Intents adapter with its own account/key registration, intent signing, quote and solver-relay interaction, status polling and settlement verification. This does not automatically follow from deploying the AgentGuard treasury contract. A contract account cannot sign arbitrary off-chain intent payloads merely because it holds funds.

The direct integration must specify who controls the Intents signing key, how that key is restricted, and how an approved quote is cryptographically or operationally bound to the exact asset, amount and destination. A generic "approval required" flag is insufficient if the solver artifact can change after approval.

Provider documentation also describes limits of its own policy model. OutLayer's cumulative hourly/daily/monthly usage counters are documented as best-effort under concurrent requests, and its documented multisig path for certain Trusted Intents operations relies on gateway-supplied quote/deposit artifacts for some terms. AgentGuard must retain its own atomic reservations and must not claim that its approval proves the final solver route unless the adapter verifies that binding.

## 14. Capability matrix (planned)

| Capability | OutLayer current adapter | Native contract V1 | Future Intents adapter |
|---|---|---|---|
| Native NEAR transfer | Implemented | Planned | Can be a route/withdrawal |
| Agent identity and allocation | AgentGuard off-chain | Contract-enforced | AgentGuard plus adapter key mapping |
| Shared treasury reservation | AgentGuard atomic DB ledger | Contract-enforced on-chain | AgentGuard reservation plus protocol-specific settlement |
| Recipient allowlist | AgentGuard; OutLayer wallet policy is separate | Contract-enforced | Exact destination/route checks required |
| NEP-141 token transfer | Not in current adapter | Not in V1 | Depends on supported Intents route |
| NEAR Intents swap/cross-chain | Not in current AgentGuard adapter | Not in native V1 | Separate adapter required |
| TEE custody/attestation | OutLayer provides TEE; current AgentGuard adapter does not surface/verify transfer attestation | Not provided by contract | Depends on selected signer/provider |
| Independent on-chain policy enforcement | No AgentGuard treasury contract yet | Core purpose of native backend | Depends on account/contract/key architecture |


## 15. What native contract integration can and cannot do

The native treasury contract is a NEAR smart contract, not a universal payment rail. In the first release it will hold native NEAR and perform native NEAR account transfers under on-chain AgentGuard policy.

A NEAR contract can later call other NEAR contracts, including NEP-141 token contracts and selected DeFi/payment contracts, using explicit cross-contract calls. Each integration needs a purpose-built adapter, argument validation, attached-deposit/gas policy, callback handling and settlement reconciliation. It is not safe to expose an unrestricted arbitrary `call` method to agents: that can turn a transfer guard into a generic asset-draining contract caller.

NEAR Intents is a separate signed-intent protocol. The Verifier maps named accounts to registered public keys; users sign intent payloads and submit them to a solver relay, which coordinates quotes and on-chain settlement. A native treasury contract does not automatically control that off-chain signing flow. Giving an agent a key registered to the treasury's Intents identity could let it sign Intents outside the contract's `request_transfer` checks. Do not register agent-controlled signing keys to the treasury's Intents identity unless an independent authorization/signing design prevents that bypass.

Therefore:
- Native contract V1: native NEAR transfers only.
- Native contract + NEP-141: later, through an explicit token adapter and token-specific accounting.
- Native contract + other NEAR protocols: later, one audited adapter per protocol; no generic unrestricted contract-call permission.
- NEAR Intents through OutLayer: possible via OutLayer's documented API, but still OutLayer custody and currently mainnet-only; AgentGuard integration is not implemented.
- Direct NEAR Intents: separate project phase requiring a dedicated signer/Verifier integration and independent proof that the signed intent exactly matches AgentGuard's approved request.
