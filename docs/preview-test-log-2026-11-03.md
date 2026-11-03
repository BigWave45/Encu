# ENCU V1 preview verification log

Date: 2026-11-03  
Branch: `agentguard/build-v1`  
Preview commit under test: `12cd3f8b32f79c96a595e2cce5ba02aac2fd4e11`  
Environment: Vercel Preview with the isolated AgentGuard Test Supabase project. This is not Production.

## Verified

- Preview deployment reached READY.
- Production build and TypeScript checks passed for the deployed commit.
- A user completed sign-in successfully in the Preview.

Sign-in verification does not by itself establish that sign-out, session expiry, account isolation, agent provisioning, or protected dashboard actions work.

## Open issue: Agent ID field validation

During manual testing, entering `max` in the Agent ID field produced the browser validation message: “Please match the requested format.”

The deployed frontend declares:
- Minimum length: 2 characters
- Maximum length: 48 characters
- HTML pattern: `[a-z0-9_-]+`

The agent creation API independently enforces the same character set and length range, and reserves only `admin` and `primary`. Therefore, the literal lowercase value `max` satisfies the declared frontend and API format rules. The observed browser message is not explained by the current source validation rules.

Do not document `max` as invalid or change the API format speculatively. Re-test with a freshly cleared field and a simple value such as `max-agent`, ensuring there are no leading/trailing spaces or uppercase characters. If the browser still rejects it, capture the exact field value and a screenshot of the validation message before changing validation code.

Agent creation remains unverified until a POST succeeds and the created agent appears in the signed-in user's agent list. Treat the returned bearer token as a one-time secret.

## Next verification sequence

1. Resolve the Agent ID browser-validation discrepancy.
2. Create one test agent and confirm it persists and appears in the workspace.
3. Confirm the one-time agent token is displayed only on creation and can be copied.
4. Configure a minimal test allocation, transfer limits, autonomous allowance, and an exact authorized recipient.
5. Test agent actions (configuration save, recipient authorization/revocation, token rotation, deactivate/reactivate).
6. Test a controlled Testnet request only after verifying the configured limits and recipient. Do not initiate a live transfer without explicit approval.
7. Verify transaction history and reconciliation evidence.
8. Verify sign-out and that protected routes/API calls reject an expired or absent session.
9. Run the relevant CI and security/concurrency regression suites.

## Release boundary

No merge to `main`, Production deployment, Production Supabase mutation, or mainnet activity is authorized by this log. The Preview is a test environment, not a production-ready release.
