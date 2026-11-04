# Encu Demonstration Guide

## 1. Demonstration objective

This demonstration shows how Encu controls payment authority for multiple AI agents that use one shared NEAR execution wallet.

The walkthrough establishes four observable properties:

1. Each logical agent is authenticated independently.
2. Each agent is constrained by its own allocation and policy, while all agents remain subject to a shared treasury ceiling.
3. Recipient authorization and spending rules are evaluated before a transfer can be submitted to the execution provider.
4. A submitted transfer is not treated as settled until a separate reconciliation operation verifies the matching transaction at NEAR finality.

The standard demonstration uses policy denials and payload generation. A live Testnet transfer is optional and requires explicit operator authorization.

## 2. Scope and environment

The current release is a NEAR Testnet prototype. Multiple logical agents use one configured OutLayer wallet and one server-side provider credential. Agent identities and allocations are application-level controls; they are not separate custody wallets.

Use a dedicated demo developer account, dedicated Testnet Supabase project, and configured OutLayer Testnet wallet. Do not use production credentials or a wallet holding valuable assets.

The deployed application must be a READY Preview built from the exact commit selected for the demonstration. Verify the deployment commit before recording. A previously available Preview must not be represented as the latest release if it predates the selected commit.

Required routes:
- `/developers`: developer workspace and agent management.
- `/admin`: operator controls and shared treasury configuration, available only to authorized administrators.
- `/api/health`: dependency health information. Inspect privately and do not expose secrets or sensitive configuration in the recording.

## 3. Preparation

Complete these checks before the recording:

- Sign in to the demo developer workspace and confirm it loads the intended developer-owned agents.
- Confirm two prepared logical agents exist, for example Alpha and Beta.
- Confirm both agents have distinct allocations and policy settings.
- Confirm new-agent allocation behavior is understood: newly provisioned agents start with zero allocation.
- Confirm one exact Testnet recipient is authorized for the selected demonstration agent.
- Confirm the shared treasury ceiling, spent and reserved balances, per-transfer limits, rolling limits, autonomous allowances and emergency-stop state.
- Confirm the selected blocked-request scenario will fail for the intended reason and will not reach provider submission.
- Confirm the browser contains no visible credentials, private account information, environment variables or unrelated tabs.
- Use fresh request IDs for each independent request test.

Do not change treasury balances, allocations, recipient permissions or emergency-stop state during the recording unless the demonstration specifically requires that change and the operator has approved it.

## 4. Demonstration procedure

### Step 1: Introduce the control problem

**Action:** Open the Encu application.

**Presenter explanation:** An agent credential should authorize a defined set of payment actions, not unrestricted use of a shared wallet. Encu provides an application-level authorization and accounting layer between agent runtimes and the configured execution provider.

**Evidence:** The product interface and the architecture diagram in the repository.

### Step 2: Establish the developer and agent identities

**Action:** Open `/developers` and sign in with the prepared demo developer account. Open the agent list.

**Expected result:** The workspace displays agents owned by the authenticated developer account. Each logical agent has its own identity and policy configuration.

**Presenter explanation:** The developer account is used to manage logical agents. An agent bearer token authenticates one logical agent at the API boundary. Neither identity creates an independent custody wallet in V1.

### Step 3: Compare agent authority

**Action:** Display Alpha and Beta. Show their allocations and configured per-transfer and rolling limits.

**Expected result:** The agents have distinct application-level allocations and policy settings. Their combined exposure remains bounded by the shared treasury ceiling.

**Presenter explanation:** A request must satisfy both the agent's own authority and the global treasury constraints. Creating an agent does not grant it spending authority; its allocation begins at zero until configured.

### Step 4: Demonstrate recipient authorization

**Action:** Open the recipient authorization view. Display the exact Testnet account authorized for Alpha. If the prepared fixture includes a second agent without that recipient, compare the two agent configurations.

**Expected result:** Recipient authorization is scoped to the configured logical agent. A recipient permission granted to one agent is not automatically inherited by another.

**Presenter explanation:** Authorization is based on the exact NEAR account ID, not a free-form label or an agent's assertion in the request body.

### Step 5: Demonstrate a policy denial

**Action:** Submit or invoke a prepared request that violates exactly one known rule. Prefer an unauthorized recipient or an amount above the selected agent's allocation. Use a fresh request ID.

**Expected result:** The request is denied with a policy reason. The corresponding audit or security event is visible. A policy denial must occur before provider submission.

**Evidence to capture:** The request result and its matching audit/security event. Do not infer a denial reason from a generic error message; capture the actual returned reason.

**Presenter explanation:** The policy decision is made by Encu before the provider is called. The provider is not responsible for enforcing Encu's per-agent allocation ledger.

### Step 6: Generate a transfer payload without submitting it

**Action:** Open Live Testnet Tools. Select the prepared agent, enter its exact authorized Testnet recipient, enter `0.001` NEAR, and select **Generate payload**. Do not select Submit.

**Expected result:** The builder displays a JSON request containing:
- `requestId`
- `to`
- `amountYocto`
- `expectedAgentId`

For 0.001 NEAR, `amountYocto` must equal `1000000000000000000000`.

**Presenter explanation:** Payload generation constructs request data in the browser. It does not authenticate an agent request, reserve treasury funds, call OutLayer or initiate a transfer.

### Step 7: Explain submission and settlement

**Action:** Display the developer integration instructions and the separate transfer and reconciliation endpoints.

**Presenter explanation:** An agent sends its bearer token to `POST /api/agent/transfer`. Encu authenticates the token, checks policy and atomically reserves exposure before allowing provider submission. The provider response is not treated as proof of payment. The agent or operator then calls `POST /api/agent/reconcile` with the same request ID. Encu checks NEAR transaction evidence, including finality, signer, receiver, transfer action and exact amount, before settling the ledger.

**Evidence:** The API contract in the Developer Guide and the lifecycle sequence in the Architecture document.

## 5. Optional live Testnet transfer

A live transfer is not required for the standard demonstration. The interface warns that submission can initiate a real Testnet transfer; it is not a dry run.

Proceed only after the operator explicitly approves the exact agent, recipient account ID, amount and intended Testnet execution. Immediately before submission, verify:

- the selected agent identity and active credential;
- the exact recipient account ID and its authorization;
- the amount and its yoctoNEAR conversion;
- the agent allocation and remaining autonomous allowance;
- the shared treasury's available headroom;
- per-transfer and rolling limits;
- emergency-stop state;
- the configured OutLayer wallet and Testnet network.

After submission, record the request ID and any provider reference or transaction hash. Reconcile using the same request ID. Confirm NEAR finality and the exact signer, receiver and amount before describing the payment as executed.

If the provider response is ambiguous, a timeout occurs, or no transaction hash is available, do not submit a new request as a retry. Inspect the existing request and provider status, then use the reconciliation workflow. Preserve unresolved reservations for investigation.

## 6. Recording guidance

A concise recording can follow this sequence:

| Segment | Suggested duration | Evidence |
|---|---:|---|
| Problem and Encu's role | 15–20 seconds | Application overview |
| Agent identities and allocations | 30–40 seconds | Two logical agents and shared ceiling |
| Recipient authorization and denial | 30–40 seconds | Exact recipient rule and actual denial |
| Payload generation | 20–30 seconds | Generated JSON, with no submission |
| Submission and finality model | 20–30 seconds | Separate API endpoints and lifecycle diagram |

Record the actual application and actual responses. Do not substitute a static mockup for a working feature. Do not display credentials, tokens, environment variables, private user data or unrelated browser content.

## 7. Troubleshooting

| Symptom | Response |
|---|---|
| Developer workspace does not load | Stop the recording. Verify Preview deployment, Supabase Auth configuration and browser network errors. Do not expose service credentials while diagnosing. |
| Agent list is empty | Confirm the signed-in developer account owns the prepared agents. Do not create or reassign production data during the recording. |
| Request is denied for an unexpected reason | Stop and inspect the agent policy, recipient permission, allocation, rolling limits, treasury headroom and emergency-stop state. Do not repeatedly submit requests with new IDs to search for a passing configuration. |
| Payload builder does not generate JSON | Stop the recording and verify the deployed commit includes the payload-builder fix. Do not imply payload generation succeeded if no payload is displayed. |
| Transfer returns `awaiting_approval` | Treat it as an approval-gated request. It is not an executed transfer. Use the authorized approval workflow. |
| Transfer returns `needs_review` | Preserve the request ID and reservation. Inspect provider status and use reconciliation. Do not blindly resubmit. |
| Reconciliation remains pending | Keep the reservation unresolved until valid NEAR evidence is available. A provider request ID alone is not finality evidence. |

## 8. Accurate product claims

The demonstration may claim that V1 provides agent-scoped authentication, application-level allocations, a shared treasury ceiling, recipient authorization, atomic reservations, replay protection, emergency stop, approval handling, audit events and NEAR finality reconciliation, subject to the evidence captured for the selected build.

Do not claim:
- mainnet support or production custody;
- a separate custody wallet for each developer or logical agent;
- multiple implemented execution providers;
- a native NEAR treasury contract or NEAR Intents integration;
- that Encu independently verifies transfer-bound TEE attestations;
- that OutLayer's provider policy is the source of Encu's per-agent allocations;
- that provider acceptance alone proves payment finality;
- that a hosted workflow passed unless it was tested against the exact deployed commit.

## 9. Related technical documentation

- [Developer Guide](DEVELOPER_GUIDE.md): workspace setup, credentials, transfer API and reconciliation.
- [Architecture](ARCHITECTURE.md): current implementation, lifecycle and target integration boundaries.
- [Security Model](SECURITY_MODEL.md): assets, threats, mitigations and limitations.
- [Product Roadmap](ROADMAP.md): implemented V1, planned integrations and longer-term direction.
