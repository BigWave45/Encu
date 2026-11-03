"use client";

const executionStages = [
  { number: "01", title: "Agent request", detail: "A machine identity submits a transfer instruction." },
  { number: "02", title: "Identity check", detail: "ENCU authenticates the agent credential and status." },
  { number: "03", title: "Policy evaluation", detail: "Recipient permissions and spending limits are evaluated." },
  { number: "04", title: "Budget reservation", detail: "The requested amount is reserved against available authority." },
  { number: "05", title: "Provider submission", detail: "The approved request is sent to the configured execution provider." },
  { number: "06", title: "Chain reconciliation", detail: "NEAR finality is checked before the reservation is released." },
];

const policyChecks = [
  {
    index: "A",
    title: "Agent identity",
    detail: "Credential is valid and the agent is active.",
    result: "Authentication",
  },
  {
    index: "B",
    title: "Recipient permissions",
    detail: "Destination matches an explicitly authorized recipient.",
    result: "Allowlist",
  },
  {
    index: "C",
    title: "Spending constraints",
    detail: "Transfer fits the allocation and configured limits.",
    result: "Budget + limits",
  },
];

const lifecycle = [
  { title: "Requested", detail: "Instruction received", tone: "neutral" },
  { title: "Evaluated", detail: "Policy decision recorded", tone: "blue" },
  { title: "Reserved", detail: "Budget held", tone: "blue" },
  { title: "Submitted", detail: "Provider response received", tone: "orange" },
  { title: "Reconciled", detail: "NEAR finality verified", tone: "green" },
];

export default function ExecutionExplainer() {
  return (
    <section className="execution-explainer" aria-labelledby="execution-explainer-title">
      <div className="execution-intro">
        <div>
          <span className="execution-kicker">HOW ENCU WORKS</span>
          <h2 id="execution-explainer-title">Authority before execution.</h2>
          <p>
            Each transfer passes through identity, policy and budget controls.
            Provider submission is tracked separately from on-chain confirmation.
          </p>
        </div>
        <span className="execution-index">CONTROL MODEL / 01</span>
      </div>

      <div className="execution-panel execution-flow-panel">
        <div className="execution-panel-heading">
          <div>
            <span className="execution-kicker">01 / EXECUTION PATH</span>
            <h3>From agent instruction to verified outcome</h3>
          </div>
          <span className="execution-diagram-label">CONTROL FLOW</span>
        </div>

        <div className="execution-flow" aria-label="Agent request, identity check, policy evaluation, budget reservation, provider submission, chain reconciliation">
          {executionStages.map((stage, index) => (
            <div className="execution-flow-step" key={stage.number}>
              <div className={`execution-flow-node ${index === 2 ? "is-policy" : index === 5 ? "is-final" : ""}`}>
                <span className="execution-step-number">{stage.number}</span>
                <strong>{stage.title}</strong>
                <span>{stage.detail}</span>
              </div>
              {index < executionStages.length - 1 && (
                <span className="execution-flow-connector" aria-hidden="true">
                  <span />
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="execution-branch">
          <span className="execution-branch-line" aria-hidden="true" />
          <div className="execution-branch-copy">
            <span className="execution-branch-mark">STOP</span>
            <div>
              <strong>Policy rejection</strong>
              <span>A failed check stops the request before provider submission.</span>
            </div>
          </div>
          <div className="execution-branch-note">
            A provider response does not establish chain finality. Unconfirmed transfers remain under review.
          </div>
        </div>
      </div>

      <div className="execution-two-column">
        <section className="execution-panel execution-authority-panel" aria-labelledby="authority-title">
          <div className="execution-panel-heading">
            <div>
              <span className="execution-kicker">02 / FINANCIAL AUTHORITY</span>
              <h3 id="authority-title">Know what an agent can spend.</h3>
            </div>
          </div>
          <p className="execution-panel-lede">
            Spending authority is accounted for across three states. Reservations remain committed until execution is reconciled.
          </p>
          <div className="execution-accounting">
            <div className="execution-accounting-row">
              <span className="execution-accounting-dot dot-blue" />
              <div><strong>Allocated</strong><span>Agent authority ceiling</span></div>
              <span className="execution-accounting-tag">LIMIT</span>
            </div>
            <div className="execution-accounting-row">
              <span className="execution-accounting-dot dot-orange" />
              <div><strong>Reserved</strong><span>Pending transfer commitments</span></div>
              <span className="execution-accounting-tag">HELD</span>
            </div>
            <div className="execution-accounting-row">
              <span className="execution-accounting-dot dot-green" />
              <div><strong>Spent</strong><span>Confirmed execution amount</span></div>
              <span className="execution-accounting-tag">SETTLED</span>
            </div>
          </div>
          <div className="execution-available">
            <span>AVAILABLE AUTHORITY</span>
            <strong>Allocated − Reserved − Spent</strong>
          </div>
          <div className="execution-limit-list">
            <span>CONTROLLED BY</span>
            <span>Per-transfer cap</span>
            <span>Daily limit</span>
            <span>Weekly limit</span>
            <span>Autonomous allowance</span>
          </div>
        </section>

        <section className="execution-panel execution-policy-panel" aria-labelledby="policy-title">
          <div className="execution-panel-heading">
            <div>
              <span className="execution-kicker">03 / POLICY EXPLAINER</span>
              <h3 id="policy-title">Every decision has a reason.</h3>
            </div>
          </div>
          <p className="execution-panel-lede">
            These checks describe the controls evaluated before a transfer can be submitted.
          </p>
          <div className="execution-policy-list">
            {policyChecks.map((check) => (
              <div className="execution-policy-row" key={check.index}>
                <span className="execution-policy-index">{check.index}</span>
                <div>
                  <strong>{check.title}</strong>
                  <span>{check.detail}</span>
                </div>
                <span className="execution-policy-result">{check.result}</span>
              </div>
            ))}
          </div>
          <div className="execution-policy-foot">
            <span className="execution-policy-icon">NOTE</span>
            <span>Illustrative control model. Actual decisions and reasons come from the evaluated request.</span>
          </div>
        </section>
      </div>

      <section className="execution-panel execution-lifecycle-panel" aria-labelledby="lifecycle-title">
        <div className="execution-panel-heading">
          <div>
            <span className="execution-kicker">04 / TRANSACTION LIFECYCLE</span>
            <h3 id="lifecycle-title">Track the full path, not just the provider response.</h3>
          </div>
          <span className="execution-diagram-label">STATE TRANSITIONS</span>
        </div>
        <div className="execution-lifecycle">
          {lifecycle.map((stage, index) => (
            <div className="execution-lifecycle-step" key={stage.title}>
              <span className={`execution-lifecycle-marker tone-${stage.tone}`} />
              <strong>{stage.title}</strong>
              <span>{stage.detail}</span>
              {index < lifecycle.length - 1 && <span className="execution-lifecycle-connector" aria-hidden="true" />}
            </div>
          ))}
        </div>
        <p className="execution-lifecycle-note">
          A transaction can be submitted and still be awaiting chain confirmation. ENCU keeps its reservation held until reconciliation confirms the outcome.
        </p>
      </section>
    </section>
  );
}
