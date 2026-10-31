"use client";

import { useState } from "react";

type BalanceResult = {
  status?: string;
  chain?: string;
  balance?: unknown;
  error?: string;
  providerStatus?: number;
};

export default function Home() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<BalanceResult | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "Arial, sans-serif", color: "#0f172a" }}>
      <p style={{ color: "#64748b", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>NEAR · Agent Security</p>
      <h1 style={{ fontSize: 40, margin: "8px 0 12px" }}>AgentGuard</h1>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>
        Read the OutLayer wallet's native NEAR testnet balance. This check does not initiate a transfer.
      </p>

      <form onSubmit={checkBalance} style={{ marginTop: 32, padding: 24, border: "1px solid #e2e8f0", borderRadius: 12 }}>
        <label htmlFor="agent-token" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
          AgentGuard access token
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
          The token is held only in this page's memory and sent to your AgentGuard endpoint. It is not saved to browser storage. Do not share it in chat.
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
    </main>
  );
}
