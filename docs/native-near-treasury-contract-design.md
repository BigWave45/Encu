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
- `withdraw(to, amount, request_id)`, only if withdrawal authority and multisig/confirmation policy are explicitly designed. This is not an agent method.

Controller methods must check `predecessor_account_id == controller_id`. The controller account must be different from the treasury account's agent restricted-key identity. The implementation must not treat every call from the treasury account as an administrator call.

### Agent method

`request_transfer(request_id, recipient, amount_yocto, client_nonce)`

The method derives the agent from the signer public key. It rejects unknown/revoked keys, inactive agents, paused treasury, unauthorized/expired recipients, invalid amount, per-transfer violations, agent allocation exhaustion, treasury exposure exhaustion and reused request IDs/nonces.

The contract must reserve treasury and agent exposure in the same receipt before creating the transfer promise. Because NEAR serializes state changes through receipts, concurrent requests are checked against the latest committed contract state. The second request cannot rely on a stale off-chain budget read.

## 6. Transfer lifecycle and asynchronous settlement

A native NEAR transfer initiated by a contract is asynchronous. Returning successfully from `request_transfer` means the request was accepted and the transfer promise was scheduled; it does not mean the recipient has received funds.

Required lifecycle:

1. Validate signer, agent, policy, recipient, pause, nonce and available contract balance.
2. Check `spent + reserved + amount <= treasury_limit` and the equivalent agent allocation constraint.
3. Persist a pending reservation and increment both reserved counters.
4. Initiate `Promise::new(recipient).transfer(amount)`.
5. Attach a private callback on the treasury contract with enough prepaid gas.
6. In the callback, verify it is a private self-call and inspect the promise result.
7. On successful transfer receipt, decrement both reserved counters, increment both spent counters and mark the reservation executed.
8. On final failed transfer promise, decrement both reserved counters and mark it failed with a durable failure reason.
9. Emit structured events for request accepted, transfer outcome, policy changes and emergency state.

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
