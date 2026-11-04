"use client";
import { useState } from "react";

const YOCTO = 10n ** 24n;

function parseNear(value: string): string | null {
  const input = value.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(input)) return null;
  const [whole, fraction = ""] = input.split(".");
  const amount = BigInt(whole) * YOCTO + BigInt((fraction + "0".repeat(24)).slice(0, 24));
  return amount > 0n ? amount.toString() : null;
}

export default function AgentPlayground({ agentId }: { agentId: string }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [payload, setPayload] = useState("");
  const [message, setMessage] = useState("");

  function build() {
    setMessage("");
    setPayload("");
    const amountYocto = parseNear(amount);
    const to = recipient.trim();
    if (!amountYocto) {
      setMessage("Enter a positive amount with no more than 24 decimal places.");
      return;
    }
    if (to.length > 64 || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(to)) {
      setMessage("Enter a valid lowercase NEAR account ID (maximum 64 characters).");
      return;
    }
    const requestId = "encu-" + crypto.randomUUID();
    setPayload(JSON.stringify({ requestId, to, amountYocto, expectedAgentId: agentId }, null, 2));
  }

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payload);
      setMessage("JSON payload copied.");
    } catch {
      setMessage("Clipboard unavailable. Select and copy the JSON manually.");
    }
  }

  return <section className="developer-playground">
    <span className="developer-section-kicker">DEVELOPER TOOL</span>
    <h4>Request payload builder</h4>
    <p>Prepare a request body for this agent. This tool does not submit a request or execute a transfer.</p>
    <div className="developer-playground-fields">
      <label>Recipient NEAR account<input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="recipient.near" autoCapitalize="none" autoCorrect="off" /></label>
      <label>Amount (NEAR)<input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.001" inputMode="decimal" /></label>
    </div>
    <div className="developer-playground-controls">
      <button className="developer-button" type="button" onClick={build}>Generate payload</button>
      {payload && <button className="developer-button secondary" type="button" onClick={() => void copyPayload()}>Copy JSON</button>}
    </div>
    {message && <p className="developer-playground-warning" role="status">{message}</p>}
    {payload && <pre className="developer-playground-payload">{payload}</pre>}
    <p className="developer-playground-warning">A generated payload is not an authorization decision. Your backend must authenticate the agent and enforce current allocation, limits and recipient permissions before execution.</p>
  </section>;
}
