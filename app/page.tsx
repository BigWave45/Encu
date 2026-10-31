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

type Dashboard = {
  status?: string;
  error?: string;
  generatedAt?: string;
  budget?: {
    totalLimitYocto: string;
    spentYocto: string;
    reservedYocto: string;
    updatedAt: string;
  };
  agents?: Array<{ id: string; name: string; active: boolean; createdAt: string }>;
  reservations?: Array<{
    requestId: string;
    agentId: string;
    recipient: string;
    amountYocto: string;
    status: string;
    txHash: string | null;
    providerRequestId: string | null;
    lastError: string | null;
    createdAt: string;
  }>;
};

const YOCTO_PER_NEAR = 10n ** 24n;
const DISPLAY_PRECISION = 10n ** 20n;
function near(value: string) {
  try {
    const amount = BigInt(value);
    const whole = amount / YOCTO_PER_NEAR;
    const fraction = ((amount % YOCTO_PER_NEAR) / DISPLAY_PRECISION)
      .toString()
      .padStart(4, "0")
      .replace(/0+$/, "");
    return fraction
      ? `${whole.toLocaleString("en-US")}.${fraction}`
      : whole.toLocaleString("en-US");
  } catch {
    return "Unavailable";
  }
}

export default function Home() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<BalanceResult | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [agentId, setAgentId] = useState("research-agent");
  const [agentName, setAgentName] = useState("Research Agent");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [rotationResult, setRotationResult] = useState<AgentResult | null>(null);
  const [rotatingAgent, setRotatingAgent] = useState(false);
  const [reservationAction, setReservationAction] = useState<string | null>(null);
  const [reservationActionError, setReservationActionError] = useState("");

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

  async function loadDashboard() {
    setDashboardLoading(true);
    setDashboardError("");
    try {
      const response = await fetch("/api/admin/dashboard", {
        headers: { authorization: `Bearer ${token.trim()}` },
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      if (!response.ok) {
        setDashboard(null);
        setDashboardError(body.error ?? "dashboard_request_failed");
      } else {
        setDashboard(body);
      }
    } catch {
      setDashboard(null);
      setDashboardError("Could not reach AgentGuard. Check your connection and try again.");
    } finally {
      setDashboardLoading(false);
    }
  }

  async function inspectReservation(requestId: string, action: "provider-status" | "reconcile") {
    setReservationAction(requestId + ":" + action);
    setReservationActionError("");
    try {
      const response = await fetch(`/api/agent/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token.trim()}`
        },
        body: JSON.stringify({ requestId }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      if (!response.ok && response.status !== 202) {
        setReservationActionError(body.error ?? body.reason ?? `${action}_failed`);
      }
      await loadDashboard();
      if (body.reason && body.status === "needs_review") {
        setReservationActionError(`${requestId}: ${body.reason}`);
      }
    } catch {
      setReservationActionError(`${requestId}: Could not reach AgentGuard. The reservation state has not been verified.`);
    } finally {
      setReservationAction(null);
    }
  }

  async function rotateAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRotatingAgent(true);
    setRotationResult(null);
    try {
      const response = await fetch("/api/agent/agents/rotate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
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
        headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
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

  const panel = { marginTop: 24, padding: 20, border: "1px solid #e2e8f0", borderRadius: 12 };
  const inputStyle = { boxSizing: "border-box" as const, width: "100%", padding: 12, border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 16 };
  const buttonStyle = { marginTop: 12, padding: "11px 18px", border: 0, borderRadius: 8, background: "#0f172a", color: "white", fontSize: 15, cursor: "pointer" as const };

  return (
    <main style={{ maxWidth: 820, margin: "48px auto", padding: 24, fontFamily: "Arial, sans-serif", color: "#0f172a" }}>
      <p style={{ color: "#64748b", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>NEAR · Agent Security</p>
      <h1 style={{ fontSize: 40, margin: "8px 0 12px" }}>AgentGuard</h1>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>Control agent spending through a shared budget and policy gateway.</p>

      <form onSubmit={checkBalance} style={{ ...panel, marginTop: 28 }}>
        <label htmlFor="agent-token" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>Agent or admin token</label>
        <input id="agent-token" type="password" autoComplete="off" value={token}
          onChange={(event) => setToken(event.target.value)} placeholder="Enter your AGENTGUARD_AGENT_TOKEN"
          required style={inputStyle} />
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>Use an agent token to check its wallet balance. The primary admin token is required for the dashboard, agent provisioning and credential rotation. The token stays in this page's memory and is not saved to browser storage. Never share it in chat.</p>
        <button type="submit" disabled={loading || !token.trim()} style={buttonStyle}>{loading ? "Checking…" : "Check NEAR balance"}</button>
      </form>

      {result && <section aria-live="polite" style={panel}>
        <strong>{result.status === "ok" ? "Balance response" : "Request response"}</strong>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 12, fontSize: 13 }}>{JSON.stringify(result, null, 2)}</pre>
      </section>}

      <section style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div><h2 style={{ fontSize: 21, margin: "0 0 6px" }}>Shared budget dashboard</h2>
            <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>Shared budget, agent identities and recent payments. Pending payments can be checked and reconciled here.</p></div>
          <button type="button" onClick={loadDashboard} disabled={!token.trim() || dashboardLoading}
            style={{ ...buttonStyle, marginTop: 0, opacity: !token.trim() || dashboardLoading ? 0.55 : 1 }}>
            {dashboardLoading ? "Loading…" : dashboard ? "Refresh dashboard" : "Load dashboard"}
          </button>
        </div>
        {dashboardError && <p role="alert" style={{ color: "#b91c1c", marginTop: 16 }}>{dashboardError}</p>}
        {reservationActionError && <p role="alert" style={{ color: "#92400e", marginTop: 16 }}>{reservationActionError}</p>}
        {dashboard?.budget && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, marginTop: 20 }}>
            {[
              ["Total budget", near(dashboard.budget.totalLimitYocto)],
              ["Spent", near(dashboard.budget.spentYocto)],
              ["Reserved", near(dashboard.budget.reservedYocto)],
              ["Available", near(String(BigInt(dashboard.budget.totalLimitYocto) - BigInt(dashboard.budget.spentYocto) - BigInt(dashboard.budget.reservedYocto)))]
            ].map(([label, value]) => <div key={label} style={{ padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9 }}>
              <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 23, fontWeight: 700, marginTop: 5 }}>{value} <span style={{ fontSize: 12, fontWeight: 400 }}>NEAR</span></div>
            </div>)}
          </div>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Agents ({dashboard.agents?.length ?? 0})</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["Agent","ID","Status"].map(x => <th key={x} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #cbd5e1" }}>{x}</th>)}</tr></thead>
              <tbody>{dashboard.agents?.map(agent => <tr key={agent.id}>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.name}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.id}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.active ? "Active" : "Inactive"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Recent reservations</h3>
          {!dashboard.reservations?.length ? <p style={{ color: "#64748b", fontSize: 14 }}>No reservations recorded yet.</p> :
            <div style={{ display: "grid", gap: 10 }}>{dashboard.reservations.map(item => <div key={item.requestId} style={{ padding: 13, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>{item.agentId}</strong><strong>{item.status}</strong>
              </div>
              <div style={{ marginTop: 6 }}>{near(item.amountYocto)} NEAR → {item.recipient}</div>
              <div style={{ color: "#64748b", marginTop: 5, overflowWrap: "anywhere" }}>Request: {item.requestId}</div>
              {item.txHash && <div style={{ color: "#64748b", marginTop: 4, overflowWrap: "anywhere" }}>Tx: {item.txHash}</div>}
              {item.providerRequestId && <div style={{ color: "#64748b", marginTop: 4, overflowWrap: "anywhere" }}>Provider request: {item.providerRequestId}</div>}
              {item.lastError && <div style={{ color: "#92400e", marginTop: 4 }}>Review: {item.lastError}</div>}
              {(item.status === "needs_review" || item.status === "reserved") && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                {item.providerRequestId && <button type="button"
                  disabled={reservationAction !== null}
                  onClick={() => inspectReservation(item.requestId, "provider-status")}
                  style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", opacity: reservationAction !== null ? 0.55 : 1 }}>
                  {reservationAction === item.requestId + ":provider-status" ? "Checking provider…" : "Check provider"}
                </button>}
                {item.txHash && <button type="button"
                  disabled={reservationAction !== null}
                  onClick={() => inspectReservation(item.requestId, "reconcile")}
                  style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", opacity: reservationAction !== null ? 0.55 : 1 }}>
                  {reservationAction === item.requestId + ":reconcile" ? "Checking NEAR…" : "Reconcile on NEAR"}
                </button>}
                {!item.providerRequestId && !item.txHash && <span style={{ color: "#92400e", fontSize: 12 }}>No provider reference or transaction hash. Manual investigation required; do not retry this payment.</span>}
              </div>}
            </div>)}</div>}
          <p style={{ color: "#94a3b8", fontSize: 11, marginTop: 18 }}>Updated {dashboard.generatedAt ? new Date(dashboard.generatedAt).toLocaleString() : "just now"}. Values are read from the AgentGuard database.</p>
        </>}
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Provision another agent</h2>
        <p style={{ color: "#64748b", fontSize: 14, lineHeight: 1.5 }}>Create a separate credential for an agent that shares the same NEAR spending budget. Only the primary admin token can do this.</p>
        <form onSubmit={createAgent}>
          <label htmlFor="agent-id" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent ID</label>
          <input id="agent-id" value={agentId} onChange={(event) => setAgentId(event.target.value)} required minLength={2} maxLength={48} pattern="[a-z0-9_-]+" style={inputStyle} />
          <label htmlFor="agent-name" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent name</label>
          <input id="agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} required minLength={2} maxLength={80} style={inputStyle} />
          <button type="submit" disabled={creatingAgent || !token.trim()} style={buttonStyle}>{creatingAgent ? "Creating…" : "Create agent credential"}</button>
        </form>

        <form onSubmit={rotateAgent} style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid #e2e8f0" }}>
          <strong>Rotate an agent credential</strong>
          <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>Revoke the existing credential for the Agent ID above and issue a replacement.</p>
          <button type="submit" disabled={rotatingAgent || !token.trim() || !agentId.trim()} style={{ ...buttonStyle, background: "#7f1d1d" }}>{rotatingAgent ? "Rotating…" : "Rotate agent credential"}</button>
        </form>
        {rotationResult && <div aria-live="polite" style={{ marginTop: 20, padding: 16, border: "1px solid #cbd5e1", borderRadius: 8 }}>
          {rotationResult.token ? <>
            <strong>Credential rotated: {rotationResult.agent?.name} ({rotationResult.agent?.id})</strong>
            <p style={{ color: "#b45309", fontSize: 13 }}>The previous credential is invalid. Save this replacement securely; it is shown once.</p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, background: "#f1f5f9", borderRadius: 6 }}>{rotationResult.token}</pre>
            <button type="button" onClick={() => navigator.clipboard?.writeText(rotationResult.token!)} style={buttonStyle}>Copy replacement token</button>
          </> : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(rotationResult, null, 2)}</pre>}
        </div>}
        {agentResult && <div aria-live="polite" style={{ marginTop: 20, padding: 16, border: "1px solid #cbd5e1", borderRadius: 8 }}>
          {agentResult.token ? <>
            <strong>Agent created: {agentResult.agent?.name} ({agentResult.agent?.id})</strong>
            <p style={{ color: "#b45309", fontSize: 13 }}>Copy this token now. It is shown once and cannot be retrieved again.</p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, background: "#f1f5f9", borderRadius: 6 }}>{agentResult.token}</pre>
            <button type="button" onClick={() => navigator.clipboard?.writeText(agentResult.token!)} style={buttonStyle}>Copy agent token</button>
          </> : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(agentResult, null, 2)}</pre>}
        </div>}
      </section>
    </main>
  );
}
