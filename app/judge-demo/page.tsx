import type { Metadata } from "next";
import Link from "next/link";
import JudgeBudgetLab from "./judge-budget-lab";
import "./judge-demo.css";

export const metadata: Metadata = {
  title: "ENCU | Judge Demo",
  description:
    "A public walkthrough of ENCU, an application-level authorization and transaction-control layer for autonomous NEAR payments.",
};

const architecture = [
  {
    number: "01",
    name: "Agent identity",
    role: "ENCU API",
    detail:
      "Each logical agent authenticates with its own bearer credential. Agent credentials are distinct from the operator's execution-provider credential.",
  },
  {
    number: "02",
    name: "Policy and accounting",
    role: "Supabase / PostgreSQL",
    detail:
      "Stores agent allocations, shared treasury limits, recipient permissions, reservations, security events and ledger state. Mutations use privileged database RPCs.",
  },
  {
    number: "03",
    name: "Execution",
    role: "OutLayer",
    detail:
      "The configured V1 provider submits native NEAR transfers using the operator-configured execution wallet. Its API credential remains server-side.",
  },
  {
    number: "04",
    name: "Independent verification",
    role: "NEAR RPC",
    detail:
      "ENCU checks transaction finality and verifies the expected signer, recipient, amount and transfer action before settling the ledger.",
  },
];

const stages = [
  ["Authenticate", "Validate the agent credential and active status."],
  ["Authorize", "Check recipient permissions, transfer policy and spending limits."],
  ["Reserve", "Atomically reserve against the shared treasury and that agent's allocation."],
  ["Revalidate", "Check current policy again before claiming provider submission."],
  ["Submit", "Send the approved native transfer through OutLayer."],
  ["Reconcile", "Verify the final transaction on NEAR before settling accounting."],
];

export default function JudgeDemoPage() {
  return (
    <main className="judge-page">
      <div className="judge-wrap">
        <header className="judge-topbar">
          <Link href="/judge-demo" className="judge-brand" aria-label="ENCU judge demo home">
            <span className="judge-mark">E</span>
            <span>ENCU</span>
          </Link>
          <nav aria-label="Demo navigation">
            <a href="#problem">Problem</a>
            <a href="#shared-budget">Shared budget</a>
            <a href="#architecture">Architecture</a>
            <a href="#evidence">Evidence</a>
          </nav>
          <span className="judge-public-tag">PUBLIC DEMO · NO SIGN-IN</span>
        </header>

        <section className="judge-hero">
          <div className="judge-hero-copy">
            <div className="judge-eyebrow"><span /> NEAR HACKATHON · TRACK 06 · AI SECURITY</div>
            <h1>Agents can initiate payments. Who controls what they can spend?</h1>
            <p className="judge-lede">
              ENCU is an application-level authorization and accounting gateway for autonomous agents making native NEAR transfers. It puts identity, policy, shared-budget reservations and transaction verification between an agent instruction and execution.
            </p>
            <div className="judge-hero-actions">
              <a className="judge-button primary" href="#shared-budget">Explore the control model <span>↓</span></a>
              <a className="judge-button quiet" href="#evidence">Inspect real transaction evidence <span>↗</span></a>
            </div>
            <div className="judge-hero-note">A working prototype on NEAR Testnet. Not a production custody service.</div>
          </div>
          <div className="judge-hero-visual" aria-label="Conceptual payment authorization flow">
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="hero-core"><span>ENCU</span><small>POLICY GATE</small></div>
            <div className="hero-node node-agent"><b>AGENT</b><small>instruction</small></div>
            <div className="hero-node node-provider"><b>OUTLAYER</b><small>execution</small></div>
            <div className="hero-node node-chain"><b>NEAR</b><small>finality</small></div>
            <div className="hero-flow-label">IDENTITY · POLICY · ACCOUNTING</div>
          </div>
        </section>

        <section className="judge-proofline" aria-label="Prototype facts">
          <div><strong>NEAR Testnet</strong><span>Native transfer path</span></div>
          <div><strong>Multi-agent</strong><span>One shared operator treasury</span></div>
          <div><strong>Atomic reserve</strong><span>Database-enforced budget</span></div>
          <div><strong>Finality check</strong><span>NEAR RPC reconciliation</span></div>
        </section>

        <section className="judge-section" id="problem">
          <div className="judge-section-head">
            <div><span className="judge-kicker">01 / THE PROBLEM</span><h2>Execution capability is not spending authority.</h2></div>
            <p>An agent with access to a payment tool can request a transfer. That alone does not answer whether the agent should be allowed to spend that amount, pay that recipient, or consume funds reserved for other agents.</p>
          </div>
          <div className="judge-problem-grid">
            <article className="judge-problem-card risk">
              <span className="card-index">WITHOUT ENCU</span>
              <h3>Tool access becomes the control boundary.</h3>
              <ul>
                <li>Multiple agents may depend on one execution wallet.</li>
                <li>Per-agent intent can collide with a shared treasury limit.</li>
                <li>A provider acknowledgement can be mistaken for settlement.</li>
              </ul>
            </article>
            <article className="judge-problem-card control">
              <span className="card-index">WITH ENCU</span>
              <h3>Each transfer must earn execution.</h3>
              <ul>
                <li>Authenticate the requesting agent.</li>
                <li>Evaluate recipient and spending policy.</li>
                <li>Reserve budget before provider submission.</li>
                <li>Reconcile the result against NEAR finality.</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="judge-section budget-section" id="shared-budget">
          <div className="judge-section-head">
            <div><span className="judge-kicker">02 / MULTI-AGENT TREASURY CONTROL</span><h2>One treasury. Separate agent limits. One aggregate ceiling.</h2></div>
            <p>Each agent has its own allocation. All agents draw against one operator-configured treasury ceiling. Reservations are serialized in the database so concurrent requests cannot each claim the same remaining balance.</p>
          </div>
          <JudgeBudgetLab />
          <p className="judge-inline-caveat">Interactive model only. It does not call the ENCU API, change a real budget or submit a transaction. The concurrency example mirrors the repository's dedicated 5 NEAR disposable-database test: two separate 3 NEAR reservations compete for one 5 NEAR ceiling; one can reserve, the other is blocked. Winner order is nondeterministic in the actual test.</p>
        </section>

        <section className="judge-section" id="architecture">
          <div className="judge-section-head">
            <div><span className="judge-kicker">03 / SYSTEM ARCHITECTURE</span><h2>Four boundaries. One verifiable lifecycle.</h2></div>
            <p>ENCU does not replace the execution provider or the NEAR network. It controls authorization and accounting before submission, then checks the chain outcome independently.</p>
          </div>
          <div className="judge-architecture">
            {architecture.map((item) => (
              <article className="architecture-card" key={item.number}>
                <div className="architecture-top"><span>{item.number}</span><small>{item.role}</small></div>
                <h3>{item.name}</h3>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
          <div className="judge-boundary-note"><strong>Trust boundary:</strong> Supabase stores policy and accounting state. OutLayer holds the configured execution capability. NEAR RPC supplies the finality evidence. These roles are distinct.</div>
        </section>

        <section className="judge-section">
          <div className="judge-section-head">
            <div><span className="judge-kicker">04 / TRANSFER LIFECYCLE</span><h2>Authority before execution. Evidence before settlement.</h2></div>
            <p>A request is not considered settled merely because ENCU received it or OutLayer returned a provider reference.</p>
          </div>
          <div className="judge-lifecycle">
            {stages.map(([title, detail], index) => (
              <div className="lifecycle-step" key={title}>
                <span className="lifecycle-number">{String(index + 1).padStart(2, "0")}</span>
                <div><h3>{title}</h3><p>{detail}</p></div>
              </div>
            ))}
          </div>
          <div className="judge-state-note"><span className="state-dot" /> <div><strong>Needs review is not settlement.</strong><p>It indicates that the provider outcome still requires reconciliation or investigation. ENCU does not blindly retry an ambiguous submission.</p></div></div>
        </section>

        <section className="judge-section" id="evidence">
          <div className="judge-section-head">
            <div><span className="judge-kicker">05 / IMPLEMENTATION & EVIDENCE</span><h2>Implemented controls, inspectable proof.</h2></div>
            <p>The demo separates automated tests from the real Testnet transaction. Both matter, but they prove different things.</p>
          </div>
          <div className="judge-evidence-grid">
            <article className="evidence-card real">
              <span className="evidence-label">REAL TESTNET TRANSACTION</span>
              <div className="evidence-status">EXECUTED <i /></div>
              <h3>0.001 NEAR</h3>
              <p>One authorized native transfer from the configured OutLayer execution account to <code>twat.testnet</code>. ENCU's developer-triggered reconciliation changed the request to EXECUTED after the finality verification path.</p>
              <dl>
                <div><dt>Request</dt><dd>encu-a56578ea-acf1-4967-a357-0474d86ee65a</dd></div>
                <div><dt>Transaction</dt><dd>Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw</dd></div>
                <div><dt>Recipient</dt><dd>twat.testnet</dd></div>
              </dl>
              <a className="evidence-link" href="https://testnet.nearblocks.io/txns/Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw" target="_blank" rel="noreferrer">Open transaction in NEAR Testnet explorer ↗</a>
            </article>
            <article className="evidence-card">
              <span className="evidence-label">AUTOMATED VERIFICATION</span>
              <h3>CI passed on the merged release branch.</h3>
              <p>GitHub Actions ran dependency installation and audit, lint, TypeScript checks, production build, agent API security/lifecycle tests and NEAR finality reconciliation tests.</p>
              <a className="evidence-link" href="https://github.com/BigWave45/agentguard/actions/runs/43117051827" target="_blank" rel="noreferrer">Open CI run ↗</a>
              <div className="evidence-subnote">The separate shared-budget concurrency script requires a dedicated disposable Supabase project. Its test is not represented as part of this CI run.</div>
            </article>
          </div>
          <div className="judge-evidence-links">
            <a href="https://github.com/BigWave45/agentguard/blob/agentguard/build-v1/docs/SECURITY_ARCHITECTURE.md" target="_blank" rel="noreferrer">Security architecture ↗</a>
            <a href="https://github.com/BigWave45/agentguard/blob/agentguard/build-v1/supabase/20261103010000_enforce_agent_allocations.sql" target="_blank" rel="noreferrer">Atomic allocation and reservation logic ↗</a>
            <a href="https://github.com/BigWave45/agentguard/blob/agentguard/build-v1/scripts/test-reservation-concurrency.mjs" target="_blank" rel="noreferrer">Shared-budget concurrency test ↗</a>
            <a href="https://github.com/BigWave45/agentguard" target="_blank" rel="noreferrer">Source repository ↗</a>
          </div>
        </section>

        <section className="judge-section distinction-section">
          <div className="judge-section-head">
            <div><span className="judge-kicker">06 / WHAT IS DISTINCTIVE</span><h2>The combination is the control system.</h2></div>
            <p>Agent credentials, spending limits, allowlists and transaction monitoring exist independently elsewhere. ENCU's V1 contribution is connecting them into one enforced payment lifecycle for multiple logical agents sharing an operator treasury.</p>
          </div>
          <div className="judge-distinction">
            <div><span>PRE-EXECUTION</span><strong>Identity + policy + atomic budget reservation + submission revalidation</strong></div>
            <div className="distinction-plus">+</div>
            <div><span>POST-SUBMISSION</span><strong>NEAR finality + transfer-effect verification + ledger settlement</strong></div>
          </div>
        </section>

        <section className="judge-section near-section">
          <div className="judge-section-head">
            <div><span className="judge-kicker">07 / WHY NEAR</span><h2>NEAR is the execution and settlement environment.</h2></div>
            <p>ENCU currently controls native NEAR transfers. Agent destinations are NEAR accounts, OutLayer submits through its configured NEAR execution wallet, and ENCU checks the resulting transaction against NEAR finality.</p>
          </div>
          <div className="near-points">
            <div><strong>Native asset movement</strong><span>The demonstrated flow is a native NEAR transfer, not a mocked payment abstraction.</span></div>
            <div><strong>Account-level destination policy</strong><span>Recipient permissions are evaluated against NEAR account identifiers.</span></div>
            <div><strong>Chain-verifiable outcome</strong><span>Finality and the expected transfer effect are checked through NEAR RPC.</span></div>
          </div>
        </section>

        <section className="judge-section audience-section">
          <div className="judge-section-head">
            <div><span className="judge-kicker">08 / WHO IT SERVES</span><h2>For teams operating payment-capable agents.</h2></div>
            <p>The first deployment model is deliberately narrow: one treasury operator coordinating several logical agents.</p>
          </div>
          <div className="audience-grid">
            <div><span>01</span><h3>Agent developers</h3><p>Give each agent a scoped identity and a controlled transfer interface.</p></div>
            <div><span>02</span><h3>Agent operators</h3><p>Set treasury exposure, allocate spending authority and restrict recipients.</p></div>
            <div><span>03</span><h3>Agent platforms</h3><p>Introduce an application-level policy and accounting layer between agent workflows and payment execution.</p></div>
          </div>
        </section>

        <section className="judge-section limits-section">
          <div className="judge-section-head">
            <div><span className="judge-kicker">09 / SCOPE & LIMITATIONS</span><h2>What V1 does and does not claim.</h2></div>
            <p>ENCU is a working NEAR Testnet prototype. The current trust model and deployment boundaries matter.</p>
          </div>
          <div className="limits-grid">
            <div><h3>Implemented in V1</h3><ul><li>Agent-scoped bearer credentials</li><li>Shared treasury ceiling and per-agent allocations</li><li>Atomic spend reservations and replay protection</li><li>Recipient authorization and emergency stop</li><li>OutLayer native NEAR transfer submission</li><li>NEAR finality reconciliation before ledger settlement</li></ul></div>
            <div><h3>Not claimed in V1</h3><ul><li>Mainnet readiness or production custody</li><li>Separate on-chain wallet for every agent</li><li>Isolated customer-funded treasuries or multi-tenant custody</li><li>A native NEAR treasury smart contract</li><li>Multiple production execution providers</li><li>Independent security audit or formal verification</li></ul></div>
          </div>
        </section>

        <footer className="judge-footer">
          <div><span className="judge-brand"><span className="judge-mark">E</span><span>ENCU</span></span><p>Application-level authorization and accounting for autonomous NEAR payments.</p></div>
          <div className="footer-links"><a href="https://github.com/BigWave45/agentguard" target="_blank" rel="noreferrer">GitHub ↗</a><Link href="/developers">Developer workspace ↗</Link><a href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Back to top ↑</a></div>
          <small>NEAR Testnet prototype · Single-operator V1 · Public technical walkthrough</small>
        </footer>
      </div>
    </main>
  );
}
