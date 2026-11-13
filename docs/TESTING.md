# Testing and evidence

This document distinguishes automated checks, isolated database tests, and observed Testnet behavior. They are different evidence classes.

## Standard CI workflow

The repository workflow runs:

1. `npm ci`
2. Dependency audit report
3. `npm run lint`
4. `npx tsc --noEmit`
5. `npm run build`
6. `npm run test:agent-api`
7. `npm run test:reconciliation`

The judge-demo PR head `4208f86b34306844898c7ce3ade8841432f0d7a6` passed run [43365687568](https://github.com/BigWave45/Encu/actions/runs/43365687568).

The API suite covers agent authentication and lifecycle, policy enforcement, allocations and limits, recipient authorization, emergency stop, replay handling, provider behavior and related failure paths. The reconciliation suite covers authorization, ownership, missing or unavailable chain data, non-final results, signer/recipient/action/amount mismatches, valid final outcomes and idempotency.

CI uses configured test values and mocked provider/RPC behavior for the relevant suites. A passing test does not prove a live provider transfer or live Testnet finality.

## Separate database concurrency test

Run with:

```bash
npm run test:reservation-concurrency
```

This script is guarded by `AGENTGUARD_TEST_DATABASE=true` and requires a dedicated disposable Supabase project. It tests two concurrent 3 NEAR reservations against a 5 NEAR shared ceiling, expecting exactly one reservation to succeed and the other to be blocked. It also checks replay behavior, ledger/budget consistency and cleanup.

**Never point this script at production or the primary project.** Do not set the safety flag unless the configured database is disposable and explicitly designated for this test. This script is not included in the standard CI workflow.

## Observed NEAR Testnet evidence

### Policy rejection

An attempted transfer by `e2e-verification-agent` was blocked because its autonomous spend allowance was not configured:

```json
{
  "status": "blocked",
  "reason": "autonomous_allowance_exceeded",
  "created": false,
  "agentId": "e2e-verification-agent"
}
```

No reservation was created for that rejected request.

### Successful transfer

After the operator configured a 0.001 NEAR allocation, per-transfer cap, daily limit, weekly limit, autonomous allowance and an active `twat.testnet` recipient authorization, the request returned `needs_review` with `awaiting_onchain_confirmation`.

- Amount: 0.001 NEAR
- Recipient: `twat.testnet`
- Agent: `e2e-verification-agent`
- Request ID: `encu-a56578ea-acf1-4967-a357-0474d86ee65a`
- Provider request ID: `06a7a304-c4f5-4fed-9248-9ef5cf7d0ed5`
- Transaction hash: `Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw`
- Explorer: https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw

The operator invoked Verify finality. The activity record then showed `EXECUTED`. This is an observed Testnet transaction and operator-triggered reconciliation, not a claim that every deployment or every transfer has been independently tested.

## Evidence labels

- **OBSERVED:** behavior reported from the running Testnet prototype.
- **CI PASS:** automated workflow completed successfully on the specified commit.
- **SEPARATE RUN:** dedicated test executed outside the standard CI workflow.
- **PENDING:** not yet executed or not independently verified.

Do not relabel an illustrative demo simulation as a live test. Do not infer finality from a provider acknowledgement or transaction hash alone. Do not retry an ambiguous submission until its recorded status has been investigated.
