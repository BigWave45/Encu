# ENCU — Release handoff (authoritative, 2026-11-04)

This section supersedes older handoff notes below where they conflict. The older notes are retained as historical context and must not be treated as current branch or release status.

## Current release state

- Product: **ENCU**. Internal repository and implementation identifiers may retain AgentGuard.
- Repository: `BigWave45/agentguard`.
- Active release branch: `agentguard/build-v1`.
- Current release head at this handoff: `d2d7b678b41dadc657fc00fcfa1b3f4e86f4ccc7`.
- Dashboard reconciliation PR #6 has been merged into `agentguard/build-v1`. Do not merge the superseded dashboard PR #5 or PR #3.
- GitHub Actions CI passed on the merged V1 commit `b8ab7cd526cab00b965198d6bee7d96c5921c7ed` (run [41802232635](https://github.com/BigWave45/agentguard/actions/runs/41802232635)).
- The judge-facing security architecture document was added at [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md). CI also passed on the documentation commit `d2d7b678b41dadc657fc00fcfa1b3f4e86f4ccc7` (run [41890660132](https://github.com/BigWave45/agentguard/actions/runs/41890660132)).
- A Vercel Preview rate-limit failure has blocked fresh browser verification. Do not repeatedly trigger deployments while the provider rate limit is active. Recheck Vercel status before attempting a new Preview.
- No current-head browser E2E pass is claimed. Automated CI does not prove a live OutLayer transfer or NEAR Testnet settlement.

## V1 scope and honest product claims

ENCU is an application-level authorization and transaction-control layer for AI agents making native NEAR transfers. It authenticates logical agents, evaluates spending and recipient policies, reserves budget, gates provider submission, and reconciles execution against NEAR finality.

V1 is a **single-operator NEAR Testnet prototype**. Multiple logical agents use one operator-configured OutLayer execution wallet and one server-side OutLayer API credential. The shared treasury ceiling and per-agent allocations are enforced in the application/database ledger. They are not separate on-chain wallets or independently funded customer treasuries.

Current scope includes developer workspace and agent management, agent-scoped credentials, allocations and policy configuration, recipient authorization/revocation, transfer request tooling, transaction activity, audit/security views, and execution explainers. OutLayer is the only implemented execution provider.

Do not describe V1 as mainnet-ready, a production custody service, a fully multi-tenant SaaS, or a system with isolated developer-funded treasuries. Customer wallet provisioning, isolated custody, deposits/withdrawals, billing, a native NEAR treasury contract, and additional execution providers are future work.

## Security and verification

Read [the V1 Security Architecture](docs/SECURITY_ARCHITECTURE.md) for the trust boundaries, credential handling, shared-budget controls, atomic reservations, replay protection, submission revalidation, emergency stop, provider verification, finality reconciliation, and known limitations.

CI currently validates dependency installation/audit, lint, TypeScript, production build, and the configured API/security/lifecycle and NEAR finality tests. It does not replace:
- Browser verification of signup/sign-in, workspace navigation, agent creation/configuration, credential handling, recipient controls, audit feed, and request lifecycle.
- A fresh end-to-end Testnet demonstration on the current Preview.
- Explicit confirmation before initiating any real Testnet transfer.

A provider timeout or ambiguous submission must be investigated before any retry. Never infer payment or finality from request receipt or a provider acknowledgement alone.

## Immediate release sequence

1. Recheck Vercel Preview availability after the rate limit clears.
2. Deploy only a Preview from `agentguard/build-v1`; do not deploy Production.
3. Browser-test the complete developer workflow and record defects.
4. Fix only verified release blockers, rerun CI, and retest.
5. Conduct the final Testnet demo only after the user explicitly approves the transfer.
6. Prepare the demo recording, public demo post, and hackathon submission.

Do not merge to `main`, deploy Production, modify Supabase environments, delete branches, force-push, or initiate a live Testnet transfer without explicit user approval. Keep work focused on release verification and submission; do not reopen deferred custody architecture or add unrelated features.

---

