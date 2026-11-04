# Developer-funded workspace treasuries

Status: architecture proposal for review. This document does not change runtime code, database state, wallet configuration, or deployed environments.

## Decision

Treat a developer workspace as the owner of an independently funded NEAR treasury. Agent allocations are sub-limits of that workspace treasury. The existing policy engine remains the authorization layer, but the source of funds and execution backend become treasury-specific.

Preferred security model for the first real developer-funded implementation: one dedicated NEAR treasury contract account per workspace, with its own contract state, deposit balance, agent registry, allocations, recipients, reservations, and controller authority. A developer funds that treasury directly from a NEAR wallet. The treasury contract is the authoritative on-chain enforcement boundary. Do not represent a shared OutLayer wallet plus database rows as segregated customer funds.

A single shared contract with per-workspace internal accounting is a possible lower-operational-cost alternative, but it pools custody and creates a larger blast radius. It must not be described as independently segregated custody. It is not the default recommendation.

## Current state and compatibility boundary

- The current OutLayer adapter uses one configured OutLayer API credential and one configured NEAR execution account.
- The current database treasury exposure is represented by one agent_budgets row with ID default.
- spend_reservations records the agent, amount, recipient and lifecycle. The current reservation RPC serializes against the shared treasury row.
- Developer APIs already authenticate a developer and scope agent reads to agents.owner_user_id.
- Agent allocations are sub-limits of the current shared treasury. They do not create separate wallets or funded balances.
- The transfer endpoint reserves through the existing RPC and submits through the configured execution provider. It does not currently select a funded treasury owned by the authenticated developer.
- The existing native NEAR treasury contract design is a specification, not deployed contract code.

Do not silently repurpose the existing default treasury or move its OutLayer funds. Keep the operator/demo OutLayer treasury as a separate legacy V1 treasury until a deliberate migration is designed and approved. Existing agents, reservations, approvals, counters and transaction history must remain intact.

## Target request and funding lifecycle

1. Developer authenticates and owns a workspace.
2. Workspace provisioning creates a treasury record and a dedicated treasury contract/account, pinned to the NEAR network and native NEAR asset.
3. The developer sees the verified treasury account ID and can fund it from any compatible NEAR wallet.
4. An indexer/reconciliation worker observes incoming transfers, verifies the destination, amount, transaction status and NEAR finality, then records an immutable deposit entry.
5. Only finalized, verified deposits increase the spendable treasury balance. Pending deposits are visible but not spendable. Failed, duplicate, malformed or uncertain observations do not credit funds.
6. Developer creates agents. Each agent starts with zero allocation.
7. Developer allocates part of the workspace's spendable authority to agents. The sum of agent allocations cannot exceed the workspace's available treasury authority, and allocation cannot be reduced below that agent's spent plus reserved exposure.
8. Agent requests pass through the existing authentication, recipient, transfer-size, rolling-window, replay, emergency-stop and approval policy.
9. The treasury contract enforces the hard on-chain spending rules. Contract reservation and execution results are reconciled against the off-chain audit ledger.
10. Withdrawals are a separate developer-authorized operation. They require explicit destination validation, available-balance checks, replay protection, on-chain execution and finality reconciliation. Agents cannot withdraw or change treasury ownership.

## Accounting invariants

All amounts are integer yoctoNEAR. Do not use floating-point arithmetic.

- confirmed_balance is derived from finalized deposits less finalized withdrawals and finalized outgoing transfers.
- reserved represents funds committed to approved or in-flight transfers. Ambiguous submissions and unresolved callbacks remain reserved.
- available_balance = confirmed_balance - reserved - any required safety reserve.
- agent_available = agent_allocation - agent_spent - agent_reserved.
- Sum of agent allocation limits cannot exceed treasury spendable authority.
- Workspace A must never reserve against Workspace B's balance.
- A deposit is credited once, keyed by network and transaction hash/log identity.
- A provider timeout is not proof of failure and never releases a reservation.
- Off-chain counters are a reconciled mirror. The contract's state and finalized chain evidence are authoritative for the native treasury.
- A ledger mismatch pauses new spending for the affected treasury pending reconciliation. Do not auto-repair balances in the request path.

Clarify whether allocation is a ceiling over cumulative spending (as in current V1) or a renewable allowance. The first implementation should preserve current V1 cumulative allocation semantics unless an explicit product decision changes it.

## Data model direction

Introduce explicit workspace and treasury identity rather than adding more meaning to the global default budget row.

Candidate entities:

- developer_workspaces: stable workspace ID, owner user ID, status, created/updated timestamps.
- workspace_treasuries: treasury ID, workspace ID, network, asset, backend, contract/account ID, controller identity, deployment/code version, status, safety reserve, created timestamp.
- treasury_deposits: immutable deposit observations keyed uniquely by network + transaction hash + event/log index; sender, destination, amount, observed block, finality status, finalized timestamp.
- treasury_withdrawals: immutable withdrawal request and execution lifecycle, destination, amount, authorization actor, request ID, transaction reference, finality.
- treasury_ledger_entries: append-only debit/credit journal with source type and source ID. Never treat a mutable cached balance as the only evidence.
- agent_allocations: scoped to workspace treasury and agent, with spent/reserved exposure and explicit limit.
- spend_reservations: add a required treasury_id foreign key. Every reservation must resolve through the authenticated agent to exactly one active workspace treasury.

Avoid trusting a client-supplied treasury_id as authorization. Derive the workspace/treasury from the authenticated agent record, then optionally compare any supplied ID and reject mismatches.

## Execution architecture

Extend the existing ExecutionProvider boundary with treasury-scoped context. Do not let an agent select its provider or treasury. Resolve both server-side from the agent's owning workspace and treasury record.

- Keep the current OutLayer adapter for the existing operator/demo treasury only, unless OutLayer confirms and we implement a secure per-workspace custody/account model.
- Add a separate native NEAR contract adapter for developer-funded treasuries.
- Pin each treasury to exactly one backend. Do not dual-submit or automatically fail over between OutLayer and native contract.
- Do not place a treasury full-access private key in the web application or expose it to agents.
- Use restricted function-call keys or an independently secured signer, bound to the exact treasury contract and approved method.
- Bind the off-chain agent identity and NEAR public key during provisioning. Never trust an agent_id method argument as the on-chain identity.
- Require controller approval for the initial native release, matching current manual approval semantics. Autonomous on-chain execution is a later phase.
- Contract callbacks/finality reconciliation must settle reservations idempotently. A scheduled promise or successful RPC submission is not final payment success.

## Migration and rollout

1. Keep this branch isolated. No changes to main, Preview, Production, current OutLayer secrets, or live Supabase.
2. Complete a schema/API inventory and map every RPC that reads or mutates treasury exposure.
3. Finalize custody, workspace ownership, controller recovery and withdrawal threat model.
4. Implement additive schema with nullable treasury references only during a controlled backfill; do not weaken current non-null constraints until a verified migration plan exists.
5. Backfill the current default treasury as a legacy operator-owned treasury. Reconcile its counters against reservation history before enabling any new code.
6. Create a separate workspace treasury path. New developer-funded treasuries must not share the legacy OutLayer wallet or default budget row.
7. Implement deposit observation and finality verification before exposing spendable balances or a funding UI.
8. Implement native contract and adapter in isolation; add contract tests and API/database concurrency tests.
9. Add read-only treasury/deposit views first. Add funding instructions only after destination generation and deposit monitoring work end-to-end.
10. Add allocation, spending and withdrawal controls only after the corresponding contract methods and audit lifecycle are implemented.
11. Run migration tests on a disposable Supabase project, then testnet with deliberately small funds. Verify cross-workspace isolation, replay, concurrency, pause, approval, deposit finality, withdrawal and reconciliation.
12. Roll out behind a treasury-backend feature flag. Existing OutLayer treasury remains operational until a separately approved migration.

## Required questions before implementation

- Is the product custody model explicitly custodial (Encu-controlled contract) or developer-controlled (developer retains controller/recovery authority)? This must be stated accurately in product terms.
- Who controls the workspace treasury controller key, and what is the recovery process if the developer loses it?
- Does each workspace get a separate contract/account, or is pooled custody with contract-enforced sub-ledgers acceptable?
- Which network is supported first? Testnet only is the safe development target.
- Are deposits native NEAR only for the first release?
- What minimum balance must remain for storage, gas and contract operation?
- What withdrawal delay, destination policy and recovery controls are required?
- Are agent allocations cumulative caps or replenishable allowances?

## Explicit non-goals for the first funding increment

- Mainnet funds or deployment.
- NEP-141 tokens, swaps, cross-chain transfers or NEAR Intents.
- Automatic conversion, fiat on/off-ramp or exchange integration.
- Deposits credited from screenshots, user claims or unfinalized transactions.
- Shared OutLayer wallet presented as per-developer segregated custody.
- Arbitrary contract calls by agents.
- Automatic migration or sweeping of the existing operator treasury.
- Changes to the accepted dashboard visual system before the data model and user flow are settled.


## OutLayer-backed implementation options (research update, 2026-11-04)

The initial preference for a dedicated native treasury contract is not yet a final decision. OutLayer documentation now exposes two plausible implementations:

1. **OutLayer custody wallet per workspace.** `POST /register` creates a wallet with its own wallet ID, API key and NEAR account. Distinct wallet IDs derive distinct NEAR accounts/keys. The developer funds the workspace's published account directly. This is the shortest route to per-workspace balances and deposit destinations, but custody is managed by OutLayer's TEE/MPC system. It must be disclosed as OutLayer-managed custody, not developer-held keys. A per-customer MPC vault can add a customer-controlled recovery path, but adds provisioning and recovery complexity.
2. **Personal Account Binding.** The developer keeps control of an existing named NEAR account and signs a setup transaction authorizing the OutLayer executor through a wallet contract. Spending uses OutLayer's binding endpoints and the developer's on-chain policy. This is closer to non-custodial ownership but requires wallet connection/setup, active-binding verification, owner policy configuration and a different transfer adapter.

OutLayer's `hos_lease` Agent Connect mode is not currently the right default: it is a partner-provisioned leased-account programme and is not a generic self-service developer treasury.

**Recommended next technical step:** build a disposable Testnet spike for Option A only after explicit approval to provision a test wallet; in parallel, write a short Option B feasibility note. No wallet has been registered and no funds have moved. Do not choose the native treasury contract until these options have been tested against custody requirements and operational costs.

References:
- OutLayer Agent Custody: https://app.outlayer.ai/docs/agent-custody
- OutLayer Binding API: https://app.outlayer.ai/docs/binding-api
- OutLayer Personal Account Binding: https://app.outlayer.ai/docs/account-binding
- OutLayer MPC Vaults: https://app.outlayer.ai/docs/vaults
- OutLayer Agent Connect: https://app.outlayer.ai/docs/agent-connect


## Personal Account Binding implementation specification (decision update, 2026-11-04)

The product owner selected developer-controlled NEAR account binding as the priority. This supersedes the earlier tentative recommendation to prototype OutLayer custody wallets per workspace.

Documented sequence: assign an OutLayer executor wallet to the workspace; developer connects a compatible named NEAR account; server records PUT /wallet/v1/binding with kind=personal_account; server fetches the unsigned GET /wallet/v1/binding/setup?kind=personal_account transaction; developer reviews and signs; server polls GET /wallet/v1/binding until active; configure and verify restrictive policy; fund the asset account and separately maintain executor gas; submit via POST /wallet/v1/binding/transfer or POST /wallet/v1/call.

The setup transaction references OutLayer's global wallet contract and adds the executor to the developer account extension set. It must be signed by the developer account. OutLayer currently documents Intear Wallet and near-cli for NEP-591 UseGlobalContract; do not assume broad wallet support. Reject accounts already running contract code.

The owner revokes access by removing the executor extension on chain. OutLayer documents up to five seconds of cached allow decisions. DELETE /wallet/v1/binding cleans up OutLayer's record and pending approvals but does not replace on-chain revocation.

Current Encu adapter and reconciler are incompatible: they use one global credential, plain executor-wallet transfer, and direct-transfer transaction checks. Binding calls require workspace-specific executor context and receipt-aware verification of the inner native transfer. Keep funds reserved in needs_review until exact inner effects are proven.

One personal NEAR account cannot represent multiple separately funded workspaces. Require one named account per workspace or explicitly model a shared treasury. Keep executor credentials server-side; do not put long-lived wk_ keys in hosted connect URLs. Current package has no NEAR wallet connector, so binding onboarding is a new capability.

No runtime, schema, provider, wallet or transfer changes are authorized by this specification. All details are based on OutLayer public docs and require Testnet verification before deployment.
