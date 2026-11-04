# Encu Developer Guide

This guide explains how a developer creates a workspace, provisions a logical agent, integrates that agent with the transfer API and reconciles its requests. It does not describe independent wallet provisioning: all V1 logical agents use the deployment's shared OutLayer Testnet execution wallet.

## 1. Create a developer workspace

1. Open `/developers`.
2. Create an account or sign in using Supabase Auth.
3. Complete email confirmation if it is enabled for the Supabase project.
4. The workspace uses the authenticated developer identity to scope agent configuration and transaction history.

A developer account is a workspace identity. It is separate from an agent bearer token, the platform administrator credential, the Supabase service-role key and the OutLayer API key.

## 2. Create and configure an agent

Create a logical agent from the developer workspace. Supply a unique agent ID and display name. The create operation returns an agent-scoped bearer token **once**. Copy it immediately and store it in the agent runtime's server-side secret manager. Encu stores the token hash; the original token cannot be retrieved later. Rotating the credential invalidates the previous token.

A new agent starts with **zero allocation**. Before it can spend, configure:
- an allocation within the shared treasury ceiling;
- a per-transfer maximum;
- daily and weekly rolling limits;
- an autonomous spending allowance, if autonomous execution is intended;
- the exact NEAR recipient account IDs the agent is allowed to use.

The developer workspace scopes these operations to agents owned by the authenticated developer account. An agent's allocation is an application-level ledger limit; it is not a separate on-chain wallet balance.

V1 uses one configured OutLayer Testnet wallet and server-side provider credential shared by multiple logical agents. A developer account or agent token does not create a separate custody wallet.

## 3. Credential handling

| Credential | Purpose | Where it belongs |
|---|---|---|
| Developer Supabase session | Authenticates workspace actions | Browser session managed by Supabase Auth; do not use it as an agent token |
| Agent bearer token | Authenticates one logical agent for agent APIs | Agent backend secret manager |
| Administrator token | Platform-wide operator actions | Operator secret manager only |
| Supabase service-role key | Server-side database access | Encu server environment only |
| OutLayer API key | Provider custody/signing API access | Encu server environment only |

Never put the agent token, administrator token, service-role key or OutLayer API key in public source code, browser bundles, client-side logs or an agent prompt. The developer workspace's one-time token display is for copying the credential into your own server-side secret store.

## 4. Transfer request contract

Endpoint:

`POST /api/agent/transfer`

Headers:

```http
Authorization: Bearer <AGENT_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "requestId": "payment-2026-000184",
  "to": "recipient.testnet",
  "amountYocto": "1000000000000000000000",
  "expectedAgentId": "research-agent"
}
```

Fields:

- `requestId`: 8–128 character stable identifier for one logical payment.
- `to`: exact lowercase NEAR account ID. It must already be authorized for the authenticated agent.
- `amountYocto`: positive integer string, maximum 78 digits. One NEAR equals `10^24` yoctoNEAR. Do not use floating-point arithmetic.
- `expectedAgentId`: optional identity assertion. If supplied, it must match the identity derived from the bearer token. It does not select or override the authenticated agent.

Example:

```bash
curl -X POST "$ENCU_BASE_URL/api/agent/transfer" \
  -H "Authorization: Bearer $ENCU_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "payment-2026-000184",
    "to": "recipient.testnet",
    "amountYocto": "1000000000000000000000",
    "expectedAgentId": "research-agent"
  }'
```

The example amount is 0.001 NEAR. Replace the recipient, request ID and expected agent ID with values configured for your environment.

## 5. Response handling and idempotency

The transfer endpoint returns lifecycle states as well as HTTP status codes. Interpret both.

| HTTP status | Response / condition | Meaning and action |
|---|---|---|
| `202` | `needs_review` | The provider outcome or reconciliation is unresolved. Preserve the request ID; check transaction activity and call reconciliation. Do not submit a new payment. |
| `403` | `blocked` | A transfer policy, recipient, allocation, per-transfer limit or emergency-stop rule denied the request. Do not retry unchanged. |
| `409` | `agent_identity_mismatch` | Optional `expectedAgentId` did not match the bearer-token identity. Correct the caller configuration. |
| `409` | `awaiting_approval`, existing lifecycle state or replay | The request did not create a new provider submission. Inspect the existing request in the workspace; do not treat this as an executed transfer. |
| `409` | `idempotency_key_conflict` | The request ID was reused with a different agent, recipient or amount. Resolve the original request before creating a distinct payment. |
| `400` | `invalid_request` | Request body failed schema validation. Correct the fields before retrying. |
| `401` | `unauthorized` | Agent authentication failed. Check the agent credential with the developer/operator. |
| `429` | `rate_limit_exceeded` | Per-agent rate limit reached. Respect `Retry-After`; do not change the request ID. |
| `500` | `reservation_failed` | Reservation persistence failed. Check request activity before attempting recovery. |
| `503` | Provider/authentication/rate-limit dependency unavailable | Treat the outcome conservatively. A 503 before reservation/provider submission differs from a provider timeout represented as `202 needs_review`. Check activity before retrying. |

A repeated request ID does not mean the endpoint will return the original success response. Encu prevents duplicate provider submission; a replay can return HTTP 409 with the existing lifecycle status. Do not blindly retry after a timeout.

## 6. Reconcile a transfer

Reconciliation is a separate API operation. It is not automatically completed in the same HTTP request as transfer submission.

Endpoint:

`POST /api/agent/reconcile`

Request:

```bash
curl -X POST "$ENCU_BASE_URL/api/agent/reconcile" \
  -H "Authorization: Bearer $ENCU_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestId":"payment-2026-000184"}'
```

The authenticated agent can reconcile its own reservation; the platform administrator can reconcile any reservation. The endpoint queries NEAR using the configured execution signer and checks:
- NEAR final execution status is `FINAL`;
- signer matches the configured OutLayer executor account;
- receiver matches the reserved recipient;
- exactly one native transfer action is present;
- the transfer deposit equals the reserved yoctoNEAR amount.

A `200` response with `finality: "FINAL"` and status `executed` or `failed` means the matching transaction was reconciled and the ledger updated. A `202` response means evidence is not yet available or did not match; retain the reservation and investigate. A provider request ID without a transaction hash is not finality evidence.

## 7. Safe integration and testing

- Use NEAR Testnet and a dedicated test agent.
- Confirm allocation, per-transfer cap, rolling limits and autonomous allowance.
- Confirm the exact recipient account is authorized.
- Confirm the shared treasury has sufficient headroom and the emergency-stop state is intended.
- Use the payload builder to inspect request JSON without submitting it.
- Treat `POST /api/agent/transfer` as a potentially value-moving action. It can initiate a real Testnet transfer when policy permits.
- Never use production credentials or a wallet holding valuable assets.

## 8. Related documentation

- [Architecture](ARCHITECTURE.md): component boundaries and request/reconciliation sequence.
- [Security Model](SECURITY_MODEL.md): threat model, evidence and implementation limitations.
- [Demo Runbook](DEMO_RUNBOOK.md): safe demonstration sequence.

**V1 boundary:** developers can manage separate application accounts and logical agent policies. The execution wallet and provider credential remain shared across logical agents.
