# Judge guide

## Start here

Open the public `/judge-demo` route when a publicly accessible deployment URL is available. It is designed as a no-sign-in overview. The authenticated developer workspace is separate.

**Access status:** the route is present in the merged release branch. Do not assume a deployment-specific Vercel Preview URL is publicly accessible; anonymous access to the stable production domain remains to be verified.

## Suggested review sequence

1. Read the opening statement: ENCU is an application-level authorization and accounting gateway for autonomous native NEAR transfers.
2. Review the control path: authenticate agent, evaluate policy, reserve budget, submit through OutLayer, then verify transaction finality through NEAR RPC.
3. Use the shared-budget walkthrough. It models two logical agents requesting 3 NEAR each against a 5 NEAR ceiling. One reservation is accepted and the other is blocked in the illustrative scenario.
4. Inspect the evidence section for the real Testnet rejection and transfer.
5. Expand the request lifecycle and inspect the responsibility split between ENCU/Supabase, OutLayer and NEAR RPC.
6. Read the prototype limitations before evaluating deployment or custody claims.

## Important distinction: simulation versus system evidence

The interactive shared-budget widget on the judge page is deterministic client-side teaching logic. It does not call the API, connect to Supabase, race live requests, or submit a transfer.

The separate `npm run test:reservation-concurrency` script exercises the database reservation invariant against a dedicated disposable Supabase project. It must not be run against production or the primary project. This script is separate from the standard CI workflow.

## Real Testnet evidence

### Policy rejection

The first request from `e2e-verification-agent` was blocked because no autonomous spending allowance was configured:

- `status: blocked`
- `reason: autonomous_allowance_exceeded`
- `created: false`

The request was rejected before a reservation was created.

### Transfer and reconciliation

A later 0.001 NEAR transfer to `twat.testnet` was submitted through OutLayer. The API initially returned `needs_review` and `awaiting_onchain_confirmation`. The operator triggered Verify finality. The activity record subsequently showed `EXECUTED`.

Transaction hash: `Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw`

Explorer: https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw

The hash by itself is not the settlement proof. The application reconciliation path requests NEAR transaction data at FINAL and checks signer, recipient, single action and exact amount before settling the ledger.

## What is implemented versus planned

Implemented: one OutLayer Testnet execution provider; native NEAR transfers; application/database spending policy and accounting; logical agent credentials; recipient controls; request replay protection; emergency stop; NEAR RPC reconciliation.

Not implemented: native NEAR treasury contract, independent on-chain per-agent wallets, isolated customer custody, mainnet readiness, additional execution providers, full multi-tenant treasury segregation or external security audit.

## CI evidence

The judge-demo PR head `4208f86b34306844898c7ce3ade8841432f0d7a6` passed CI run https://github.com/BigWave45/Encu/actions/runs/43365687568. The workflow included dependency installation/audit, lint, TypeScript, production build, API security/lifecycle tests and NEAR finality tests. These automated checks are not a live transfer and do not constitute an independent security audit.
