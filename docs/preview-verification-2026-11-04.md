# ENCU Preview Deployment Verification — 2026-11-04

## Deployment

- Vercel project: `agentguard`
- Deployment ID: `dpl_5ce1uq4aHWiVHgTAT2GDpHAnB7zr`
- Preview URL: https://agentguard-t8q8sxmu9-resonances-projects-13e560cd.vercel.app
- State: READY
- Exact source commit: `6bd7603e1aa677c2e8f355edab0084d3f07e2d4d` (current `main` at verification time)
- Vercel Git reference: `agentguard/build-v1`
- Target: Preview

The Preview was created from the exact `main` commit SHA while using the existing allowlisted `agentguard/build-v1` Git reference to satisfy the project's ignored-build rule. No Git branch was changed or rewritten. No Vercel project settings were changed. No Production deployment was initiated.

## Ignored-build rule

The project's Ignored Build Step permits:
- `agentguard/build-v1`
- `encu/editorial-light-diagrams`
- `encu/submission-integration`

It returns exit code 0 for other refs, including `main`, which tells Vercel to skip/cancel those deployments. A direct `main` deployment was classified as Production and cancelled by this rule. Do not add `main` to the allowlist without explicitly reviewing Production branch behavior.

## Read-only HTTP verification

Checks against the READY Preview URL:

- `GET /developers`: HTTP 200. Developer account creation/sign-in entry is server-rendered.
- `GET /admin`: HTTP 200. Operator console, credential entry, treasury workspace and first-time agent setup are server-rendered.
- `GET /api/health`: HTTP 200. Response reported status `ok`, Supabase `connected`, budget `configured`, network `testnet`, NEAR RPC `connected`, OutLayer `connected`, signer match `true`.

These are server-response checks, not a full interactive browser walkthrough. No account was created, no credentials submitted, no admin or agent mutation performed, and no Testnet transfer initiated.

## Build observations

The deployment reached READY and the Next.js production build completed. Build emitted a non-fatal Autoprefixer warning in `app/developers/dashboard-workflow.css` about mixed support for `end` and suggested `flex-end`. npm also emitted non-fatal environment-config and install-script allowlist warnings. These did not block deployment.

## Remaining verification

1. Complete interactive browser testing: developer signup/sign-in, agent creation and one-time token display, allocation/policy setup, recipient authorization, request lifecycle, approvals/review, audit/reconciliation, and responsive layouts.
2. Start with safe or blocked test cases. No live Testnet transfer without explicit approval.
3. CI run #1107 for exact `main` commit `6bd7603e1aa677c2e8f355edab0084d3f07e2d4d` was queued when checked. Verify its final conclusion before treating this documentation commit as CI-validated.
4. Production deployment remains gated by explicit user approval.

## Release status

Source integration is complete. A current Preview deployment is READY and its key server-rendered routes and integration health endpoint respond successfully. Full interactive browser verification and hackathon submission remain incomplete.
