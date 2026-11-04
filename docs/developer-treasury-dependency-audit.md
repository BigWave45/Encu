# Developer treasury dependency audit

Status: read-only source audit against main on 2026-11-04. Findings are architectural; no runtime code or database was changed by this audit.

## Confirmed current coupling

### Identity and ownership

- `agents.owner_user_id` is nullable and was added by `20261103110000_developer_identity_ownership.sql`.
- `create_developer_agent` creates an agent with the authenticated developer's user ID, plus a zeroed `agent_allocations` row and policy.
- Developer agent list/configuration/transaction APIs filter by `owner_user_id` or call `requireOwnedAgent`.
- There is no first-class `developer_workspaces` or `workspace_treasuries` relation in the current schema. Ownership is currently direct user-to-agent.
- Existing legacy agents can have a null owner. They must not be assigned to a new developer treasury by inference.

### Shared treasury enforcement

- Current financial authority is the single `agent_budgets` row with ID `default`.
- Agent allocations are globally keyed by `agent_id`, and are sub-limits of that shared treasury.
- Developer configuration RPC wrappers (`developer_set_agent_policy`, `developer_set_agent_allocation`, `developer_set_agent_auto_spend_limit`, `developer_authorize_agent_recipient`, `developer_revoke_agent_recipient`) lock the global `default` budget row before checking agent ownership and invoking the shared mutation RPCs.
- The transfer reservation RPC `reserve_agent_spend` locks `agent_budgets.default`, then the global agent allocation row, then the reservation. It has no workspace/treasury argument or treasury resolution.
- The submission-claim RPC `claim_agent_auto_submission` uses the same global budget and allocation model.
- Final settlement RPC `finish_agent_spend` and provider submission recording `record_outlayer_submission` also settle against the shared treasury lifecycle. The current native funding work must inspect and replace these as one coordinated lifecycle, not only change the reservation entrypoint.
- The admin budget endpoint edits the global default treasury ceiling. The admin emergency-stop endpoint edits the global default system control.
- The agent balance endpoint reads the configured OutLayer wallet balance, not a developer workspace balance.

### Provider submission and finality

- `app/api/agent/transfer/route.ts` authenticates the agent, invokes `reserve_agent_spend`, claims submission through `claim_agent_auto_submission`, then calls the configured `ExecutionProvider`.
- `lib/execution-provider.ts` currently exposes a provider interface without treasury/workspace context. The OutLayer adapter uses one configured API key and one configured NEAR address.
- `app/api/agent/reconcile/route.ts` validates NEAR finality against the configured OutLayer signer, then calls `finish_agent_spend`. It is not currently treasury-backend aware.
- The developer transactions API reads reservations by the authenticated developer's owned agent IDs. It is a useful ownership boundary for display, but it does not make the shared treasury funds segregated.
- The current native NEAR treasury contract document is a specification only. No native contract implementation or deployed treasury contract is established by this audit.

## Consequence

The current developer identity feature is account-scoped management of agents, not developer-owned funding. All developer agents still consume from one global operator-configured treasury ceiling and one configured OutLayer execution wallet.

A funding implementation cannot safely be limited to a deposit table, a balance card, or a developer ID column. The following must be changed together:

1. Resolve the authenticated agent to exactly one active workspace and treasury on the server.
2. Reserve against that treasury's balance and that agent's allocation atomically.
3. Pin the treasury to one execution backend and submit from that same treasury.
4. Reconcile submission, NEAR finality and settlement against the same treasury.
5. Scope emergency stop, treasury ceiling, allocations, recipient controls, audit and withdrawal authority correctly.
6. Keep legacy operator treasury rows and existing reservations pinned to the legacy treasury.

## Migration implications

- Add explicit workspace and treasury records. Do not turn `owner_user_id` into a treasury key.
- Add a treasury identity to reservations and any other money-moving records, then backfill existing records to a named legacy operator treasury only after validating every row and ledger aggregate.
- Preserve the existing default budget and OutLayer execution path as the legacy operator treasury during rollout.
- New developer workspaces must receive a separate treasury identity and backend. They must not inherit access to the legacy OutLayer wallet or global emergency controls.
- Update all reservation lifecycle RPCs in one versioned migration set: reserve, submission claim, provider submission recording, settlement, failed-final resolution, cancellation/rejection paths if retained, allocation updates, and treasury ceiling controls.
- Preserve a consistent lock order. For the new model, lock workspace treasury first, then agent allocation, then reservation. Any path that changes exposure must follow the same order.
- Backfill and deploy additively. Do not make `treasury_id` mandatory or route transfers by treasury until old records are reconciled and all writers have been upgraded.
- Avoid an in-place rewrite of the current live Supabase project during initial development. Use migration tests on a disposable project and testnet.

## Gaps to close before schema design is frozen

- Inventory all SQL definitions and current deployed function bodies for `reserve_agent_spend`, `claim_agent_auto_submission`, `record_outlayer_submission`, `finish_agent_spend`, and any failure-resolution/reconciliation RPCs. Historical migrations contain multiple replacements; the latest deployed definition, not the first migration version, is authoritative.
- Inspect the remainder of the transfer route after provider response handling and every caller of settlement RPCs.
- Inspect all admin emergency-stop and budget controls to decide which controls become per-workspace and which remain platform-wide.
- Confirm OutLayer supports the proposed per-workspace treasury/account model. Current adapter source proves only one configured execution address.
- Decide custody/controller authority and recovery before implementing treasury provisioning or withdrawals.
- Decide whether developer-owned agents with null/missing workspace associations are blocked from spending or remain attached to the legacy operator treasury. Default safe behavior: block until explicitly assigned; do not infer ownership.

## Current audit result

The design can be implemented without redesigning the existing UI or discarding the policy engine. It is a cross-cutting financial architecture change, not a small dashboard feature. The highest-risk work is database lifecycle migration and execution/finality routing. Keep this branch isolated until those changes pass automated tests and testnet verification.


## Live test-project verification (2026-11-04)

Read-only inspection was performed against the Supabase project named `AgentGuard Test` (project ref `rrvrlvitjithqizwutfl`). This is the configured test project, not proof about any other Supabase project.

- The applied migration registry includes the developer identity/ownership migrations, developer-owned configuration RPCs, allocation enforcement, submission revalidation and rolling-autonomy restoration through version `20261103190317` (`retire_manual_approval_rpcs`).
- The live public schema has no first-class workspace or treasury tables. `agent_budgets` has one row, `default`; `agent_allocations` has five agent rows.
- The live `agents` table has five agents: two have non-null `owner_user_id`; three are owner-null legacy/test agents. These owner-null records must not be auto-assigned to a developer treasury.
- The live `spend_reservations` table has six records. The inspected records are all terminal states (executed/rejected/failed/cancelled); no open reservation was present in that snapshot.
- The global `default` budget currently reports total limit 5 NEAR, spent 0.001 NEAR and reserved 0 NEAR. This is the test project's current database ledger state, not a chain balance or proof of funds held by the provider.
- Live definitions of `reserve_agent_spend`, `claim_agent_auto_submission`, `record_outlayer_submission`, `finish_agent_spend`, `resolve_agent_transfer_failed_final`, `update_agent_budget_limit` and `set_agentguard_transfers_enabled` were queried read-only. The key reserve/claim/record/settle/failure-resolution functions still lock and mutate the global `agent_budgets.default` row and agent allocation rows. The submission claim also checks the global `agentguard_system_controls.default` stop.
- The live provider adapter source remains single-signer OutLayer. No evidence has been obtained that OutLayer can submit from a workspace-specific NEAR account or treasury contract.

### Important correction to migration planning

The current test database has two developer-owned agents but no workspace relation. We cannot infer that each user should receive one treasury solely from `owner_user_id` until membership and workspace semantics are decided. The safe migration needs an explicit mapping table and a reviewed backfill plan. Existing owner-null agents and their historical reservations remain attached to the legacy operator treasury unless an operator explicitly migrates them.

This live inspection used read-only project, migration, table and SELECT/function-definition operations. No data, schema, migration, wallet, secret, Preview or Production state was changed.


## OutLayer capability research (2026-11-04)

The earlier statement that OutLayer compatibility was wholly unproven is too broad. Current public OutLayer documentation describes two relevant capabilities. This is documentation research, not a live API integration test.

### Option A — one OutLayer custody wallet per workspace

OutLayer's Agent Custody documentation describes `POST /register` creating a wallet and returning a wallet API key, wallet ID and NEAR account ID. Its Vault documentation says each registration creates a fresh wallet; distinct wallet IDs derive distinct NEAR implicit-account keys, including when multiple wallets are under one customer vault. The API key is resolved server-side to its wallet ID and vault scope; a client-supplied vault header cannot change that scope.

This appears to provide a practical isolated-funding route:
- Provision one OutLayer wallet for each Encu workspace.
- Store that workspace's API key encrypted server-side and bind the wallet ID, network and NEAR account ID to the workspace record.
- Show the returned NEAR account ID as the funding destination.
- Verify incoming native NEAR deposits on chain and credit only after finality.
- Submit workspace transfers using that workspace's API key and its wallet-specific OutLayer address.
- Read and verify the wallet's own balance; never use the global `OUTLAYER_NEAR_ADDRESS` as the source of truth for every workspace.

OutLayer documents wallet-level policies, address whitelists, spend limits, approvals and freeze controls. The Encu database policy still needs to be enforced independently. A per-workspace OutLayer wallet has a distinct on-chain account/key, but the key custody is provided by OutLayer's TEE/MPC system. Do not describe this as developer-held private-key self-custody. If using an OutLayer customer vault, document the parent/recovery trust model and the unilateral/cessation recovery path.

The public docs state that wallet registration, address, balance and transfer endpoints work on Testnet. NEAR Intents deposit/withdraw routes are explicitly mainnet-only and return 503 on Testnet; they are not part of the Testnet native-NEAR funding MVP.

### Option B — bind a developer-owned NEAR account

OutLayer Personal Account Binding lets the developer retain their named NEAR account and keys while authorizing the OutLayer executor through an installed wallet contract and extension set. The developer must sign the setup transaction. The bound account's funds are spent through `/wallet/v1/binding/transfer` or `/wallet/v1/call`, not the existing plain `/wallet/v1/transfer` endpoint. Binding is a capability, not ownership transfer. The owner can revoke the executor extension on chain.

This is closer to developer-controlled/non-custodial ownership, but has onboarding and integration costs:
- Developer must own a compatible named NEAR account and sign the binding setup.
- Encu must verify the binding is active on chain before enabling spending.
- OutLayer requires an appropriate owner policy; the binding lane is a contract call and its policy must permit `call`, include the bound account in address rules where applicable, and permit native NEAR.
- The executor account needs separate gas funding.
- The app must use binding balance/transfer endpoints and handle structured refusals, approval state and binding revocation.
- The current transfer/reconciliation flow assumes the executor account as signer; it must be updated to verify the actual bound asset account and transaction signer.

This is a viable alternative if developer-held account ownership is a non-negotiable product requirement. It is not a drop-in replacement for the current adapter.

### Option C — native Encu treasury contract

A native contract remains a viable longer-term option if Encu needs its own on-chain workspace ledger, agent identities and policy enforcement independent of OutLayer. It is more work and is not justified until the first two approaches are evaluated against custody, recovery, user experience and integration constraints.

### Updated recommendation for evaluation

Prototype Option A first on Testnet as the shortest path to genuine per-workspace deposit addresses and separate on-chain balances, while explicitly labeling it OutLayer-managed custody. In parallel, assess Option B as the non-custodial alternative. Do not build the native treasury contract merely because it was the initial preference; the documented OutLayer wallet-per-workspace capability changes the trade-off.

Before any live provisioning, confirm with OutLayer (or through a controlled test wallet) registration semantics, wallet/API-key revocation, wallet-level policy configuration, balance consistency, native NEAR deposit finality, transfer response/reconciliation semantics, and whether the API key can be restricted to required operations. Do not create wallets or submit transfers as part of this research pass.


## Personal Account Binding feasibility (2026-11-04)

Product decision: prioritize OutLayer Personal Account Binding for developer-controlled NEAR accounts. This is a documented capability, not yet tested in Encu. Do not provision a wallet or implement until this feasibility review is accepted.

### Setup sequence

1. Assign an OutLayer executor wallet to the Encu workspace. The executor is distinct from the developer's asset account. The current Encu deployment has one global OUTLAYER_API_KEY and OUTLAYER_NEAR_ADDRESS and cannot safely represent multiple workspace bindings. The conservative design is a separate executor wallet/API credential per workspace. OutLayer must confirm whether one executor can have more than one active personal binding; its singular binding status endpoint and refusal to silently rebind suggest one active asset binding per executor.
2. Developer connects a compatible named NEAR account and proves control. The account must not already run contract code because setup references a global wallet contract using NEP-591 UseGlobalContract. OutLayer currently documents Intear Wallet and near-cli as supported signing paths; broad wallet compatibility must not be assumed. Reject existing multisig, 2FA or contract-wallet accounts rather than overwriting them.
3. Server calls PUT /wallet/v1/binding with asset_account_id and kind=personal_account, authenticated with that workspace executor's OutLayer credential. This records intent only; status remains pending and no authority is granted.
4. Server calls GET /wallet/v1/binding/setup?kind=personal_account. OutLayer returns the code hash and unsigned setup transaction. Developer reviews and signs it with their own wallet. The transaction is signed by and sent from the asset account and contains three actions: reference the global contract, initialize it, and add the executor to the account extension/control set. Show account, executor ID, network, code hash and actions before wallet confirmation.
5. Server polls GET /wallet/v1/binding and enables spending only when binding_status=active. A successful PUT or wallet signature is not sufficient.
6. Configure and verify a restrictive OutLayer wallet policy before enabling agents. Personal binding has no separate leased-account spend grant; the extension plus OutLayer policy governs the executor. For native transfers the docs require transaction_types to include call, the address policy to include the bound asset account (or mode=none), and allowed_tokens to include native or *. Missing policy is unsafe. Limits use smallest-unit decimal strings.
7. Developer funds the asset account. The executor account separately pays gas. GET /wallet/v1/binding/balance reports asset funds; GET /wallet/v1/binding reports executor gas and gas_balance_low. Never present executor balance as the developer treasury balance.
8. Submit native transfers using POST /wallet/v1/binding/transfer, or POST /wallet/v1/call for the full envelope. The transfer endpoint creates a contract call against the asset account. It is not the current plain POST /wallet/v1/transfer from the executor's own account. No fallback to plain transfer is permitted when binding is absent or inactive.

### Authorization and revocation

- PUT records the relationship; authority starts only after the developer signs the setup transaction adding the executor extension.
- The developer retains direct control with their own NEAR keys and can remove the executor extension in an owner-signed on-chain transaction without Encu or OutLayer permission.
- OutLayer documents up to five seconds of cached allow decisions. Revocation is therefore not instantaneous; treat the cache window as part of the threat model.
- DELETE /wallet/v1/binding ends OutLayer's record and cancels pending approvals, but does not replace on-chain removal of the executor extension. Disconnect should instruct the owner to revoke on chain and then verify status.
- GET /wallet/v1/binding statuses are pending, active, suspended and revoked. Only active may submit. Fail closed on unreadable or stale status.
- Structured refusal classes include executor_not_in_control_set, account_frozen, unsupported_wallet_implementation, unrecognized_wallet_code, chain_status_unreadable and policy violations. Retry only reversible failures; terminal refusals require owner/admin action.

### Required Encu integration changes

Current lib/outlayer.ts uses one global API key and POST /wallet/v1/transfer. ExecutionProvider verifies one configured executor. Current reconciliation expects a direct NEAR Transfer action, signer equal to OUTLAYER_NEAR_ADDRESS, receiver equal to recipient and exact deposit amount. Those assumptions are invalid for binding calls.

A binding-aware provider must carry immutable workspace/treasury context, resolve that workspace's executor credential, require active binding, read both balances and call only the binding transfer/call endpoint. Reconciliation must verify the executor signer, bound asset-account receiver, contract method and arguments, then inspect final receipts/state to prove the intended recipient received the exact native amount. Checking only outer transaction success is insufficient because inner receipt execution may fail. Keep reservations in needs_review until exact inner effects are proven. Update reservation, submission claim, submission recording, settlement, failed-final resolution, approval cancellation and emergency-stop logic together, with workspace authorization checked inside SQL functions.

### Workspace isolation

One personal binding names one asset account. If multiple workspace executors bind to the same developer NEAR account, they spend from the same on-chain balance. That is not isolated workspace funding. Require one dedicated named account per workspace, or explicitly model them as sharing one treasury.

### Credential and browser security

Keep each executor API key server-side, encrypted at rest, never in browser storage, client responses, logs, analytics or query strings. OutLayer's hosted connect example places a wk_ key in a URL query parameter; do not adopt this by default because URLs leak through history, referrers and logs. Prefer server-side setup retrieval and pass only the unsigned transaction payload to an audited NEAR wallet connector. If hosted connect is unavoidable, obtain vendor guidance on short-lived single-use handoff tokens. The current package has no NEAR wallet adapter dependency and the developer portal has no wallet-connect/binding lifecycle. Encrypt credentials using KMS or equivalent envelope encryption and define rotation, revocation, least-privilege access and incident response.

### Open questions before implementation

1. Can one OutLayer executor have multiple active personal bindings? If not, confirm one executor/API credential per workspace.
2. How are executor wallets provisioned, deleted and API keys rotated/revoked? Can keys be operation-scoped?
3. Which wallet contract code hashes and extension interfaces are supported on Testnet and Mainnet, including upgrades?
4. Which browser wallet versions support NEP-591 UseGlobalContract on both networks, and what is the mobile experience?
5. What exact transaction/receipt fields prove inner native transfer success? Is there a canonical operation/receipt ID for idempotent reconciliation?
6. How is executor gas funded and replenished, and what happens if Encu is unavailable?
7. Can policy be set and read back before binding activation, and can Encu verify exact policy values?
8. Do all binding and agent execution paths share the same wallet policy counters?

Feasibility conclusion: Personal Account Binding is a viable candidate for developer-controlled asset ownership without Encu holding developer private keys. It still depends on OutLayer's executor, signing service and policy engine, and requires executor gas. It is not implementation-ready until the questions above, wallet compatibility, workspace account isolation and receipt-aware reconciliation are verified. No wallet, binding, policy, credential or transfer was created during this research.


## Follow-up verification: binding policy, balances, request lifecycle and integration risks (2026-11-04)

Reviewed current OutLayer Personal Account Binding, Binding API and Agent Custody documentation. These are vendor-documentation findings, not a live API test.

### Confirmed endpoint and account semantics

- `GET /wallet/v1/binding` returns `binding_status`, `status_reason`, `executor_account_id`, `gas_balance`, `gas_balance_low` and threshold. Only `active` is spendable. Poll it; personal-account binding has no partner lifecycle webhook (the documented binding events webhook is lease-only).
- `GET /wallet/v1/binding/balance` reads the developer asset account. `GET /wallet/v1/balance` without `account=asset` reads the executor's own balance. Never confuse the two.
- `POST /wallet/v1/binding/transfer` sends native NEAR from the bound asset account through a contract call. `POST /wallet/v1/call` is the full-envelope alternative. The normal `/wallet/v1/transfer` spends the executor account and must not be used as a fallback.
- `GET /wallet/v1/address` returns executor and asset account identities. Persist and compare both against the workspace binding record.
- API docs describe pending/active/suspended/revoked states; only active is allowed. `DELETE /wallet/v1/binding` cancels pending approvals and removes the provider binding record, but owner-signed on-chain extension removal is the actual authority revocation.
- Executor gas and developer asset funds are separate. The executor needs its own NEAR gas reserve; the developer funds the bound asset account.

### New critical policy-control question

OutLayer says the policy is owned/controlled by the OutLayer wallet owner/controller, encrypted on chain, and enforced by the TEE. The Personal Account Binding docs say the policy is the only spending limit for a personal account and explicitly warn that no policy means unrestricted spending. The public docs reviewed do not establish, with sufficient precision, who is the controller for a workspace executor provisioned by Encu, how the developer can independently inspect/change/freeze that executor's policy, or whether a developer signature can own/control the executor wallet policy while preserving the binding arrangement.

This must be answered before implementation. If Encu alone controls the executor policy, the developer has on-chain authority to revoke the extension but does not necessarily have direct control over the OutLayer policy. That may be an acceptable disclosed delegation model, but it is not equivalent to developer-controlled policy. Do not claim developers control both keys and policy until proven.

The docs also list `GET /wallet/v1/policy` and dashboard policy management, but the public API reference reviewed does not establish a supported write endpoint for policy configuration. We must not invent one. Confirm whether policy is configured through the OutLayer dashboard, a controller-signed on-chain call, or another supported owner flow. Verify read-back before enabling binding.

### Policy enforcement limitation

OutLayer documents per-transaction limits, address rules, transaction type gates, time restrictions, freeze and approval controls as exact TEE checks. However, its daily/hourly/monthly cumulative spend and hourly transaction-count limits use a gateway-supplied usage counter and are best-effort under concurrent requests: parallel submissions can read the same pre-spend counter and collectively exceed a cap. Encu must retain its own PostgreSQL atomic reservations and serialize per-workspace submissions where needed. OutLayer velocity limits are defense-in-depth, not a replacement for Encu's shared-budget ledger.

For native binding transfers, the OutLayer policy must permit transaction type `call`, include the bound asset account in the address whitelist (or disable address filtering deliberately), and include `native` in allowed tokens. A restrictive policy must exist and be verified before the developer signs the binding setup transaction. Do not allow an unconfigured/unrestricted policy to reach `active` in the product flow.

### Request and reconciliation requirements

OutLayer's general API docs describe `GET /wallet/v1/requests/{request_id}` and structured statuses for asynchronous operations, approvals and `needs_review`; a lost response may mean the operation is still processing. Encu must persist the provider request ID before considering a submission complete, poll rather than resubmit, and use idempotency support only where the binding endpoint explicitly documents it. The current public binding page does not fully specify all response variants for binding transfers, nor does it give a complete receipt schema proving the inner native transfer. Obtain an exact sample response and final-receipt contract from OutLayer, then test against Testnet. Outer transaction success alone is insufficient.

### Wallet onboarding and product UX

OutLayer says the setup requires NEP-591 `UseGlobalContract`; it documents Intear Wallet on Testnet/Mainnet and near-cli as working paths and warns that most NEAR wallets, including MyNearWallet in its described flow, do not complete the action. The current package has no NEAR wallet connector. Do not claim generic wallet-connect compatibility. Browser/mobile support, wallet deep-link return, transaction payload compatibility and account-state checks require an actual Testnet spike. Accounts already running contract code must be rejected by the vendor flow; do not attempt to overwrite multisig/2FA contracts.

OutLayer's hosted connect example places the long-lived `wk_` API key in a URL query parameter. This creates browser-history/referrer/log leakage risk. Prefer a first-party wallet connector and server-side setup retrieval. If the hosted connect flow is used, require a short-lived single-use handoff mechanism confirmed by OutLayer; do not expose a long-lived API key in the URL.

### Revised technical decision gates

1. Confirm who controls and can update/freeze the OutLayer executor wallet policy, and how the developer can verify policy state.
2. Confirm deterministic wallet / API credential provisioning and ownership; confirm one executor wallet can have only one personal binding (current API behavior refuses rebinding to a different account without DELETE, so design one executor per workspace unless vendor confirms otherwise).
3. Confirm binding transfer response, request polling, idempotency and exact inner receipt proof.
4. Verify Intear wallet browser/mobile support for NEP-591 setup, including return-to-app behavior.
5. Confirm executor gas funding/replenishment and key revocation/rotation.
6. Only then build a disposable Testnet spike. Keep Encu's database reservations authoritative and fail closed on stale/unavailable binding state.

No runtime, schema, provider, wallet, credential, policy, database or deployment changes were made during this research pass.


## Critical correction and deterministic-wallet ownership path (2026-11-04)

This section supersedes any earlier statement in this document that Personal Account Binding has an on-chain spend grant. Current OutLayer Personal Account Binding documentation explicitly says: a personal account has NO separate on-chain spend grant; the OutLayer wallet policy is the only limit on the bound account. A missing policy means the agent can move everything in the bound account. The separate on-chain spend grant applies to the leased `hos_lease` mode. Do not conflate the two modes.

### Newly identified candidate: deterministic OutLayer executor wallet

OutLayer's Agent Custody docs describe deterministic wallets derived from `(account_id, seed, vault_or_none)`. The same inputs recreate the same wallet; different seeds produce independent wallet identities. Authentication uses a raw Ed25519 signature from a full-access NEAR key on every request (`Authorization: Bearer near:<base64url>`), and OutLayer says it stores no auth credential for this mode. Removing the NEAR key revokes access within a documented 60-second cache TTL. Function-call keys are not accepted for this auth mode.

This may solve the policy-controller gap: if each workspace's executor wallet is deterministically derived under the developer's NEAR account, the developer may be the wallet controller and can control its on-chain OutLayer policy, while the personal binding authorizes that executor to act through the developer's named asset account. This is a promising architecture, not yet proven. The current docs do not fully explain whether the controller of a deterministic executor wallet can set/freeze policy for the bound asset account as expected, or the exact delegate-key flow for giving Encu backend access without storing the developer's full-access private key.

OutLayer also documents `PUT /wallet/v1/api-key` and `DELETE /wallet/v1/api-key/{key_hash}` for delegate API keys. The docs say custody wallets can create sub-agent keys by supplying `seed` and `key_hash`; the exact semantics, response handling, permissions and applicability to a deterministic wallet must be confirmed. Do not infer that the API key can be safely created/revoked by the developer without verifying the request/response and authorization model.

### Candidate architecture to test

1. Developer signs a short-lived deterministic-wallet registration challenge using a NEAR full-access key; the backend never receives or stores the private key.
2. Derive one stable executor identity per workspace using a unique, namespaced seed. Do not reuse the same seed for multiple workspaces. The developer account is the deterministic wallet owner/controller if confirmed by OutLayer.
3. Developer binds their dedicated named NEAR asset account to that executor through Personal Account Binding and signs the `UseGlobalContract` setup transaction.
4. Developer configures the executor wallet's on-chain policy: strict per-transaction limit, recipient allowlist, `call` transaction type, `native` token, approval threshold where needed, and freeze controls. Verify the policy read-back before any agent is enabled.
5. Encu obtains a narrowly scoped delegate API key for backend requests, if OutLayer confirms this is supported for deterministic wallets. Store only that key encrypted server-side. If delegation is not supported safely, the product needs an owner-signing or alternative credential architecture; do not ask the developer to paste a full-access private key.
6. Encu retains its own atomic PostgreSQL reservations, agent allocations, replay protection, shared workspace cap and finality reconciliation. OutLayer policy is a second enforcement layer, not a replacement.

### Important implications

- Personal binding has no independent on-chain grant ceiling. Do not claim a grant plus policy. The policy must exist and be restrictive before binding is enabled.
- OutLayer documents cumulative daily/hourly/monthly and transaction-count policy counters as best-effort under concurrency; Encu's atomic ledger remains the hard shared budget.
- The policy owner/controller is critical. If the executor wallet is registered randomly under OutLayer's default master and only Encu holds its `wk_` key, the developer may not independently control its policy. A deterministic executor derived under the developer's account is the candidate route to developer policy ownership.
- A deterministic wallet is not automatically an asset account. The executor still has its own implicit NEAR address and pays gas; the bound named account holds the developer's assets. Confirm gas funding and controller semantics.
- The developer's named asset account and each workspace must be distinct if workspaces are to have separate balances. A deterministic executor seed alone does not segregate asset funds.
- A `near:<sig>` credential requires full-access Ed25519 signing per request. Never collect or persist the private key in Encu. A delegated key is preferred only after its exact scope and revocation behavior are verified.

### Revised decision gates

1. Verify deterministic wallet registration challenge, identity derivation and controller ownership on Testnet.
2. Verify deterministic wallet policy read/write/freeze permissions and whether the developer is the controller.
3. Verify `PUT /wallet/v1/api-key` delegate-key semantics, scopes, one-time key retrieval, and DELETE revocation for deterministic wallets.
4. Verify Personal Account Binding from that deterministic executor to a dedicated named developer asset account.
5. Verify binding transfer response, request polling, idempotency and exact inner receipt evidence.
6. Verify wallet connector support for the owner's `UseGlobalContract` setup transaction on mobile.
7. Verify executor gas requirements and safe replenishment.

No wallet was registered, no signature requested, no key generated, no binding or policy changed, and no funds moved during this research.


## OutLayer deterministic-wallet and policy-controller review (2026-11-04)

This review uses the current public Agent Custody, Binding API and Personal Account Binding documentation. It is documentation evidence only; no API request was sent and no wallet, key, binding or policy was created.

### What the current docs establish

- A deterministic wallet identity is derived from `(account_id, seed, vault_or_none)`. Reusing the same tuple resolves to the same wallet; use a unique, namespaced seed for each workspace.
- Deterministic-wallet API authentication uses a raw Ed25519 signature made with a full-access NEAR key on each request. The coordinator stores no authentication credential for this mode. Removing the key revokes access within the documented 60-second cache TTL.
- OutLayer documents deterministic-wallet registration and delegate-key registration from an external NEAR account. A delegate `wk_` key can be created with `PUT /wallet/v1/api-key` and revoked with `DELETE /wallet/v1/api-key/{key_hash}`.
- The developer's full-access private key must remain in the developer's wallet. Encu must never request, receive, persist or log it.
- OutLayer says the wallet owner/controller controls the encrypted on-chain policy; the TEE reads and enforces that policy before signing. Personal Account Binding says the developer's policy is the only spending limit for the bound asset account. No policy means unrestricted spending.
- Personal binding setup remains an owner-signed transaction. The asset account and executor are distinct: the asset account holds the funds; the executor signs and pays gas.
- Binding transfers are contract calls against the asset account. They must use binding-specific endpoints and must not fall back to the executor's plain transfer endpoint.

### What remains unproven

1. The docs do not explicitly demonstrate that a deterministic executor derived from the developer's account is recognized as controlled by that developer for every policy-management operation in a personal-binding setup. The identity derivation and authentication mechanism are documented; the exact policy-controller relationship for this composition still needs vendor confirmation or a Testnet proof.
2. The docs describe delegate keys as sub-agent credentials, but the reviewed API reference does not document granular method/endpoint scopes for them. Until proven otherwise, treat a delegate key as potentially able to invoke the wallet's full API surface, not as a narrowly scoped transfer-only credential.
3. The docs list policy read and dashboard policy editing, but do not provide a complete documented policy-write API contract for this integration. Do not invent an endpoint or assume Encu can configure policy programmatically.
4. The exact policy write authority, approval/freeze authority, delegate-key permissions, and key revocation behavior must be demonstrated for the deterministic wallet used by the binding.
5. The binding docs still do not provide a complete, stable inner-receipt proof schema for reconciling the exact recipient and amount of every binding transfer.

### Security decision

The deterministic-wallet approach is a credible candidate, but it does not yet close the policy-governance gate. It is not sufficient to say "the developer signed registration" and infer that the developer can independently set, inspect, freeze and revoke every permission governing the executor.

Do not build automated workspace provisioning around a delegate key until its permissions and revocation have been verified. Do not enable a personal binding until a restrictive policy is present and its controller is independently established. If policy administration requires the developer to use OutLayer's own dashboard, the product flow must disclose that dependency; if the developer cannot control the executor policy, reject this architecture for the developer-controlled product claim.

### Revised spike acceptance criteria

A disposable Testnet spike must prove, with one developer-owned test account and one isolated workspace:

- Deterministic executor identity is reproducible from the documented account/seed tuple.
- The developer can independently read and change the executor policy and freeze/unfreeze it, with on-chain evidence identifying the controller.
- A delegate key can be issued without disclosing the full-access private key to Encu; enumerate every permitted operation and prove revocation.
- The developer can bind the named asset account, verify active status, and remove the extension without Encu cooperation.
- A binding transfer's final transaction and receipt tree expose enough evidence to prove the exact asset account, recipient and amount.
- Revocation blocks new submissions after the documented cache window; Encu fails closed while binding or policy state is unreadable.

No runtime, database, UI, wallet, credential, policy or deployment changes were made in this review.

Official references:
- https://app.outlayer.ai/docs/agent-custody
- https://app.outlayer.ai/docs/binding-api
- https://app.outlayer.ai/docs/account-binding


## Follow-up against current OutLayer endpoint reference (2026-11-04)

A line-by-line review of the current public pages at `/docs/agent-custody`, `/docs/binding-api` and `/docs/account-binding` sharpens the earlier conclusions.

### Confirmed details

- The binding API explicitly accepts either `Bearer near:<sig>` for a deterministic wallet or `Bearer wk_...` for a randomly-derived wallet. Both identify the same wallet when used as credentials.
- Deterministic wallet registration is documented as `POST /register` with `account_id`, `seed`, `pubkey`, a timestamped registration message and raw Ed25519 signature. The identity is derived from `(account_id, seed, vault_or_none)`.
- The deterministic wallet's NEAR key must be a full-access key. Function-call keys and NEP-413 signatures are not accepted for deterministic API authentication. The private key must remain with the developer.
- OutLayer explicitly documents delegate-key creation for both custody-wallet credentials and external NEAR accounts. For external accounts, the request is authorized by a signature in the request body. The API returns the wallet identity, and the delegate uses a `wk_` Bearer token. DELETE revokes by key hash; a 409 is returned if it is the wallet's last active key.
- The public docs do not state that delegate keys are method-scoped or endpoint-scoped. Treat a delegate as a wallet-level API credential with potentially broad authority until OutLayer proves otherwise. It is not established as a transfer-only key.
- The documented owner controls policy through OutLayer's wallet dashboard, including policy editing, approvers and freeze/unfreeze. The public endpoint table documents `GET /wallet/v1/policy`, but not a corresponding policy-write endpoint. Do not invent one or assume Encu can configure policy through the API.
- OutLayer's personal-binding browser flow accepts a `wk_` key in a URL query parameter. This is a long-lived credential exposure risk if the same key is used by Encu's backend. Do not reuse an Encu backend credential in that URL. Require a separate short-lived/single-use handoff or use a wallet connector that keeps the credential server-side.
- Binding API docs explicitly distinguish executor gas from asset-account funds and confirm that only binding endpoints operate on the asset account. The plain `/wallet/v1/transfer` endpoint spends the executor account and is not a valid fallback.
- Binding setup docs explicitly state that the asset account owner signs a three-action transaction and that most NEAR wallets do not support NEP-591 `UseGlobalContract`; Intear Wallet and near-cli are the documented paths.
- The docs state that one wallet's velocity counters are shared across its HTTPS API and guest-job paths. Encu must treat OutLayer's per-wallet counters as shared provider controls, while its own PostgreSQL ledger remains authoritative for workspace/agent budgets.

### Revised implementation position

The deterministic-wallet + personal-binding composition is better documented than the previous review implied: deterministic registration, external-account delegate-key creation, owner policy dashboard, and personal binding endpoints are all described. However, it is still **not approved for production implementation** because the key permission boundary and policy-controller composition remain unresolved.

A safe test must determine whether the developer can:
1. register a deterministic executor under their own account and remain the policy controller;
2. independently set, inspect and freeze that executor's policy;
3. issue a delegate credential that Encu can use without exposing the full-access key;
4. prove exactly which API operations the delegate can perform, including policy changes, wallet deletion and freeze controls;
5. revoke the delegate and verify access is denied after the documented cache window.

If the delegate can invoke unrestricted wallet operations, it may still be acceptable only if the OutLayer policy makes those operations impossible and the developer retains independent freeze/revocation control. If the developer cannot independently control policy or revoke the credential, reject this design.

This remains documentation-only research. No API request, wallet registration, key issuance, policy change, binding, transaction, database mutation or deployment was performed.

Official references:
- https://app.outlayer.ai/docs/agent-custody
- https://app.outlayer.ai/docs/binding-api
- https://app.outlayer.ai/docs/account-binding


## Release-branch feasibility gate — source verification (2026-11-04)

This section compares the research findings against the actual release branch `agentguard/build-v1`. It is a source-level compatibility check, not a live OutLayer or Testnet integration test.

### Branch relationship

- The research branch `encu/developer-funded-treasuries` is 31 commits ahead of `agentguard/build-v1`, with the V1 head as its merge base and no commits unique to V1 relative to the research branch at the time of comparison.
- The 31-commit difference is documentation/research scope in the comparison result: README changes and three documentation files, plus package metadata. It does not establish implementation of workspace treasuries or Personal Account Binding.
- No research commits have been merged into the release branch by this review.

### Direct source evidence from `agentguard/build-v1`

1. `lib/outlayer.ts` reads one global `OUTLAYER_API_KEY`, `OUTLAYER_NEAR_ADDRESS` and network configuration. Its native transfer function calls only `POST /wallet/v1/transfer`.
2. `lib/execution-provider.ts` exposes `verifyExecutionAccount()` and `submitNativeTransfer()` without a workspace, treasury, asset-account or executor-credential context. The OutLayer adapter verifies one configured address.
3. `app/api/agent/transfer/route.ts` reserves through `reserve_agent_spend`, claims through `claim_agent_auto_submission`, verifies the one global executor and then calls the provider adapter. The provider is selected without resolving an owned workspace treasury.
4. `app/api/agent/reconcile/route.ts` queries NEAR transaction finality using the configured global signer and accepts only a single direct `Transfer` action whose signer, receiver and deposit match the reservation. A Personal Account Binding transfer is a contract-call path; this reconciliation predicate cannot prove the inner asset-account transfer.
5. `scripts/test-reconciliation.mjs` fixtures model direct NEAR Transfer transactions. They do not model binding contract calls, receipt trees, inner transfer effects, bound asset-account identity or binding revocation.
6. `scripts/test-agent-api.mjs` mocks the global executor address and direct transfer integration. It does not establish workspace-specific OutLayer credentials or asset-account routing.

### Feasibility verdict

**The current V1 cannot safely enable Personal Account Binding by configuration alone.** The adapter, request context, ledger lifecycle and finality proof all assume a single executor account and direct transfer action. A binding implementation requires a separately versioned provider and treasury architecture.

The current code does have a useful seam: policy reservation and provider submission are separated behind an `ExecutionProvider` interface. However, the interface must carry an immutable, server-resolved treasury execution context. It must not accept a client-supplied account ID or credential. The reservation must bind to that same treasury identity, and reconciliation must resolve the same immutable binding before it can settle.

### Binding spike: pass/fail protocol

Use a disposable Testnet developer account and a separate disposable executor identity. Do not use the existing operator executor, test Supabase project, production secrets or any account holding meaningful funds.

| Gate | Required evidence | Fail condition |
|---|---|---|
| Developer control | Developer signs the documented setup transaction from the named asset account; chain confirms the expected contract/extension state | Setup can be completed without owner authorization, or the account has an incompatible contract-wallet implementation |
| Binding activation | OutLayer binding status is independently read as `active`; pending/suspended/revoked/unreadable states block spending | Encu enables spending on the basis of a successful setup request or stale cached state |
| Policy authority | Developer can independently inspect, set and freeze the exact executor policy; controller identity and policy state are verified | Controller is ambiguous, policy cannot be made restrictive, or Encu alone can silently weaken it |
| Credential boundary | Encu uses a delegate credential; full-access developer key never reaches Encu; all delegate operations and revocation are enumerated | Delegate can bypass policy/revocation, or its scope cannot be established well enough to accept the risk |
| Revocation | Developer removes the on-chain extension; new submissions fail closed after the documented cache window; provider record cleanup is separately verified | A DELETE API call is mistaken for on-chain revocation, or submissions continue beyond the documented cache window |
| Transfer source | Binding transfer spends only the named asset account; executor gas is accounted separately | Any fallback spends the executor's own account or a different workspace's account |
| Exact reconciliation | Final transaction/receipt evidence proves asset account, recipient and exact amount delivered; ambiguous effects remain `needs_review` | Outer transaction success alone settles the reservation |
| Isolation | A second workspace cannot read, reserve against or submit from the first workspace's treasury/account | Any cross-workspace balance, credential, allocation or reservation path exists |

### Test execution boundary

No Testnet account, executor wallet, API key, delegate key, binding, policy, transaction, database record or deployment was created or changed during this source review. The live spike is not yet run. It requires a disposable developer-owned Testnet account, a compatible signing path (currently documented by OutLayer as Intear Wallet or near-cli), and explicit approval before any wallet provisioning or transaction submission.

### Implementation decision

Do not add Personal Account Binding to the existing V1 adapter or alter the release branch yet. First complete the isolated provider proof above. If policy-controller authority or delegate permissions cannot be proven, stop this path rather than weakening the custody claim. If the proof passes, design a new workspace-scoped treasury migration and binding-aware provider/reconciler as one coordinated feature branch. Keep the existing global operator treasury as an explicitly separate legacy backend until all old reservations and writers are safely accounted for.
