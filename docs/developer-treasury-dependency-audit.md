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
