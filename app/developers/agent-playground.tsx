"use client";
import { useState } from "react";

export default function AgentPlayground({ agentId }: { agentId: string }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [payload, setPayload] = useState("");
  function build() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(recipient.trim())) {
      setPayload("Enter a valid recipient and positive amount.");
      return;
    }
    const requestId = "encu-" + crypto.randomUUID();
    const amountYocto = (BigInt(Math.round(n * 1000000)) * 1000000000000000000n).toString();
    setPayload(JSON.stringify({ requestId, to: recipient.trim(), amountYocto, expectedAgentId: agentId }, null, 2));
  }
  return <section className="developer-playground">
    <span className="developer-section-kicker">DEVELOPER TOOL</span>
    <h4>Request payload builder</h4>
    <p>Prepare a request body for this agent. This tool does not submit a request or execute a transfer.</p>
    <div className="developer-playground-fields">
      <label>Recipient NEAR account<input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="recipient.near" /></label>
      <label>Amount (NEAR)<input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.001" inputMode="decimal" /></label>
    </div>
    <button className="developer-button" type="button" onClick={build}>Generate payload</button>
    {payload && <pre className="developer-playground-payload">{payload}</pre>}
    <p className="developer-playground-warning">A generated payload is not an authorization decision. Your backend must authenticate the agent and enforce current spending policy before execution.</p>
  </section>;
}
