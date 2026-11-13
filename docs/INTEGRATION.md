# Agent integration guide

## Integration model

An agent calls the ENCU transfer API using its own bearer credential. Keep that credential in the agent's server-side secret manager or runtime environment. Do not embed it in browser code, public repositories, client applications or logs.

The current integration is for native NEAR transfers on the configured Testnet execution path. It is not a dry run: an authorized request can initiate a real Testnet transfer.

## Endpoint

`POST /api/agent/transfer`

Headers:

```http
Authorization: Bearer <AGENT_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "requestId": "order-2026-000001",
  "to": "recipient.testnet",
  "amountYocto": "1000000000000000000000000",
  "expectedAgentId": "payments-agent"
}
```

Fields:

- `requestId`: stable identifier for this logical payment attempt, 8–128 characters. Reuse it only for an exact retry of the same request.
- `to`: exact NEAR account ID. It must also be authorized by the active recipient policy.
- `amountYocto`: positive integer amount expressed as a decimal string in yoctoNEAR. Use a string to preserve integer precision.
- `expectedAgentId`: optional identity assertion. If supplied, it must match the agent identified by the bearer credential.

Example server-side request:

```bash
curl -X POST "$ENCU_BASE_URL/api/agent/transfer" \
  -H "Authorization: Bearer $ENCU_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"requestId":"order-2026-000001","to":"recipient.testnet","amountYocto":"1000000000000000000000000","expectedAgentId":"payments-agent"}'
```

Use a unique request ID per new payment. If the response is ambiguous, query the recorded activity and reconcile before retrying. Never generate a new request ID merely to bypass an uncertain result.

## Authorization path

ENCU authenticates the agent, validates the request, applies rate and transfer caps, and asks the database to reserve spend against the shared treasury and the agent's allocation. A newly created, authorized reservation is revalidated and claimed before OutLayer submission. Existing reservations and replayed requests do not create another provider submission.

The request must satisfy the configured global ceiling, agent allocation, per-transfer and rolling limits, autonomous allowance, active-agent state, recipient authorization and emergency-stop state.

## Response handling

Treat response status as lifecycle information, not as a generic payment-success boolean.

- `blocked`: a policy or authorization rule denied the request. Inspect `reason`; do not assume funds moved.
- `needs_review` / HTTP 202: provider or chain outcome requires reconciliation. Do not retry blindly.
- `executed`: the ledger has been settled after the reconciliation path accepted final NEAR evidence.
- `failed`: a final transaction outcome was verified as failed and recorded.
- HTTP 400: invalid request.
- HTTP 401: missing or invalid agent credential.
- HTTP 403: policy denial, including transfer cap or recipient/allowance restrictions.
- HTTP 409: identity assertion or idempotency conflict / already-processed request.
- HTTP 429: rate limit exceeded; honor the `Retry-After` header where present.
- HTTP 503: authentication, rate-limit store, provider configuration or another required dependency is unavailable.
- HTTP 500: reservation or internal failure; inspect activity before attempting any retry.

Exact response bodies may vary by failure path. Use the API response and persisted activity as the authority for the individual request.

## Finality reconciliation

The developer workspace exposes a Verify finality action for eligible requests. The reconciliation route checks ownership for developer sessions and rate-limits reconciliation. When a transaction hash exists, it asks NEAR RPC for the transaction at `FINAL`, then verifies:

- signer matches the configured OutLayer NEAR account;
- receiver matches the reserved recipient;
- exactly one action exists and it is a Transfer;
- transfer deposit matches the reserved yoctoNEAR amount;
- final execution status is `FINAL`.

Only a matching final outcome can settle the ledger. Missing chain data, non-final execution or mismatched fields remains in `needs_review`.

## Operational safety

- Never expose agent tokens or OutLayer credentials to a browser.
- Never treat API acceptance, provider acknowledgement or a transaction hash alone as proof of settlement.
- Do not retry an ambiguous provider submission until activity and chain state have been checked.
- Do not use Testnet examples as mainnet configuration.
- The current implementation has one OutLayer execution provider and one operator-configured shared wallet. Per-agent allocations are application/database controls, not separate wallets.
