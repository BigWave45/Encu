"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import "./judge-demo.css";

const TX_HASH = "Hw5RGHYzepK5EwPUCZQrbXo9SDwjFxhQrRPM2PsHkLHw";
const REPO = "https://github.com/BigWave45/agentguard";
const EXPLORER = `https://testnet.nearblocks.io/txns/${TX_HASH}`;

type Outcome = { id: string; agent: string; amount: number; status: "reserved" | "blocked"; reason: string };

function money(value: number) {
  return `${value.toFixed(2)} NEAR`;
}

export default function JudgeDemoPage() {
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [scenario, setScenario] = useState<"idle" | "concurrent" | "single">("idle");
  const [showArchitecture, setShowArchitecture] = useState(false);

  const reserved = useMemo(
    () => outcomes.filter(item => item.status === "reserved").reduce((sum, item) => sum + item.amount, 0),
    [outcomes]
  );
  const ceiling = 5;
  const remaining = ceiling - reserved;

  function runConcurrent() {
    if (scenario === "concurrent") return;
    // The order is deterministic for this teaching simulation. The database test
    // issues both requests concurrently and asserts exactly one reservation wins.
    setOutcomes([
      { id: "req-a", agent: "primary", amount: 3, status: "reserved", reason: "Atomic reservation acquired first." },
      { id: "req-b", agent: "research-agent", amount: 3, status: "blocked", reason: "Shared budget has only 2 NEAR remaining." }
    ]);
    setScenario("concurrent");
  }

  function runSingle() {
    if (scenario === "single") return;
    setOutcomes([
      { id: "req-a", agent: "primary", amount: 3, status: "reserved", reason: "Reservation fits within the shared budget." }
    ]);
    setScenario("single");
  }

  function reset() {
    setOutcomes([]);
    setScenario("idle");
  }

  return (
    <main className="judge-page">
      <header className="judge-nav">
        <Link href="/judge-demo" className="judge-wordmark"><span className="judge-mark">E</span> ENCU</Link>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#shared-budget">Shared budget</a>
          <a href="#evidence">Evidence</a>
          <a href="#architecture">Architecture</a>
        </nav>
        <a className="judge-nav-cta" href={REPO} target="_blank" rel="noreferrer">Source code ↗</a>
      </header>

      <section className="judge-hero">
        <div className="judge-hero-copy">
          <div className="judge-kicker"><span className="judge-live-dot" /> NEAR TESTNET · APPLICATION-LEVEL CONTROL</div>
          <h1>Autonomous agents need spending rules that actually hold.</h1>
          <p className="judge-lede">ENCU is a transaction authorization and accounting layer for agent-initiated NEAR payments. It checks authority before execution, reserves shared budget, then verifies the resulting transaction against NEAR finality.</p>
          <div className="judge-actions">
            <a className="judge-button primary" href="#walkthrough">Explore the system <span>↓</span></a>
            <a className="judge-button secondary" href={REPO} target="_blank" rel="noreferrer">Inspect the code ↗</a>
          </div>
          <p className="judge-disclaimer">A working Testnet prototype. This page is read-only; its interactive scenarios do not submit transactions.</p>
        </div>
        <div className="judge-hero-visual" aria-label="Illustration of policy-controlled agent payments">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="hero-core"><span>ENCU</span><small>POLICY GATE</small></div>
          <div className="hero-node node-agent"><i>01</i><b>AGENT</b><small>request</small></div>
          <div className="hero-node node-policy"><i>02</i><b>POLICY</b><small>authorize</small></div>
          <div className="hero-node node-chain"><i>03</i><b>NEAR</b><small>finality</small></div>
          <div className="hero-line line-a" /><div className="hero-line line-b" /><div className="hero-line line-c" />
          <div className="hero-caption">REQUEST → RESERVE → EXECUTE → VERIFY</div>
        </div>
      </section>

      <section className="judge-proof-strip" aria-label="Project scope">
        <div><span>NETWORK</span><b>NEAR Testnet</b></div>
        <div><span>EXECUTION</span><b>OutLayer wallet</b></div>
        <div><span>POLICY + LEDGER</span><b>Supabase / PostgreSQL</b></div>
        <div><span>VERIFICATION</span><b>NEAR RPC · FINAL</b></div>
      </section>

      <section className="judge-section problem-section" id="problem">
        <div className="judge-section-label">01 / THE PROBLEM</div>
        <div className="judge-two-col">
          <div><h2>An agent can be authorized to pay. That does not mean every payment should be allowed.</h2></div>
          <div className="judge-prose"><p>Autonomous agents can initiate actions faster than an operator can review them. Giving an agent access to a wallet creates a gap between the authority it has and the authority it should have for a particular payment.</p><p>Operators need enforceable boundaries: which agent is calling, how much it can spend, which recipient it can pay, how much the whole group can commit, and whether the submitted transaction actually matches the approved request.</p><p>ENCU places those checks in the application path before a provider is asked to execute a transfer, then reconciles the result against the chain.</p></div>
        </div>
        <div className="judge-problem-grid">
          <article><span>01</span><h3>Unbounded authority</h3><p>A valid agent credential alone should not grant unlimited spending power.</p></article>
          <article><span>02</span><h3>Shared-wallet contention</h3><p>Multiple agents can compete for the same treasury balance. Separate checks without atomic reservation can oversubscribe it.</p></article>
          <article><span>03</span><h3>Unverified success</h3><p>A provider response or transaction hash is not proof that the intended transfer reached finality.</p></article>
        </div>
      </section>

      <section className="judge-section" id="how-it-works">
        <div className="judge-section-label">02 / THE CONTROL PATH</div>
        <div className="judge-section-heading"><h2>Control before execution.<br />Evidence after execution.</h2><p>ENCU connects application policy to an execution provider and an independent chain-state check.</p></div>
        <div className="judge-flow">
          <article><div className="flow-number">01</div><div className="flow-icon">⌁</div><h3>Authenticate</h3><p>Identify the calling agent using its scoped bearer credential. Check that the agent is active and belongs to the operator workspace.</p><small>AGENT IDENTITY</small></article>
          <div className="flow-arrow">→</div>
          <article><div className="flow-number">02</div><div className="flow-icon">◈</div><h3>Evaluate policy</h3><p>Check allocation, transfer ceiling, daily and weekly limits, autonomous allowance, recipient permission and global budget.</p><small>AUTHORIZATION</small></article>
          <div className="flow-arrow">→</div>
          <article><div className="flow-number">03</div><div className="flow-icon">▤</div><h3>Reserve atomically</h3><p>Record the request and reserve its amount before calling the execution provider. Idempotency prevents a replay from creating a second reservation.</p><small>ACCOUNTING</small></article>
          <div className="flow-arrow">→</div>
          <article><div className="flow-number">04</div><div className="flow-icon">↗</div><h3>Submit transfer</h3><p>After the reservation and submission claim succeed, ENCU asks the configured OutLayer wallet to submit a native NEAR transfer.</p><small>OUTLAYER</small></article>
          <div className="flow-arrow">→</div>
          <article><div className="flow-number">05</div><div className="flow-icon">✓</div><h3>Verify finality</h3><p>Query NEAR RPC and compare final execution status, signer, recipient, action count, transfer action and exact amount before settling the ledger.</p><small>NEAR RPC</small></article>
        </div>
      </section>

      <section className="judge-section budget-section" id="shared-budget">
        <div className="judge-section-label">03 / MULTI-AGENT TREASURY</div>
        <div className="judge-section-heading"><h2>Independent agents.<br />One shared spending boundary.</h2><p>Each agent has its own identity and allocation. Every reservation also consumes capacity from the same operator-level treasury budget.</p></div>
        <div className="budget-layout">
          <div className="budget-explainer">
            <div className="budget-model"><span className="model-label">ONE OPERATOR-CONFIGURED TESTNET WALLET</span><div className="model-wallet">Shared treasury <b>5.00 NEAR</b></div><div className="model-branches"><i /><i /></div><div className="model-agents"><div>primary <b>Agent allocation</b></div><div>research-agent <b>Agent allocation</b></div></div></div>
            <p className="judge-note">The allocations are policy limits against one shared execution wallet. They are not separate wallets, independent custody accounts or on-chain sub-balances.</p>
          </div>
          <div className="budget-simulator">
            <div className="sim-top"><div><span className="model-label">INTERACTIVE MODEL</span><h3>Reservation race</h3></div><span className="sim-badge">SIMULATED</span></div>
            <p className="sim-description">A 5 NEAR shared budget receives two simultaneous 3 NEAR requests from different agents. Both requests individually look valid; together they would require 6 NEAR.</p>
            <div className="sim-budget-row"><span>Shared budget</span><b>5.00 NEAR</b></div>
            <div className="sim-track"><div style={{ width: `${(reserved / ceiling) * 100}%` }} /></div>
            <div className="sim-numbers"><span>{money(reserved)} reserved</span><span>{money(remaining)} remaining</span></div>
            <div className="sim-requests">
              <div><span className="request-agent">primary</span><b>3.00 NEAR</b><span className={outcomes.find(x => x.id === "req-a")?.status === "reserved" ? "request-status accepted" : "request-status"}>{outcomes.find(x => x.id === "req-a")?.status === "reserved" ? "RESERVED" : "WAITING"}</span></div>
              <div><span className="request-agent">research-agent</span><b>3.00 NEAR</b><span className={outcomes.find(x => x.id === "req-b")?.status === "blocked" ? "request-status blocked" : "request-status"}>{outcomes.find(x => x.id === "req-b")?.status === "blocked" ? "BLOCKED" : "WAITING"}</span></div>
            </div>
            <div className="sim-controls"><button onClick={runConcurrent} disabled={scenario === "concurrent"}>Run concurrent requests</button><button className="quiet-button" onClick={runSingle}>Run one request</button><button className="reset-button" onClick={reset}>Reset</button></div>
            {scenario !== "idle" && <div className="sim-result" aria-live="polite"><b>{scenario === "concurrent" ? "One reservation accepted. One blocked." : "One reservation accepted."}</b><p>{scenario === "concurrent" ? "The first atomic reservation commits 3 NEAR. The second sees only 2 NEAR remaining and is rejected before provider submission." : "The 3 NEAR request fits within the 5 NEAR shared budget. The remaining 2 NEAR stays available."}</p></div>}
            <p className="sim-footnote">This is a local explanatory simulation, not a live database call. The repository includes a separate disposable-database concurrency test for this invariant.</p>
          </div>
        </div>
      </section>

      <section className="judge-section" id="walkthrough">
        <div className="judge-section-label">04 / CAPABILITIES</div>
        <div className="judge-section-heading"><h2>Controls that act on the payment path.</h2><p>ENCU combines pre-execution authorization with post-execution reconciliation. The dashboard exposes these controls to the operator.</p></div>
        <div className="judge-feature-grid">
          <article><span>IDENTITY</span><h3>Agent-scoped credentials</h3><p>Issue a bearer credential for each logical agent. Credentials can be rotated; inactive agents cannot initiate transfers. A new agent starts with zero allocation.</p></article>
          <article><span>ALLOCATION</span><h3>Per-agent spending authority</h3><p>Assign an allocation and configure maximum transfer, daily, weekly and autonomous-spend limits. These rules constrain what each agent may request.</p></article>
          <article><span>RECIPIENT POLICY</span><h3>Recipient allowlists</h3><p>Restrict transfers to operator-approved NEAR accounts. Recipients can be activated or revoked through the developer workspace.</p></article>
          <article><span>EMERGENCY CONTROL</span><h3>Workspace stop</h3><p>Emergency stop blocks new reservations while active. Re-enabling the system restores the ability to request transfers under policy.</p></article>
          <article><span>REPLAY PROTECTION</span><h3>Idempotent requests</h3><p>A request identifier prevents an identical retry from creating a second spend. Reusing the identifier with a changed payload is rejected as a conflict.</p></article>
          <article><span>SETTLEMENT</span><h3>Finality-aware ledger</h3><p>Provider submission is not treated as settlement. ENCU waits for NEAR finality and verifies transaction fields before recording execution.</p></article>
        </div>
      </section>

      <section className="judge-section evidence-section" id="evidence">
        <div className="judge-section-label">05 / VERIFIED TESTNET EVIDENCE</div>
        <div className="judge-section-heading"><h2>A real transfer.<br />Reconciled against NEAR.</h2><p>This evidence is from the submitted Testnet prototype, not the local simulator above.</p></div>
        <div className="evidence-card">
          <div className="evidence-head"><span className="evidence-check">✓</span><div><span className="model-label">TRANSACTION STATUS</span><h3>EXECUTED</h3></div><span className="testnet-tag">NEAR TESTNET</span></div>
          <div className="evidence-grid">
            <div><span>AGENT</span><b>e2e-verification-agent</b></div>
            <div><span>AMOUNT</span><b>0.001 NEAR</b></div>
            <div><span>RECIPIENT</span><b>twat.testnet</b></div>
            <div><span>REQUEST STATUS</span><b>NEEDS REVIEW → EXECUTED</b></div>
            <div className="evidence-hash"><span>TRANSACTION HASH</span><b>{TX_HASH}</b></div>
          </div>
          <a className="judge-button primary" href={EXPLORER} target="_blank" rel="noreferrer">Open transaction on NEAR explorer ↗</a>
          <p className="evidence-footnote">The request first returned <code>needs_review</code> with <code>awaiting_onchain_confirmation</code>. The operator then used ENCU’s Verify finality action. The activity record subsequently changed to <code>EXECUTED</code>. The hash alone was not treated as settlement evidence.</p>
        </div>
        <div className="test-coverage">
          <div><span className="model-label">AUTOMATED VERIFICATION</span><h3>Failure paths are tested, too.</h3><p>Mocked API and RPC tests cover authentication, policy enforcement, recipient permissions, emergency stop, replay handling, invalid finality data, signer/recipient/amount mismatches, non-final transactions and idempotent reconciliation.</p></div>
          <div className="test-status-list"><div><b>PASS</b><span>API security & lifecycle tests</span></div><div><b>PASS</b><span>NEAR finality reconciliation tests</span></div><div><b>PASS</b><span>Lint, typecheck & production build</span></div><div><b>SEPARATE</b><span>Disposable-database reservation concurrency test</span></div></div>
        </div>
        <p className="judge-note">Automated tests use mocks unless explicitly identified otherwise. The concurrency script requires a dedicated disposable Supabase project and was not part of the CI workflow. It must not be run against production data.</p>
      </section>

      <section className="judge-section architecture-section" id="architecture">
        <div className="judge-section-label">06 / SYSTEM DESIGN</div>
        <div className="judge-section-heading"><h2>Three trust boundaries.<br />One auditable request lifecycle.</h2><p>Each component has a distinct responsibility. ENCU does not claim to replace the wallet provider or the NEAR network.</p></div>
        <div className="architecture-stack">
          <div className="architecture-row"><div className="architecture-number">01</div><div><span>POLICY + ACCOUNTING</span><h3>ENCU application / Supabase PostgreSQL</h3><p>Stores agent identities, operator policy, allocations, reservations and ledger state. Database functions enforce reservation and budget invariants.</p></div><b>DECIDES + RECORDS</b></div>
          <div className="architecture-row"><div className="architecture-number">02</div><div><span>EXECUTION</span><h3>OutLayer Testnet wallet</h3><p>Holds the configured execution capability and submits the native NEAR transfer using the operator-configured provider credential.</p></div><b>SIGNS + SUBMITS</b></div>
          <div className="architecture-row"><div className="architecture-number">03</div><div><span>INDEPENDENT CHAIN CHECK</span><h3>NEAR RPC</h3><p>Returns final transaction execution data. ENCU checks finality and matches signer, recipient, action and amount against the reservation.</p></div><b>VERIFIES FINALITY</b></div>
        </div>
        <button className="architecture-toggle" onClick={() => setShowArchitecture(value => !value)} aria-expanded={showArchitecture}>{showArchitecture ? "Hide request lifecycle" : "Show request lifecycle"} <span>{showArchitecture ? "−" : "+"}</span></button>
        {showArchitecture && <div className="lifecycle-panel"><code>Agent → ENCU API → Policy checks → Atomic reservation → OutLayer submission → NEAR RPC FINAL → Ledger settlement</code><p>If the provider response is ambiguous or chain evidence does not match, ENCU does not silently mark the reservation executed. It remains subject to reconciliation or review.</p></div>}
      </section>

      <section className="judge-section why-near-section" id="why-near">
        <div className="judge-section-label">07 / WHY NEAR</div>
        <div className="judge-two-col">
          <h2>NEAR is the settlement network this implementation is built around.</h2>
          <div className="judge-prose"><p>ENCU manages native NEAR transfer requests and NEAR account recipients. The configured OutLayer wallet submits those transfers on NEAR Testnet, and NEAR RPC provides the final execution data used for reconciliation.</p><p>That gives the project a concrete NEAR integration: policy-controlled execution followed by chain-level verification. ENCU is not presenting NEAR as a generic destination selector, and it is not claiming an exclusive protocol primitive. The application control layer is built around the actual NEAR transaction lifecycle.</p></div>
        </div>
      </section>

      <section className="judge-section audience-section" id="users">
        <div className="judge-section-label">08 / WHO IT IS FOR</div>
        <div className="audience-grid">
          <article><span>01</span><h3>Agent developers</h3><p>Give agents a narrow payment interface instead of distributing an unrestricted treasury credential to every process.</p></article>
          <article><span>02</span><h3>Agent operators</h3><p>Manage multiple logical agents under one operator-controlled execution wallet, with individual allocations and a shared budget boundary.</p></article>
          <article><span>03</span><h3>Agent infrastructure teams</h3><p>Add an application-level authorization and accounting layer between autonomous workloads and NEAR transfer execution.</p></article>
        </div>
        <div className="usage-callout"><div><span className="model-label">HOW TO USE ENCU</span><h3>Connect an agent. Define its authority. Verify every settlement.</h3></div><ol><li>Create a developer workspace.</li><li>Register an agent and store its bearer token server-side.</li><li>Assign an allocation, limits and approved recipients.</li><li>Configure the OutLayer Testnet execution wallet.</li><li>Send transfer requests through the ENCU agent API.</li><li>Review activity and verify NEAR finality.</li></ol><a href="/developers">Open developer workspace ↗</a></div>
      </section>

      <section className="judge-section differentiation-section" id="differentiation">
        <div className="judge-section-label">09 / WHAT IS DISTINCTIVE</div>
        <div className="judge-two-col"><h2>Not just a spending dashboard.</h2><div className="judge-prose"><p>Agent credentials, spending limits and transaction dashboards exist independently across the ecosystem. ENCU’s implementation brings them into one enforced transaction path: scoped identity, policy evaluation, shared-budget reservation, provider submission and independent NEAR finality reconciliation.</p><p>The meaningful property is the connection between pre-execution controls and post-execution evidence. A request is not considered settled merely because an API accepted it or returned a transaction hash.</p></div></div>
      </section>

      <section className="judge-section limits-section" id="scope">
        <div className="judge-section-label">10 / SCOPE & LIMITATIONS</div>
        <div className="judge-two-col"><h2>Prototype scope, stated precisely.</h2><div className="judge-prose"><p>Current implementation is a single-operator NEAR Testnet prototype. Multiple logical agents share one operator-configured OutLayer execution wallet and provider credential. Shared budget and per-agent allocations are enforced in the application/database accounting layer.</p><p>It is not mainnet-ready, an independently audited custody system, a fully multi-tenant SaaS product, or a set of isolated customer treasuries. It does not provision separate customer wallets, provide on-chain treasury contracts, or support multiple execution providers yet.</p><p>Next engineering steps include stronger deployment hardening, broader provider support, isolated treasury provisioning and an independent security review.</p></div></div>
      </section>

      <footer className="judge-footer">
        <div><Link href="/judge-demo" className="judge-wordmark"><span className="judge-mark">E</span> ENCU</Link><p>Policy control for autonomous NEAR transfers.</p></div>
        <div className="footer-links"><a href={REPO} target="_blank" rel="noreferrer">GitHub repository ↗</a><a href="/developers">Developer workspace ↗</a><a href="#top" onClick={event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Back to top ↑</a></div>
        <small>NEAR Testnet prototype · Read-only judge experience</small>
      </footer>
    </main>
  );
}
