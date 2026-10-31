"use client";

import { useState } from "react";

type BalanceResult = {
  status?: string;
  chain?: string;
  balance?: unknown;
  error?: string;
  providerStatus?: number;
};

type AgentResult = {
  status?: string;
  agent?: { id: string; name: string };
  token?: string;
  warning?: string;
  error?: string;
};

export default function Home() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<BalanceResult | null>(null);
  const [agentId, setAgentId] = useState("research-agent");
  const [agentName, setAgentName] = useState("Research Agent");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [rotationResult, setRotationResult] = useState<AgentResult | null>(null);
  const [rotatingAgent, setRotatingAgent] = useState(false);

  async function checkBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("/api/agent/balance", {
        method: "GET",
        headers: { authorization: `Bearer ${token.trim()}` },
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setResult(body);
    } catch {
      setResult({ error: "Could not reach AgentGuard. Check your connection and try again." });
    } finally {
      setLoading(false);
    }
  }

  async function rotateAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRotatingAgent(true);
    setRotationResult(null);
    try {
      const response = await fetch("/api/agent/agents/rotate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.trim()}`
        },
        body: JSON.stringify({ id: agentId.trim() }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setRotationResult(body);
    } catch {
      setRotationResult({ error: "Could not reach AgentGuard. Check your connection and try again." });
    } finally {
      setRotatingAgent(false);
    }
  }

  async function createAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingAgent(true);
    setAgentResult(null);
    try {
      const response = await fetch("/api/agent/agents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.trim()}`
        },
        body: JSON.stringify({ id: agentId.trim(), name: agentName.trim() }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setAgentResult(body);
    } catch {
      setAgentResult({ error: "Could not reach AgentGuard. Check your connection and try again." });
    } finally {
      setCreatingAgent(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "Arial, sans-serif", color: "#0f172a" }}>
      <p style={{ color: "#64748b", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>NEAR · Agent Security</p>
      <h1 style={{ fontSize: 40, margin: "8px 0 12px" }}>AgentGuard</h1>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>
        Control agent spending through a shared budget and policy gateway.
      </p>

      <form onSubmit={checkBalance} style={{ marginTop: 32, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
        <label htmlFor="agent-token" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
          Primary admin token
        </label>
        <input
          id="agent-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Enter your AGENTGUARD_AGENT_TOKEN"
          required
          style={{ boxSizing: "border-box", width: "100%", padding: 12, border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 16 }}
        />
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
          The token stays in this page's memory and is sent only to your AgentGuard API. It is not saved to browser storage. Never share it in chat.
        </p>
        <button
          type="submit"
          disabled={loading || !token.trim()}
          style={{ marginTop: 8, padding: "11px 18px", border: 0, borderRadius: 8, background: loading ? "#64748b" : "#0f172a", color: "white", fontSize: 15, cursor: loading ? "wait" : "pointer" }}
        >
          {loading ? "Checking…" : "Check NEAR balance"}
        </button>
      </form>

      {result && (
        <section aria-live="polite" style={{ marginTop: 24, padding: 20, border: "1px solid #e2e8f0", borderRadius: 12 }}>
          <strong>{result.status === "ok" ? "Balance response" : "Request response"}</strong>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}

      <section style={{ marginTop: 32, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Provision another agent</h2>
        <p style={{ color: "#64748b", fontSize: 14, lineHeight: 1.5 }}>
          Create a separate credential for an agent that will share the same NEAR spending budget. Only the primary admin token can do this.
        </p>
        <form onSubmit={createAgent}>
          <label htmlFor="agent-id" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent ID</label>
          <input id="agent-id" value={agentId} onChange={(event) => setAgentId(event.target.value)} required minLength={2} maxLength={48}
            pattern="[a-z0-9_-]+" style={{ boxSizing: "border-box", width: "100%", padding: 12, border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 16 }} />
          <label htmlFor="agent-name" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent name</label>
          <input id="agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} required minLength={2} maxLength={80}
            style={{ boxSizing: "border-box", width: "100%", padding: 12, border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 16 }} />
          <button type="submit" disabled={creatingAgent || !token.trim()}
            style={{ marginTop: 16, padding: "11px 18px", border: 0, borderRadius: 8, background: creatingAgent ? "#64748b" : "#0f172a", color: "white", fontSize: 15, cursor: creatingAgent ? "wait" : "pointer" }}>
            {creatingAgent ? "Creating…" : "Create agent credential"}
          </button>
        </form>

        <form onSubmit={rotateAgent} style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid #e2e8f0" }}>
          <strong>Rotate an agent credential</strong>
          <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
            Revoke the existing credential for the Agent ID above and issue a replacement.
          </p>
          <button type="submit" disabled={rotatingAgent || !token.trim() || !agentId.trim()}
            style={{ marginTop: 8, padding: "11px 18px", border: 0, borderRadius: 8, background: rotatingAgent ? "#64748b" : "#7f1d1d", color: "white", fontSize: 15 }}>
            {rotatingAgent ? "Rotating…" : "Rotate agent credential"}
          </button>
        </form>
        {rotationResult && (
          <div aria-live="polite" style={{ marginTop: 20, padding: 16, border: "1px solid #cbd5e1", borderRadius: 8 }}>
            {rotationResult.token ? (
              <>
                <strong>Credential rotated: {rotationResult.agent?.name} ({rotationResult.agent?.id})</strong>
                <p style={{ color: "#b45309", fontSize: 13 }}>The previous credential is invalid. Save this replacement securely; it is shown once.</p>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, background: "#f1f5f9", borderRadius: 6 }}>{rotationResult.token}</pre>
                <button type="button" onClick={() => navigator.clipboard?.writeText(rotationResult.token!)}
                  style={{ padding: "9px 14px", border: 0, borderRadius: 6, background: "#0f172a", color: "white" }}>Copy replacement token</button>
              </>
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(rotationResult, null, 2)}</pre>
            )}
          </div>
        )}
        {agentResult && (
          <div aria-live="polite" style={{ marginTop: 20, padding: 16, border: "1px solid #cbd5e1", borderRadius: 8 }}>
            {agentResult.token ? (
              <>
                <strong>Agent created: {agentResult.agent?.name} ({agentResult.agent?.id})</strong>
                <p style={{ color: "#b45309", fontSize: 13 }}>Copy this token now. It is shown once and cannot be retrieved again.</p>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, background: "#f1f5f9", borderRadius: 6 }}>{agentResult.token}</pre>
                <button type="button" onClick={() => navigator.clipboard?.writeText(agentResult.token!)}
                  style={{ padding: "9px 14px", border: 0, borderRadius: 6, background: "#0f172a", color: "white" }}>Copy agent token</button>
              </>
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(agentResult, null, 2)}</pre>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
