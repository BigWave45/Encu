# Encu Demo Runbook

This runbook is designed for a judge who needs to understand what to do and what result to expect. It deliberately separates safe policy demonstrations from a real Testnet transfer.

## Demo objective

Show that multiple independently authenticated logical agents share one treasury ceiling while retaining separate allocations and recipient permissions. Demonstrate that Encu makes the authorization decision before provider submission and does not settle accounting until NEAR finality is verified.

## Environment status

The existing Vercel Preview documented in the README was built before merge commit `ec0b849043e7735ffb0e3e1b6a8043578d42708f`. The payload-builder fix is in `main`, but a Preview built from that commit is pending because Vercel rejected deployment requests under its daily deployment limit.

Do not present the older Preview as the current release candidate. Before recording the final demo, deploy the exact reviewed `main` commit to Preview, confirm the deployment SHA, and complete the browser checks below. Do not use Production for the hackathon demo.

## Pre-demo checks

- Confirm the deployed URL is a READY Preview built from the intended commit.
- Confirm `/developers`, `/admin` and `/api/health` respond as expected.
- Confirm the health response reports the intended Testnet environment and connected dependencies. Do not publish secret values from health or environment output.
- Use only the dedicated Testnet Supabase project and configured Testnet OutLayer wallet.
- Confirm the shared treasury ceiling, agent allocations, per-transfer limits, rolling limits, autonomous allowances and emergency-stop state.
- Confirm the exact Testnet recipient account is authorized for the selected agent.
- Keep agent bearer tokens and provider credentials out of screen recordings. If a token must be shown to demonstrate issuance, use a throwaway test agent and redact the value.

## Suggested judge walkthrough

### 1. Explain the threat

An agent needs to pay a recipient, but an agent credential should not grant unrestricted control over a shared wallet. Encu authenticates each logical agent and enforces both agent-level and treasury-level spending authority.

### 2. Show the developer workspace

Open `/developers` and sign in with a demo developer account.

Expected result: the authenticated workspace loads its own agents, allocations, transactions and audit information. Do not imply that the current V1 is open self-service multi-tenant SaaS or that each developer receives an independent custody wallet.

### 3. Show agent separation

Show two logical agents with separate allocations and policy settings.

Expected result: each agent has its own identity and spending authority, while both remain subject to the same shared treasury ceiling. New agents begin with zero allocation until an administrator assigns authority.

### 4. Show recipient authorization

Open the Recipients view. Show an exact authorized Testnet account for one agent. If using a prepared demo fixture, show that another agent does not inherit that authorization automatically.

Expected result: authorization is scoped to the configured agent and exact account ID. Revocation should prevent a later request from reaching provider submission.

### 5. Show a blocked request

Use a request that violates one configured rule, such as an unlisted recipient, per-transfer limit, agent allocation, rolling limit or emergency stop. Use a fresh request ID for each independent test.

Expected result: the API returns a blocked response with a policy reason and no provider submission. Use the audit/security view to show the recorded event.

### 6. Show payload generation without payment

Open Live Testnet Tools. Select the prepared demo agent, enter the exact authorized Testnet recipient and a small valid NEAR amount, then click **Generate payload** only.

Expected result: a JSON payload appears with:
- `requestId`
- `to`
- `amountYocto`
- `expectedAgentId`

For 0.001 NEAR, the exact yocto amount is `1000000000000000000000`.

Payload generation is local request construction. It does not submit a transfer.

### 7. Explain the submission and settlement boundary

Show the Integration instructions for `POST /api/agent/transfer`. Explain that the agent bearer token is sent server-side in the Authorization header, while the OutLayer API key is never given to the agent.

Explain the lifecycle:
1. Authenticate and validate.
2. Reserve shared treasury and agent exposure atomically.
3. Revalidate policy and recipient before provider submission.
4. Submit through OutLayer.
5. Verify the transaction at NEAR FINAL.
6. Settle the Encu ledger exactly once.

A provider acceptance response is not proof of payment finality.

## Optional live Testnet transfer

A live transfer is optional for the recording. The interface explicitly warns that submission can initiate a real Testnet transfer; it is not a dry run.

Only proceed when the operator has separately approved the exact:
- agent identity,
- recipient account ID,
- amount,
- current allocation and autonomous allowance,
- shared treasury headroom,
- recipient authorization,
- emergency-stop state,
- provider wallet and network.

Before clicking **Submit through ENCU**, reconfirm that the request is intended to move Testnet funds. Never blindly retry after a timeout or ambiguous provider response. Check the request and provider/NEAR status first. If the outcome is uncertain, leave the reservation for reconciliation.

## Recording structure

Target a concise 2–3 minute recording:
1. Problem and product in 15–20 seconds.
2. Agent separation and shared treasury policy in 30–40 seconds.
3. Recipient authorization and one blocked request in 30–40 seconds.
4. Payload generation in 20–30 seconds.
5. Execution/finality architecture and limitations in 20–30 seconds.

Record the actual deployed application, not a static mockup. Capture the relevant response or audit evidence. Avoid showing credentials, environment variables, personal data or unrelated browser tabs.

## Claims to avoid

Do not claim:
- mainnet support or production custody;
- independent wallets or isolated customer treasuries per developer;
- that OutLayer is absent from the custody/signing path;
- that OutLayer enforces Encu's per-agent allocations;
- that a provider response alone proves final settlement;
- that TEE attestation is independently verified by Encu;
- that native NEAR contract execution or NEAR Intents are implemented;
- that every hosted end-to-end workflow has passed when the current merged code has not yet been verified in a fresh Preview.
