"use client";

import { useState } from "react";

type Outcome = { agent: string; amount: string; status: "reserved" | "blocked"; reason: string };

export default function JudgeBudgetLab() {
  const [hasRun, setHasRun] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  function runContention() {
    setOutcomes([
      { agent: "Research agent", amount: "3.00 NEAR", status: "reserved", reason: "Reservation acquired first" },
      { agent: "Operations agent", amount: "3.00 NEAR", status: "blocked", reason: "Only 2.00 NEAR remains under the shared ceiling" },
    ]);
    setHasRun(true);
  }

  function reset() {
    setHasRun(false);
    setOutcomes([]);
  }

  return (
    <div className="budget-lab">
      <div className="budget-lab-head">
        <div><span className="lab-overline">INTERACTIVE MODEL / 5 NEAR TREASURY</span><h3>Two agents request the same remaining budget.</h3><p>Both requests are issued at the same time. The database treasury lock serializes reservation decisions.</p></div>
        <span className="lab-tag">SIMULATION</span>
      </div>
      <div className="budget-lab-grid">
        <div className="budget-ledger">
          <div className="budget-total"><span>SHARED TREASURY CEILING</span><strong>5.00 <small>NEAR</small></strong></div>
          <div className="budget-meter"><span style={{ width: hasRun ? "60%" : "0%" }} /></div>
          <div className="budget-meter-labels"><span>{hasRun ? "3.00 NEAR reserved" : "0.00 NEAR committed"}</span><span>{hasRun ? "2.00 NEAR available" : "5.00 NEAR available"}</span></div>
          <div className="budget-breakdown">
            <div><span className="ledger-dot committed" />Committed spend</div><strong>0.00 NEAR</strong>
            <div><span className="ledger-dot reserved" />Active reservations</div><strong>{hasRun ? "3.00" : "0.00"} NEAR</strong>
            <div><span className="ledger-dot available" />Available balance</div><strong>{hasRun ? "2.00" : "5.00"} NEAR</strong>
          </div>
          <div className="budget-invariant"><span>INVARIANT</span><strong>spent + reserved ≤ treasury ceiling</strong></div>
        </div>
        <div className="budget-agents">
          <div className="budget-agent-row"><span className="agent-avatar">R</span><div><strong>Research agent</strong><small>Separate agent identity · 3.00 NEAR request</small></div><span className="agent-request">3.00</span></div>
          <div className="budget-agent-row"><span className="agent-avatar">O</span><div><strong>Operations agent</strong><small>Separate agent identity · 3.00 NEAR request</small></div><span className="agent-request">3.00</span></div>
          <button className="budget-run-button" onClick={runContention} disabled={hasRun}>Run concurrent reservation test <span>→</span></button>
          <button className="budget-reset-button" onClick={reset} disabled={!hasRun}>Reset model</button>
          {hasRun && <div className="budget-outcomes" aria-live="polite">
            {outcomes.map((outcome) => <div className="budget-outcome" key={outcome.agent}>
              <span className={outcome.status === "reserved" ? "outcome-check" : "outcome-stop"}>{outcome.status === "reserved" ? "✓" : "×"}</span>
              <div><strong>{outcome.agent}</strong><small>{outcome.reason}</small></div>
              <b className={outcome.status}>{outcome.status === "reserved" ? "RESERVED" : "BLOCKED"}</b>
            </div>)}
          </div>}
        </div>
      </div>
      <div className="budget-lab-foot"><span className="lab-pulse" /> <span>{hasRun ? "One reservation accepted. The second cannot consume the same 3 NEAR." : "Run the scenario to see the shared ceiling reject the competing request."}</span></div>
    </div>
  );
}
