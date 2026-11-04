# NEAR HACKATHON 2026 Submission Checklist

**Project:** Encu  
**Primary track:** 06 — AI Security & Defense  
**Repository:** https://github.com/BigWave45/agentguard  
**Submission deadline:** 14 November 2026, 23:59 UTC

Re-check the official [NEAR HACKATHON site](https://nearhackathon.com/) and its current [HACKATHON.md](https://nearhackathon.com/HACKATHON.md) before submitting. The organizer instructions can change.

## Track fit

Track 06 explicitly calls for safeguards such as spending limits, policy engines, sandboxed wallets, reputation and scam detection. Encu's strongest fit is the enforcement of per-agent spending authority, shared treasury limits, recipient authorization, replay protection, emergency stop and finality-aware accounting for AI-agent payments.

Do not claim reputation scoring or scam detection; those are not implemented. The project is an application-level policy and accounting gateway integrated with an OutLayer Testnet wallet, not an independent wallet or on-chain treasury contract.

## Required submission artifacts

- [ ] Public GitHub repository that judges can access.
- [ ] README with reproducible setup, clear test commands, and explicit expected results.
- [ ] Public demo post on X that states the project was built at NEAR HACKATHON.
- [ ] X post tags `@NEARProtocol` and includes `#NEARHackathon`.
- [ ] Demo video or screenshots attached to the X post.
- [ ] Final submission form includes the repository URL and public X demo-post URL.
- [ ] NEAR account address for prize payout is checked carefully in the form.
- [ ] Select every track that genuinely applies; Track 06 is the primary fit.
- [ ] Submit before 14 November 2026, 23:59 UTC.

The official site says one submission per project and requires both the public repository and public demo post. Treat the final form as a one-shot action: verify every field and both links before sending.

## Release gates before publishing the demo

- [ ] Deploy the exact reviewed commit to a public, judge-accessible Preview or demo environment.
- [ ] Confirm the deployment source SHA matches the release commit.
- [ ] Ensure judges can reach the app without an owner-only Vercel SSO wall.
- [ ] Complete sign-in and authenticated developer workspace smoke tests.
- [ ] Verify agent creation, allocation, policy persistence and token handling.
- [ ] Verify recipient authorization and revocation.
- [ ] Verify payload generation and exact yocto conversion.
- [ ] Verify policy denial produces no provider submission.
- [ ] Verify request/transaction/audit views.
- [ ] Verify provider and NEAR finality states are clearly distinguished.
- [ ] If a live transfer is included, confirm the exact Testnet transfer and finality evidence. Do not make a live transfer solely to improve the video if the risk or state is uncertain.
- [ ] Confirm no secrets, API keys, bearer tokens, service-role keys or private data appear in the repository, commit history, screenshots or video.
- [ ] Confirm the README's limitations match the deployed code.
- [ ] Review the final X post and submission payload before publishing.

## Current known blockers

As of 4 November 2026:
- The Request Payload Builder fix is merged into `main` at `ec0b849043e7735ffb0e3e1b6a8043578d42708f`.
- CI passed for the corrected PR #8 head, including lint, type-check, production build, Agent API security/lifecycle tests and NEAR finality reconciliation tests.
- The existing Preview is older than that merge. A new Preview has not been created because Vercel rejected deployment requests under the team's daily deployment limit.
- Full authenticated browser verification against the merged code is outstanding.
- The demo video, public X post and final submission form have not yet been completed.

## Suggested public project description

Encu is a transaction authorization and accounting gateway for AI agents making native NEAR payments. It authenticates logical agents, enforces per-agent allocations and a shared treasury ceiling, authorizes exact recipients, prevents replayed requests, and reconciles submitted transfers against NEAR finality before settling its ledger. The current prototype runs on NEAR Testnet through an OutLayer execution wallet and is not mainnet-ready.
