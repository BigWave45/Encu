# Encu

**Policy enforcement and transaction accounting for AI-agent payments on NEAR.**

Encu is an application-layer transaction-control gateway for AI agents requesting native NEAR transfers. It authenticates each logical agent, evaluates spending and recipient policy, reserves shared treasury exposure before execution, and reconciles submitted transfers against NEAR finality before settling its ledger.

**NEAR Hackathon 2026 · Track 06: AI Security & Defense**

[Developer guide](docs/DEVELOPER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY_MODEL.md) · [Demo runbook](docs/DEMO_RUNBOOK.md)

---

## The problem

An autonomous agent with direct access to a payment wallet can spend beyond its intended authority, send funds to an unintended account, or repeat a payment after a timeout. Wallet-level controls alone do not necessarily express the distinct spending authority of multiple logical agents sharing one execution wallet.

Encu inserts an independently enforced policy and accounting layer between agent runtimes and the configured execution provider.

## How it works

```mermaid
flowchart LR
    A["AI agent runtimes"] -->|"Agent-scoped bearer token + request"| B["Encu API"]
    B --> C["Identity, validation and rate limits"]
    C --> D["PostgreSQL policy + reservation transaction"]
    D --> E["Agent allocation and rolling limits"]
    D --> F["Shared treasury ceiling"]
    D --> G["Exact recipient authorization"]
    D --> H["Emergency stop and idempotency"]
    D -->|"Authorized reservation"| I["OutLayer Testnet wallet"]
    I -->|"Submission + transaction reference"| J["NEAR RPC"]
    J -->|"Final transaction evidence"| K["Encu reconciliation"]
    K --> L["Settled ledger + audit trail"]
```

The database reservation is the control point: treasury and agent exposure are reserved atomically before a provider submission is allowed. The lock order for exposure paths is **treasury row → allocation row → reservation row**.

See [Architecture](docs/ARCHITECTURE.md) for the request lifecycle, trust boundaries and settlement rules.

## Controls in V1

- Agent-scoped bearer authentication. The authenticated credential determines the logical agent identity.
- Shared treasury ceiling and per-agent allocations.
- Per-transfer limits and rolling spend limits.
- Configured autonomous spending allowance and administrator review for requests outside that allowance.
- Exact NEAR account recipient authorization.
- Atomic reservation of shared treasury and agent exposure.
- Idempotency and changed-payload replay protection.
- Emergency stop and persistent per-agent request rate limiting.
- Submission revalidation against current policy and recipient state.
- NEAR finality reconciliation against the expected signer, recipient, native transfer action and exact yoctoNEAR amount.
- Audit and security-event records.

## V1 deployment boundary

Encu V1 is a **NEAR Testnet prototype** using one configured OutLayer execution wallet and one server-side OutLayer API credential shared by multiple independently authenticated logical agents.

Encu enforces agent identity, application policy, reservation accounting and reconciliation. OutLayer provides the configured custody, signing and submission path. Logical agent identities are not separate OutLayer principals.

V1 does **not** provide independent customer custody, isolated customer wallets, a native NEAR treasury contract, multiple implemented execution providers, mainnet support or independent transfer-bound TEE attestation verification. It has not undergone an independent formal security audit. See the [Security Model](docs/SECURITY_MODEL.md) for the full threat model and limitations.

## Run locally

This is a developer setup outline. Use a dedicated disposable Supabase project and a dedicated OutLayer Testnet wallet. Never use production credentials or a wallet holding valuable assets.

1. Install a supported Node.js release for the Next.js 15 application.
2. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env.local`.
4. Configure the Supabase, OutLayer and NEAR Testnet variables documented in `.env.example`. Keep service-role, administrator, agent and provider credentials server-side.
5. Initialize the disposable database using the repository's Supabase schema and migration files. Review the SQL before applying it; do not run test or setup SQL against a production database.
6. Start the application:
   ```bash
   npm run dev
   ```
7. Open `http://localhost:3000/developers` and authenticate using the credentials configured for the test environment.

The dashboard's Testnet request path can initiate a real Testnet transfer when policy permits it. Generating a payload is not a dry run of the submission endpoint, and submitting a request is not a harmless preview. Follow the [Demo Runbook](docs/DEMO_RUNBOOK.md).

## Verification

The repository provides these checks:

```bash
npm run lint
npx tsc --noEmit
npm run build
npm run test:agent-api
npm run test:reconciliation
```

The Agent API and reconciliation suites use mocked provider/RPC services. They verify application behavior under test fixtures; they do not prove live OutLayer behavior or a hosted end-to-end transfer.

The reservation concurrency test uses a real Supabase database and mutates test rows and budget counters. Run it only against a dedicated disposable test project after reviewing the script:

```bash
AGENTGUARD_TEST_DATABASE=true npm run test:reservation-concurrency
```

## Documentation

| Document | Purpose |
|---|---|
| [Developer guide](docs/DEVELOPER_GUIDE.md) | Agent credentials, request format, integration example, response handling and safe retries |
| [Architecture](docs/ARCHITECTURE.md) | Components, trust boundaries, authorization and settlement sequence |
| [Security model](docs/SECURITY_MODEL.md) | Assets, threats, mitigations, evidence and limitations |
| [Demo runbook](docs/DEMO_RUNBOOK.md) | Judge walkthrough and safe Testnet demonstration |
| [Submission checklist](docs/SUBMISSION_CHECKLIST.md) | Hackathon submission requirements and release checks |
| [V1 security implementation](docs/V1-SECURITY-IMPLEMENTATION.md) | Implementation-level security details |
| [OutLayer V1 backlog](docs/outlayer-v1-backlog.md) | Provider-specific constraints and unresolved work |

## Release verification status

The merged Request Payload Builder compatibility fix is present in `main` (PR [#8](https://github.com/BigWave45/agentguard/pull/8), merge commit `ec0b849043e7735ffb0e3e1b6a8043578d42708f`). Its CI run passed dependency audit, lint, type-check, production build, Agent API security/lifecycle tests and NEAR finality reconciliation tests.

The previously available Vercel Preview predates that merge. A deployment of the merged commit was blocked by the team's daily deployment limit. Therefore, the latest merged code has **not yet received fresh hosted browser verification**. Do not treat an older Preview as proof of the current `main` build.

---

**Repository identifiers:** internal package and code references retain `agentguard` / `AgentGuard`; the product name is **Encu**.
