# Encu Developer Guide

This guide is for an engineer integrating an AI agent runtime with an Encu deployment. It covers the agent-to-API contract. It does not describe a public self-service wallet or custody onboarding flow.

## 1. Integration model

Your agent sends a transfer request to Encu using an **agent-scoped bearer token**. Encu derives the logical agent identity from that credential and evaluates the request against configured policy.

Before integration, the Encu operator must provide:
- the Encu base URL;
- an agent-scoped bearer token;
- the agent identity associated with that token;
- confirmation that the agent has an allocation and applicable spending limits;
- confirmation that the intended exact NEAR recipient is authorized.

V1 uses one configured OutLayer Testnet wallet and server-side provider credential shared by multiple logical agents. An agent token does not represent a separate custody wallet.

## 2. Credential handling

| Credential | Purpose | Where it belongs |
|---|---|---|
| Agent bearer token | Authenticates one logical agent | Agent backend secret manager |
| Administrator token | Changes platform-wide controls and agent configuration | Operator secret manager only |
| Supabase service-role key | Server-side database access | Encu server environment only |
| OutLayer API key | Provider custody/signing API access | Encu server environment only |

Never place any of these credentials in browser JavaScript, a mobile app bundle, a public repository, client-side logs or an agent prompt. The agent runtime should receive only its own agent-scoped token.

## 3. Transfer request contract

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

- `requestId`: stable identifier for one logical payment. Generate it once and reuse it only when retrying the exact same operation.
- `to`: exact NEAR account ID. It must already be authorized for the authenticated agent.
- `amountYocto`: positive integer string in yoctoNEAR. One NEAR equals `10^24` yoctoNEAR. Do not use floating-point arithmetic.
- `expectedAgentId`: optional assertion. If supplied, it must match the identity derived from the bearer token. It does not select or override the authenticated agent.

Example using curl:

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

## 4. Idempotency and retry rules

Treat a request ID as the idempotency key for one immutable payment instruction.

- Same request ID + same agent + same recipient + same amount: safe identity for a retry of the same logical request.
- Same request ID with a changed recipient or amount: idempotency conflict; create a new logical payment only after resolving the original.
- Never generate a new request ID just because the HTTP response timed out.
- Never blindly retry a request whose provider outcome may be ambiguous.
- Check the request's current Encu/provider/NEAR status before taking recovery action.

## 5. Response handling

Interpret lifecycle responses conservatively:

| Result | Meaning | Client action |
|---|---|---|
| `202 awaiting_approval` | Exposure is reserved; administrator approval is required before autonomous submission | Wait for operator resolution; do not submit directly to OutLayer |
| `202 needs_review` | Provider outcome or reconciliation needs operator review | Do not create a new request or blindly retry |
| `403` | Policy, recipient, allocation, limit or emergency-stop denial | Surface the denial reason; do not retry unchanged |
| `409` | Request ID reused with a changed payload or conflicting lifecycle | Resolve the original request before creating a new payment |
| `429` | Rate limit reached | Back off; preserve the same request identity |
| `401` | Agent authentication failed | Check the agent credential with the operator |
| `503` | Required service/provider dependency unavailable | Treat as unavailable; do not assume no provider action occurred unless the response establishes that |

A successful HTTP response or provider acceptance does not prove that a payment is final. Encu settles its ledger only after matching NEAR FINAL evidence is verified.

## 6. Test safely

- Use NEAR Testnet and a dedicated test agent.
- Confirm the agent allocation, per-transfer cap, rolling limits and autonomous allowance.
- Confirm the exact recipient account is authorized.
- Confirm the global treasury has sufficient headroom and the emergency stop is in the intended state.
- Use payload generation to inspect request JSON without submitting it.
- Treat the actual `POST /api/agent/transfer` call as a potentially value-moving action. It can initiate a real Testnet transfer when policy permits.
- Never use production credentials or a valuable wallet while testing.

## 7. Operational references

- [Architecture](ARCHITECTURE.md): request and settlement flow.
- [Security Model](SECURITY_MODEL.md): threat model and implementation boundaries.
- [Demo Runbook](DEMO_RUNBOOK.md): safe demonstration sequence.

**V1 limitation:** this integration is for logical agents sharing one operator-configured OutLayer Testnet execution wallet. It is not an independent wallet or treasury for each developer.
