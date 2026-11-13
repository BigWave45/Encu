# ENCU

**Policy-controlled payments for autonomous agents on NEAR.**

ENCU is an application-level authorization and accounting gateway for agent-initiated native NEAR transfers. It authenticates each logical agent, checks spending and recipient policy, reserves budget before provider submission, and reconciles the resulting transaction against NEAR finality before settling its ledger.

ENCU is built for operators who need multiple autonomous agents to request payments without giving every agent unrestricted authority over a shared execution wallet.

## Judge demo

The public, no-sign-in judge experience is implemented at `/judge-demo`.

- It explains the problem, transaction lifecycle, architecture, NEAR integration, intended users and current limitations.
- Its shared-budget walkthrough is an interactive **local simulation**. It does not call the API, mutate the database or submit a transfer.
- It includes a separately identified real NEAR Testnet transaction and an observed policy rejection.

**Deployment note:** the route exists in the merged release branch, but an anonymous-access production URL has not yet been verified. Do not treat a Vercel Preview URL as a public judge link. The stable URL should be added here only after it has been tested without Vercel team access.

## What ENCU does

1. **Authenticate agents independently.** Each logical agent uses its own bearer credential; agent credentials do not grant administrator access.
2. **Enforce spending authority.** Apply a shared treasury ceiling, per-agent allocations, per-transfer and rolling limits, and an autonomous-spend allowance.
3. **Constrain recipients.** Only active, authorized NEAR account IDs can receive transfers.
4. **Reserve before execution.** Atomic database reservations prevent concurrent requests from committing the same remaining budget.
5. **Protect request identity.** Stable request IDs prevent duplicate submissions; changing the payload under an existing ID is rejected.
6. **Revalidate before submission.** Current policy, agent state and recipient authorization are checked again before the provider call.
7. **Verify settlement independently.** NEAR RPC finality and transaction fields are checked before the ledger records execution or failure.

## Why NEAR

NEAR is the network ENCU executes and verifies against. The current implementation submits native NEAR transfers through an OutLayer Testnet wallet and uses NEAR RPC to verify final execution status, signer, recipient, action and exact amount. NEAR is therefore part of the actual transaction lifecycle, not a generic chain selector or a decorative integration.

## Architecture

| Component | Responsibility |
| --- | --- |
| ENCU application | Agent authentication, policy evaluation, request lifecycle and operator/developer workflows |
| Supabase / PostgreSQL | Agent records, policy, atomic reservations, spend ledger and audit events |
| OutLayer Testnet | Configured shared execution wallet, signing and native NEAR transfer submission |
| NEAR RPC | Independent transaction lookup and finality verification |

OutLayer is the only implemented execution provider. The provider interface is an extension point, not evidence that other providers are currently supported.

## Current prototype boundary

ENCU V1 is a **single-operator NEAR Testnet prototype**. Multiple logical agents share one operator-configured OutLayer execution wallet and one server-side provider credential. The shared treasury ceiling and per-agent allocations are enforced by the application/database ledger. They are not separate on-chain wallets or independently funded customer treasuries.

ENCU is not mainnet-ready, a production custody service, a fully multi-tenant SaaS, an independently audited system, or a native on-chain treasury contract. It does not currently provide isolated customer custody, deposits or withdrawals, billing, multiple execution providers, or separate per-agent wallets.

## Evidence

- **Observed Testnet policy rejection:** a request without autonomous spending allowance was blocked with `autonomous_allowance_exceeded`; `created: false`, so no reservation was created.
- **Observed Testnet transfer:** 0.001 NEAR to `twat.testnet`, requested by `e2e-verification-agent`. The request first returned `needs_review`; after the operator used Verify finality, the activity record showed `EXECUTED`.
- **Transaction:** [View on NEAR Testnet explorer](https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw).
- **Automated CI:** the judge-demo PR head `4208f86b34306844898c7ce3ade8841432f0d7a6` passed the workflow in [run 43365687568](https://github.com/BigWave45/Encu/actions/runs/43365687568). The run covered dependency install/audit, lint, TypeScript, production build, agent API security/lifecycle tests and NEAR finality tests. This is not a live transfer test.
- **Separate concurrency test:** the disposable-database script has been run separately; it is not part of CI. See [Testing](docs/TESTING.md).

## Documentation

- [Hackathon submission brief](HACKATHON.md)
- [Judge guide](docs/JUDGE_GUIDE.md)
- [Integration guide](docs/INTEGRATION.md)
- [Testing and evidence](docs/TESTING.md)
- [Security architecture and limitations](docs/SECURITY_ARCHITECTURE.md)

## Run locally

Requirements: Node.js 22 and the environment variables required by the application.

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run build
npm run test:agent-api
npm run test:reconciliation
```

Do not run the reservation-concurrency script against a production or shared database. It requires an explicitly designated disposable Supabase test project and the safety flag described in [Testing](docs/TESTING.md).

## Repository

The GitHub repository retains the internal AgentGuard identifier in its URL and code. The product name is **ENCU**.
