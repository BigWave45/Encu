# OutLayer integration: current boundary and remaining V1 work

Status: current code inspection on 2026-11-03. This document is the operational checklist for finishing the OutLayer-backed V1. It is separate from the native NEAR contract work.

## What the repository currently does

The OutLayer adapter is `lib/outlayer.ts`.

- Requires `OUTLAYER_BASE_URL`, `OUTLAYER_API_KEY` and `OUTLAYER_NEAR_ADDRESS`.
- Restricts the base URL to the official network-specific OutLayer API host.
- Calls `GET /wallet/v1/address?chain=near` before admin approval submission and verifies the reported executor identity against the configured signer.
- Calls `POST /wallet/v1/transfer` from either the autonomous agent-transfer path (only after an atomic AgentGuard authorization) or the administrator approval route.
- Persists provider request IDs and transaction hashes when returned.
- Preserves the reservation as `needs_review` when the provider outcome is ambiguous.
- Looks up saved provider request IDs through `GET /wallet/v1/requests/{id}`.
- Uses NEAR RPC with `wait_until: FINAL` and verifies signer, recipient, exactly one native transfer action and exact yocto amount before settlement.

The agent transfer route now branches on the database's atomic authorization result. A reservation inside the administrator-configured cumulative autonomous allowance is marked `auto_approved` and submitted once by the server; a request outside that allowance enters `awaiting_approval`. Both paths remain subject to the absolute per-agent allocation, shared treasury ceiling, per-transfer and rolling limits, emergency stop, and active recipient registry. Agent bearer credentials do not contain the OutLayer API key. The provider may independently hold an automatically submitted request for its own wallet approval; AgentGuard's authorization does not bypass OutLayer policy.

## Important correction: OutLayer has its own policy engine

OutLayer's current Agent Custody documentation describes owner-controlled wallet policies encrypted and stored on-chain, decrypted and evaluated inside its TEE before transaction signing. Documented policy controls include per-transaction, hourly, daily and monthly caps, address allowlists/denylists, time restrictions, rate limits, transaction-type restrictions and multisig approval.

Therefore AgentGuard must not claim that OutLayer lacks spending limits, recipient allowlists or approval controls. The correct relationship is defense in depth:

- **OutLayer wallet policy:** an independent, wallet-level signing boundary. It should be configured by the wallet owner with conservative hard ceilings and recipient/transaction restrictions. Its TEE evaluates that policy before it signs.
- **AgentGuard policy:** the application-level authorization boundary. It authenticates each logical agent, assigns per-agent allocations, applies the shared treasury exposure limit, checks the exact recipient, records the reservation, manages the approval workflow and maintains an attributable audit trail.
- **NEAR finality:** AgentGuard independently checks the resulting transaction against the reservation before it settles its off-chain ledger.

The current integration code does not create, read back, or verify the OutLayer owner policy. It only calls the wallet address and transfer endpoints. Do not describe OutLayer policy as configured in our deployment until the actual wallet policy has been inspected and its effective values recorded.

The current integration uses one configured OutLayer wallet and one server-side API credential for all AgentGuard agents. The AgentGuard agent identity is not visibly passed as a distinct OutLayer principal in `transferNear(to, amount)`. Thus OutLayer's wallet policy is a wallet-wide backstop; AgentGuard remains responsible for differentiating Alpha, Beta and future logical agents and enforcing their separate allocations. Do not imply that OutLayer currently enforces AgentGuard's per-agent allocation ledger.

OutLayer's TEE attestation documentation describes attestations for OutLayer code executions. The current AgentGuard integration does not fetch, store, display or independently verify an attestation as part of the transfer lifecycle. Do not claim AgentGuard currently presents independently verifiable attestation evidence for its wallet transfers without confirming that the wallet transfer endpoint returns such evidence and implementing its verification path.

## OutLayer V1 backlog

### A. Confirm provider wallet policy (configuration and evidence)

- [x] Inspect the actual Preview OutLayer wallet policy. The 2026-11-03 read returned `approval: null`; this establishes that no approval rule was returned in the policy object, not that every provider request is guaranteed to execute without another hold.
- [x] Record the effective Preview policy values supplied on 2026-11-03: 1 NEAR per transaction; 5 NEAR hourly, daily and monthly; transaction type `transfer` only; EVM and Solana signing disabled. The returned object did not establish allowlist or rate-limit values. `approval`, `version` and `updatedAt` were null.
- [ ] Confirm whether policy changes are owner-authorized and stored on-chain for this wallet.
- [ ] Decide whether the Preview wallet should retain owner approval for every native transfer or allow AgentGuard-authorized requests to execute without a second human approval. This is an explicit wallet-owner security decision, not an application default.
- [x] Preview wallet caps were configured during Testnet setup. Its 1 NEAR per-transaction cap is stricter than AgentGuard's 3 NEAR Preview cap. Aggregate cap semantics and enforcement under concurrency remain unverified.
- [ ] Confirm the provider-side recipient scope. The policy response established `transfer`-only transaction types but did not establish an address allowlist.
- [ ] Test a request that passes AgentGuard but is rejected or held by OutLayer policy; verify that AgentGuard retains exposure as ambiguous/needs-review until the actual NEAR outcome is established.
- [ ] Verify an actual OutLayer response for a provider-side approval/hold. The API mock returns `pending`; the dashboard recognizes `pending_approval`, but neither mock value proves the exact live provider status contract.
- [ ] Capture evidence of the wallet policy configuration and its enforcement. Do not put API secrets in screenshots or repository files.

### B. Finish AgentGuard accounting and lifecycle verification

- [x] Atomic shared-treasury reservation race tested in disposable PostgreSQL: two individually eligible 3 NEAR requests against a 5 NEAR treasury produced one reservation and one `total_budget_exceeded`.
- [x] Live Preview denied an unlisted recipient before reservation.
- [x] Live Preview denied an approval after the recipient had been revoked.
- [x] Live Preview blocked an amount above the agent's allocation without creating a reservation.
- [x] A previous 0.001 NEAR Alpha transfer reached NEAR FINAL and was reconciled as executed.
- [ ] Verify the post-rejection database counters and both reservation ledgers with a successful direct query. The UI/audit showed rejection; the earlier attempted database query used incorrect column names and did not establish the post-rejection counters.
- [x] Disposable PostgreSQL lifecycle suite verifies successful finalisation moves both ledger reservations to spent exactly once; terminal replay cannot change the result. This is database-function test evidence, not a fresh live Supabase query.
- [x] Disposable PostgreSQL lifecycle suite verifies failed finalisation releases both reserved balances without increasing spent, and conflicting terminal outcomes cannot settle twice.
- [x] Disposable PostgreSQL lifecycle suite verifies expiry cancellation for an unapproved/unsubmitted reservation and records actor/evidence. Approved or submitted expiry refusal remains a separate edge case to verify.
- [x] API mock suite verifies provider success with a request ID and no hash remains `needs_review`, is not resubmitted on replay, and can recover a hash through provider-status lookup without settlement. Live OutLayer behavior remains unverified.
- [x] API mock suite verifies timeout/connection loss remains `needs_review` and replay does not create a second provider attempt. Live provider behavior remains unverified.
- [x] API mock suite verifies provider-status lookup can recover a missing hash while preserving `needs_review`; it does not settle the ledger.
- [x] Reconciliation mock suite verifies hash conflict, signer mismatch, wrong recipient, wrong amount, multiple actions, receipt-only results, non-FINAL outcomes, missing hashes and RPC errors remain held without ledger finalisation.
- [x] API mock suite covers recipient revocation before submission and emergency-stop behavior; disposable PostgreSQL regression verifies a tightened per-transfer policy downgrades an already-reserved autonomous request to approval while preserving both ledger reservations. Live race behavior has not been separately exercised.
- [ ] Verify failed approval attempts are recorded in the security/admin audit trail, including the current reason.
- [x] API and disposable PostgreSQL suites cover identical replay, changed-payload idempotency conflict, exact-once settlement and conflicting terminal outcomes.
- [ ] Complete one fresh low-value end-to-end Preview transfer only after the above checks, with explicit administrator approval and current state verification.

### C. Execution mode and dashboard

- [x] Implemented per-agent cumulative autonomous allowance, distinct from the absolute agent allocation.
- [x] Implemented atomic auto-authorization and one-time provider submission for eligible requests; excess requests remain administrator approval-gated.
- [x] Added dashboard configuration for the autonomous allowance and a provider-status message that distinguishes a provider approval wait from AgentGuard authorization.
- [ ] Verify the provider approval state against an actual OutLayer response. The dashboard currently recognizes `pending_approval` as a likely hold state and displays other provider states verbatim.
- [ ] Decide and configure the OutLayer owner policy after inspecting its actual effective settings.
- [ ] Add an OutLayer wallet-policy status/evidence section to the admin dashboard only after the provider policy can be read or reliably attested. Do not create cosmetic policy controls that do not call the provider.
- [ ] Show provider submission, provider request ID, transaction hash, NEAR finality and AgentGuard settlement as distinct states.
- [ ] Add transaction detail view for the provider/NEAR evidence and both reservation ledgers.
- [ ] Consider displaying an OutLayer attestation only if the transfer endpoint provides an attestation bound to the exact transfer and a verifier is implemented.

### D. Release gate

OutLayer V1 is complete only when:
1. Provider owner policy is inspected and configured with evidence.
2. All dual-ledger lifecycle and race tests above pass.
3. A controlled live Preview transfer is independently verified at NEAR FINAL and both ledgers reconcile exactly once.
4. Ambiguous provider cases remain safely reserved and can be resolved without blind retries.
5. Admin audit and transaction detail show the full lifecycle.
6. README, UI and demo language distinguish AgentGuard enforcement from OutLayer TEE custody/policy.

This gate does not require mainnet deployment.



## Evidence classification (2026-11-03)

The checked accounting and reconciliation items above are automated tests against disposable PostgreSQL or mocked API/RPC responses. They establish application behavior under those fixtures; they do not establish live OutLayer rejection/approval semantics or current Test Supabase counters. The actual Preview wallet policy values are recorded above from the read-only policy response. Do not mark provider enforcement verified from that configuration read alone.

## Separate native NEAR workstream

Native contract work remains separate and does not close or replace any OutLayer checklist item. The native contract must independently enforce authorization for funds held in its own treasury account. Keep one treasury assigned to one execution backend until cross-provider exposure and replay protection are designed and tested.


## NEAR Intents and OutLayer policy caveats

The current AgentGuard adapter only calls `POST /wallet/v1/transfer`; it does not call OutLayer's Intents endpoints. OutLayer's current Agent Custody documentation describes Intents deposits, withdrawals, swaps, transfers, cross-chain withdrawals, and limit orders. Those capabilities exist in OutLayer's documented product surface but are **not integrated into AgentGuard V1**. The same documentation says Intents-dependent endpoints return HTTP 503 on testnet because there are no testnet solvers; these flows are mainnet-only. Therefore we cannot use OutLayer Intents for a testnet hackathon demonstration, and we should not test them with production value merely to validate an unfinished adapter.

Two provider-policy caveats matter for AgentGuard:
- The public Agent Custody page lists hourly/daily/monthly caps and rate limits, but the page reviewed here does not specify their exact concurrency semantics. Do not assume those counters provide a hard atomic cross-agent ceiling. Keep AgentGuard's own atomic shared-budget and per-agent reservation checks.
- OutLayer documents that for certain Trusted Intents operations, the TEE's multisig approval pins the recipient and verifies approver signatures, while some token/amount/route artifacts are supplied by the gateway at execution. Before supporting those operations, AgentGuard must bind the exact approved asset, amount, destination and quote/route artifact and verify that the submitted operation matches. The OutLayer docs explicitly note a trust boundary in some Trusted Intents approvals: the TEE pins recipient and verifies approver signatures, but token/amount/route artifacts are gateway-supplied at execution and are not independently re-checked by the TEE. If the API cannot provide a verifiable binding, do not describe the operation as exact-term approval.

The public documentation is not evidence of the actual wallet's configured policy. The deployed Preview wallet policy remains uninspected because reading `GET /wallet/v1/policy` requires the wallet's authenticated API key. No API key was retrieved or exposed during this review.


## Current OutLayer Intents capability, verified from public docs

OutLayer Agent Custody already exposes documented endpoints for Intents deposit, cross-chain deposit, swap, withdrawal, transfer within Intents, and limit orders. These are OutLayer capabilities, not AgentGuard capabilities yet. The current AgentGuard adapter remains the native NEAR `/wallet/v1/transfer` route only.

**Network restriction:** OutLayer's current documentation states that Intents-dependent endpoints return HTTP 503 on testnet because there are no testnet solvers; they are mainnet-only. Keep the hackathon's live tests on testnet and do not move production value to mainnet just to test an unfinished integration.

**Approval binding:** OutLayer's docs state that for certain Trusted Intents operations the TEE pins the recipient and verifies approver signatures, but token/amount/route artifacts are supplied by the gateway at execution and are not independently re-checked by the TEE. AgentGuard must not claim exact-terms approval for those flows without an adapter that verifies the quote/artifact against the original AgentGuard-approved request.

**Actual wallet policy:** Public docs list the policy features; they do not establish the current Preview wallet's configured values. Inspect `GET /wallet/v1/policy` using the wallet's authenticated API key or the owner dashboard. Do not copy the API key into the repository or chat. Record only non-secret effective policy values and evidence.
