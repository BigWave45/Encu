# ENCU — Hackathon submission brief

## Project

**ENCU: policy-controlled payments for autonomous agents on NEAR**

Track: **06 — AI Security & Defense**

Repository: https://github.com/BigWave45/agentguard

Judge experience: `/judge-demo` (route merged into `agentguard/build-v1`; anonymous production URL pending independent verification).

## Problem

An autonomous agent may need to initiate payments, but possession of a valid wallet or API credential does not express the intended limits of its authority. In a shared-wallet setup, multiple agents can also compete for the same remaining funds. Independent preflight balance checks are insufficient: two requests can each observe the same available amount and collectively oversubscribe it. A provider acknowledgement or transaction hash also does not establish that the intended transfer reached finality.

## What ENCU implements

ENCU places an application-level authorization and accounting gateway between logical agents and a configured NEAR execution provider.

- Agent-scoped bearer authentication.
- Shared treasury ceiling with per-agent allocations.
- Per-transfer, daily, weekly and autonomous-spend limits.
- Exact NEAR recipient allowlists, expiry and revocation.
- Atomic reservations before provider submission.
- Stable request IDs and replay/idempotency protection.
- Emergency stop and policy revalidation before submission.
- Provider submission tracking and independent NEAR finality reconciliation.
- Audit/security events and developer workspace tooling.

## Why NEAR

The current product path is native NEAR transfer execution on NEAR Testnet. OutLayer submits the transfer from the configured NEAR execution wallet. ENCU then queries NEAR RPC for final transaction data and checks finality, signer, receiver, single transfer action and exact deposit amount before settling its ledger. NEAR is the execution and verification environment for the implemented workflow.

## Architecture and trust boundaries

| Layer | Responsibility |
| --- | --- |
| ENCU | Authenticates logical agents, evaluates policy, reserves authority, controls submission and records lifecycle state |
| Supabase / PostgreSQL | Stores agent/policy records, serializes budget reservations, maintains spend accounting and audit data |
| OutLayer | Holds the configured shared Testnet execution wallet capability and submits native NEAR transfers |
| NEAR RPC | Supplies transaction execution data for independent finality and transfer-field checks |

The OutLayer credential is server-side and shared by the configured V1 execution wallet. It is not distributed to agents.

## Demonstrated evidence

1. **Policy rejection on Testnet:** a request from `e2e-verification-agent` without autonomous spend allowance was blocked with `autonomous_allowance_exceeded`; `created: false`. No reservation was created.
2. **Successful Testnet transfer:** 0.001 NEAR to `twat.testnet`. The request returned `needs_review` with `awaiting_onchain_confirmation`; the operator then used Verify finality and the activity record changed to `EXECUTED`.
3. **Explorer record:** https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw
4. **Automated verification:** CI run https://github.com/BigWave45/Encu/actions/runs/43365687568 passed on the judge-demo PR head. It included dependency install/audit, lint, TypeScript, production build, agent API security/lifecycle tests and NEAR finality tests.
5. **Concurrency:** a separate script tests competing reservations against a dedicated disposable Supabase database. It is not part of the CI workflow. The public-page scenario is a local illustration, not this database test.

## What judges can inspect

The `/judge-demo` page presents the problem, request lifecycle, local shared-budget simulation, verified Testnet evidence, architecture, NEAR rationale, intended users and explicit prototype limitations. The simulation never submits a transaction. The authenticated developer workspace is a separate product flow and requires a developer account.

## Intended users

- Developers building agents that need bounded NEAR payment authority.
- Operators managing several logical agents through one execution wallet.
- Teams that need a policy and accounting layer between autonomous workloads and transfer execution.

## Differentiation

The core contribution is the enforced lifecycle connecting identity and policy to atomic reservation, provider submission and independent chain finality checks. The project is not claiming that bearer tokens, spending limits or dashboards are individually novel. Its focus is joining pre-execution authority controls to post-execution evidence in one request path.

## Limitations

This is a single-operator NEAR Testnet prototype. Multiple logical agents share one operator-configured OutLayer execution wallet and one server-side provider credential. The global ceiling and agent allocations are application/database controls, not independent on-chain treasuries.

ENCU is not mainnet-ready, an independently audited custody service, a fully multi-tenant SaaS, or a native NEAR treasury contract. Customer wallet provisioning, isolated custody, deposits/withdrawals, billing and additional execution providers are not implemented. OutLayer is the only implemented execution provider. Automated CI tests do not prove live chain execution.

## Submission links

- Source: https://github.com/BigWave45/agentguard
- Judge route: `/judge-demo` on the release deployment. Add the final public URL only after confirming anonymous access without Vercel team membership.
- Testnet transaction: https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw
