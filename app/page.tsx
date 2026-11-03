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
  transfersEnabled?: boolean;
  policies?: Array<{ agentId: string; maxTransferYocto: string | null; dailyLimitYocto: string | null; weeklyLimitYocto: string | null; allowedRecipients: string[] | null }>;
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
    approvalExpiresAt?: string | null;
    approvedAt?: string | null;
    approvedBy?: string | null;
    rejectedAt?: string | null;
    rejectedBy?: string | null;
    approvalReason?: string | null;
    cancelledAt?: string | null;
    cancelledBy?: string | null;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    resolutionReason?: string | null;
    resolutionEvidenceReference?: string | null;
  }>;
  audit?: Array<{ id: string; actorAgentId: string; action: string; targetId: string | null; details: unknown; createdAt: string }>;
  securityEvents?: Array<{ id: string; actorAgentId: string | null; eventType: string; requestId: string | null; details: unknown; createdAt: string }>;
  reservationPage?: { page: number; pageSize: number; total: number; totalPages: number; status: string; search: string };
  activityPages?: {
    pageSize: number;
    audit: { page: number; total: number; totalPages: number };
    security: { page: number; total: number; totalPages: number };
  };
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

function yoctoToInput(value: string) {
  try {
    const amount = BigInt(value);
    const whole = amount / YOCTO_PER_NEAR;
    const fraction = (amount % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return "";
  }
}

function availableNear(budget: NonNullable<Dashboard["budget"]>) {
  try {
    return near(String(
      BigInt(budget.totalLimitYocto) -
      BigInt(budget.spentYocto) -
      BigInt(budget.reservedYocto)
    ));
  } catch {
    return "Unavailable";
  }
}

function parseNearToYocto(value: string): bigint | null {
  const match = value.trim().match(/^(0|[1-9]\d*)(?:\.(\d{1,24}))?$/);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(24, "0");
  return BigInt(match[1]) * YOCTO_PER_NEAR + BigInt(fraction || "0");
}

export default function Home() {
  const [token, setToken] = useState("");
  const [adminToken, setAdminToken] = useState("");
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
  const [rotationAgentId, setRotationAgentId] = useState("");
  const [reservationAction, setReservationAction] = useState<string | null>(null);
  const [reservationActionError, setReservationActionError] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState("");
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMessage, setBudgetMessage] = useState("");
  const [agentStatusBusy, setAgentStatusBusy] = useState<string | null>(null);
  const [reservationSearch, setReservationSearch] = useState("");
  const [reservationFilter, setReservationFilter] = useState("all");
  const [reservationPage, setReservationPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [securityPage, setSecurityPage] = useState(1);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const [policyAgent, setPolicyAgent] = useState("primary");
  const [policyMax, setPolicyMax] = useState("");
  const [policyDaily, setPolicyDaily] = useState("");
  const [policyWeekly, setPolicyWeekly] = useState("");
  const [policyRecipients, setPolicyRecipients] = useState("");
  const [policyDenyAll, setPolicyDenyAll] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState("");
  const [requestAgentToken, setRequestAgentToken] = useState("");
  const [requestAgentLabel, setRequestAgentLabel] = useState("Alpha");
  const [requestRecipient, setRequestRecipient] = useState("lensherr.testnet");
  const [requestAmount, setRequestAmount] = useState("3");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestResult, setRequestResult] = useState<Record<string, unknown> | null>(null);


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

  async function loadDashboard(page = reservationPage, status = reservationFilter, search = reservationSearch, nextAuditPage = auditPage, nextSecurityPage = securityPage) {
    setDashboardLoading(true);
    setDashboardError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20", status, q: search.trim(), auditPage: String(nextAuditPage), securityPage: String(nextSecurityPage) });
      const response = await fetch(`/api/admin/dashboard?${params.toString()}`, {
        headers: { authorization: `Bearer ${adminToken.trim()}` },
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      if (!response.ok) {
        setDashboard(null);
        setDashboardError(body.error ?? "dashboard_request_failed");
      } else {
        setDashboard(body);
        const rotatableAgents = (body.agents ?? []).filter((agent: NonNullable<Dashboard["agents"]>[number]) => agent.id !== "primary");
        if (rotatableAgents.length && !rotatableAgents.some((agent: NonNullable<Dashboard["agents"]>[number]) => agent.id === rotationAgentId)) {
          setRotationAgentId(rotatableAgents[0].id);
        }
        setReservationPage(body.reservationPage?.page ?? page);
        setAuditPage(body.activityPages?.audit?.page ?? nextAuditPage);
        setSecurityPage(body.activityPages?.security?.page ?? nextSecurityPage);
        setBudgetLimit(yoctoToInput(body.budget.totalLimitYocto));
        const selectedPolicy = body.policies?.find((item: NonNullable<Dashboard["policies"]>[number]) => item.agentId === policyAgent);
        setPolicyMax(selectedPolicy?.maxTransferYocto ? yoctoToInput(selectedPolicy.maxTransferYocto) : "");
        setPolicyDaily(selectedPolicy?.dailyLimitYocto ? yoctoToInput(selectedPolicy.dailyLimitYocto) : "");
        setPolicyWeekly(selectedPolicy?.weeklyLimitYocto ? yoctoToInput(selectedPolicy.weeklyLimitYocto) : "");
        setPolicyRecipients(selectedPolicy?.allowedRecipients?.join("\n") ?? "");
        setPolicyDenyAll(Array.isArray(selectedPolicy?.allowedRecipients) && selectedPolicy.allowedRecipients.length === 0);
      }
    } catch {
      setDashboard(null);
      setDashboardError("Could not reach AgentGuard. Check your connection and try again.");
    } finally {
      setDashboardLoading(false);
    }
  }

  async function setTransfersEnabled(enabled: boolean) {
    if (!adminToken.trim()) return;
    const action = enabled ? "enable transfers" : "STOP all new transfers";
    if (!window.confirm(`Confirm: ${action}?`)) return;
    setControlBusy(true);
    setControlMessage("");
    try {
      const response = await fetch("/api/admin/transfers", {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setControlMessage(body.error ?? "transfer_control_update_failed");
      else {
        setControlMessage(enabled ? "Transfers enabled." : "Emergency stop active. New submissions are blocked.");
        await loadDashboard();
      }
    } catch {
      setControlMessage("Could not confirm transfer-control state. Refresh the dashboard before relying on it.");
    } finally {
      setControlBusy(false);
    }
  }

  async function saveAgentPolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const max = policyMax.trim() ? parseNearToYocto(policyMax) : null;
    const daily = policyDaily.trim() ? parseNearToYocto(policyDaily) : null;
    const weekly = policyWeekly.trim() ? parseNearToYocto(policyWeekly) : null;
    if ((policyMax.trim() && (!max || max <= 0n)) || (policyDaily.trim() && (!daily || daily <= 0n)) || (policyWeekly.trim() && (!weekly || weekly <= 0n))) {
      setPolicyMessage("Enter valid positive NEAR limits or leave a field blank for no additional limit.");
      return;
    }
    const recipients = policyDenyAll ? [] : policyRecipients.trim()
      ? policyRecipients.split("\n").map(value => value.trim()).filter(Boolean)
      : null;
    setPolicyBusy(true);
    setPolicyMessage("");
    try {
      const response = await fetch("/api/admin/agents/policy", {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: policyAgent,
          maxTransferYocto: max?.toString() ?? null,
          dailyLimitYocto: daily?.toString() ?? null,
          weeklyLimitYocto: weekly?.toString() ?? null,
          allowedRecipients: recipients
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setPolicyMessage(body.reason ?? body.error ?? "agent_policy_update_failed");
      else {
        setPolicyMessage("Agent policy saved.");
        await loadDashboard();
      }
    } catch {
      setPolicyMessage("Could not confirm policy update.");
    } finally {
      setPolicyBusy(false);
    }
  }

  async function decideTransfer(requestId: string, action: "approve" | "reject") {
    if (!adminToken.trim()) return;
    const reason = action === "reject" ? window.prompt("Reason for rejecting this transfer?") : null;
    if (action === "reject" && (!reason || reason.trim().length < 3)) return;
    setReservationAction(requestId);
    setReservationActionError("");
    try {
      const response = await fetch("/api/admin/approvals", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
        body: JSON.stringify(action === "approve"
          ? { action, requestId }
          : { action, requestId, reason: reason?.trim() })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setReservationActionError(body.reason ?? body.error ?? "approval_action_failed");
      else await loadDashboard();
    } catch {
      setReservationActionError("Could not confirm the approval action. Refresh before retrying.");
    } finally {
      setReservationAction(null);
    }
  }

  async function resolveReservation(requestId: string, action: "cancel_expired" | "failed_final", txHash?: string | null) {
    if (!adminToken.trim()) return;
    const reason = window.prompt(action === "cancel_expired"
      ? "Why are you cancelling this expired request? It must still be unapproved and have no provider references."
      : "Reason for resolving this transfer as a final NEAR failure?");
    if (!reason || reason.trim().length < 3) return;
    const evidenceReference = action === "failed_final"
      ? window.prompt("Evidence reference (transaction hash or explorer URL):", txHash ?? "")
      : undefined;
    if (action === "failed_final" && (!evidenceReference || evidenceReference.trim().length < 8)) return;

    setReservationAction(requestId + ":resolve");
    setReservationActionError("");
    try {
      const response = await fetch("/api/admin/reservations/resolve", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
        body: JSON.stringify(action === "cancel_expired"
          ? { action, requestId, reason: reason.trim() }
          : { action, requestId, reason: reason.trim(), evidenceReference: evidenceReference?.trim() })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setReservationActionError(body.reason ?? body.reason ?? body.error ?? "reservation_resolution_failed");
      else await loadDashboard();
    } catch {
      setReservationActionError("Could not confirm the resolution. Refresh the dashboard before retrying.");
    } finally {
      setReservationAction(null);
    }
  }

  async function loadHealth() {
    setHealthLoading(true);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = await response.json().catch(() => ({ status: "invalid_response" }));
      setHealth(body);
    } catch {
      setHealth({ status: "unreachable" });
    } finally {
      setHealthLoading(false);
    }
  }

  async function updateBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const yocto = parseNearToYocto(budgetLimit);
    if (yocto === null || yocto <= 0n) {
      setBudgetMessage("Enter a positive NEAR limit with up to 24 decimal places.");
      return;
    }
    setSavingBudget(true);
    setBudgetMessage("");
    try {
      const response = await fetch("/api/admin/budget", {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ limitYocto: yocto.toString() }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setBudgetMessage(body.error ?? "budget_update_failed");
      else {
        setBudgetMessage("Budget limit updated.");
        await loadDashboard();
      }
    } catch {
      setBudgetMessage("Could not reach AgentGuard. Budget update was not confirmed.");
    } finally {
      setSavingBudget(false);
    }
  }

  async function setAgentStatus(id: string, active: boolean) {
    const action = active ? "activate" : "deactivate";
    if (!window.confirm(`Are you sure you want to ${action} agent "${id}"? ${active ? "The agent will be allowed to submit requests again." : "New requests from this agent will be rejected."}`)) return;
    setAgentStatusBusy(id);
    setDashboardError("");
    try {
      const response = await fetch("/api/admin/agents/status", {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ id, active }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDashboardError(body.error ?? "agent_status_update_failed");
      } else {
        await loadDashboard();
      }
    } catch {
      setDashboardError("Could not reach AgentGuard. Agent status was not confirmed.");
    } finally {
      setAgentStatusBusy(null);
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
    const selectedAgent = dashboard?.agents?.find(agent => agent.id === rotationAgentId);
    if (!selectedAgent || selectedAgent.id === "primary") {
      setRotationResult({ error: "Select an existing non-primary agent from the loaded dashboard." });
      return;
    }
    const confirmed = window.confirm(
      `Rotate credentials for "${selectedAgent.name}" (${selectedAgent.id})? The current token will stop working immediately. A replacement token will be shown once. This does not delete the agent.`
    );
    if (!confirmed) return;

    setRotatingAgent(true);
    setRotationResult(null);
    try {
      const response = await fetch("/api/agent/agents/rotate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ id: selectedAgent.id }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setRotationResult({ httpStatus: response.status, ...body });
    } catch {
      setRotationResult({ error: "Could not reach AgentGuard. Rotation outcome is unconfirmed. Refresh the dashboard and check before retrying." });
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
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
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

  async function submitAgentRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = parseNearToYocto(requestAmount);
    if (!amount || amount <= 0n || !requestAgentToken.trim()) {
      setRequestResult({ error: "Enter a valid positive NEAR amount and agent token." });
      return;
    }
    setRequestBusy(true);
    setRequestResult(null);
    try {
      const response = await fetch("/api/agent/transfer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requestAgentToken.trim()}`
        },
        body: JSON.stringify({
          requestId: `ag-${crypto.randomUUID()}`,
          to: requestRecipient.trim(),
          amountYocto: amount.toString()
        }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setRequestResult({ httpStatus: response.status, agentLabel: requestAgentLabel, ...body });
    } catch {
      setRequestResult({ error: "Could not reach AgentGuard. Request outcome is unconfirmed; check transaction history before retrying." });
    } finally {
      setRequestBusy(false);
      setRequestAgentToken("");
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
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>Use an agent token to check its wallet balance. The administrator token is required for the dashboard, budget controls, agent provisioning and credential rotation. The token stays in this page&apos;s memory and is not saved to browser storage. Never share it in chat.</p>
        <button type="submit" disabled={loading || !token.trim()} style={buttonStyle}>{loading ? "Checking…" : "Check NEAR balance"}</button>
        <label htmlFor="admin-token" style={{ display: "block", fontWeight: 600, margin: "20px 0 8px" }}>Administrator token</label>
        <input id="admin-token" type="password" autoComplete="off" value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)} placeholder="Enter your AGENTGUARD_ADMIN_TOKEN"
          style={inputStyle} />
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>The administrator token is separate from agent credentials. Use it only for the dashboard, budget controls and agent management. It cannot submit transfers.</p>
      </form>

      {result && <section aria-live="polite" style={panel}>
        <strong>{result.status === "ok" ? "Balance response" : "Request response"}</strong>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 12, fontSize: 13 }}>{JSON.stringify(result, null, 2)}</pre>
      </section>}

      <section style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div><h2 style={{ fontSize: 21, margin: "0 0 6px" }}>Shared budget dashboard</h2>
            <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>Shared budget, agent identities and recent payments. Pending payments can be checked and reconciled here.</p></div>
          <button type="button" onClick={() => loadDashboard()} disabled={!adminToken.trim() || dashboardLoading}
            style={{ ...buttonStyle, marginTop: 0, opacity: !adminToken.trim() || dashboardLoading ? 0.55 : 1 }}>
            {dashboardLoading ? "Loading…" : dashboard ? "Refresh dashboard" : "Load dashboard"}
          </button>
        </div>
        {dashboardError && <p role="alert" style={{ color: "#b91c1c", marginTop: 16 }}>{dashboardError}</p>}
        {reservationActionError && <p role="alert" style={{ color: "#92400e", marginTop: 16 }}>{reservationActionError}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <strong>System health</strong>
          <button type="button" onClick={loadHealth} disabled={healthLoading} style={{ ...buttonStyle, marginTop: 0 }}>{healthLoading ? "Checking…" : "Check system health"}</button>
        </div>
        {health && <div role="status" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 8, marginTop: 12, padding: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13 }}>
          <div><strong>Overall</strong><div>{String(health.status ?? "unknown")}</div></div>
          <div><strong>Network</strong><div>{String(health.network ?? "unknown")}</div></div>
          <div><strong>Supabase</strong><div>{String(health.supabase ?? health.status ?? "unknown")}</div></div>
          <div><strong>NEAR RPC</strong><div>{String(health.nearRpc ?? "unknown")}</div></div>
          <div><strong>OutLayer</strong><div>{String(health.outlayer ?? "unknown")}</div></div>
          <div><strong>Signer match</strong><div>{health.signerMatches === true ? "Yes" : health.signerMatches === false ? "No" : "Unknown"}</div></div>
        </div>}
        {dashboard?.budget && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, marginTop: 20 }}>
            {[
              ["Total budget", near(dashboard.budget.totalLimitYocto)],
              ["Spent", near(dashboard.budget.spentYocto)],
              ["Reserved", near(dashboard.budget.reservedYocto)],
              ["Available", availableNear(dashboard.budget)]
            ].map(([label, value]) => <div key={label} style={{ padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9 }}>
              <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 23, fontWeight: 700, marginTop: 5 }}>{value} <span style={{ fontSize: 12, fontWeight: 400 }}>NEAR</span></div>
            </div>)}
          </div>
          <form onSubmit={updateBudget} style={{ marginTop: 22, padding: 14, border: "1px solid #e2e8f0", borderRadius: 9 }}>
            <strong>Shared budget limit</strong>
            <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>New total limit (NEAR)
              <input type="number" min="0.000000000000000000000001" step="any" value={budgetLimit} onChange={e => setBudgetLimit(e.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
            </label>
            <p style={{ color: "#64748b", fontSize: 12 }}>The limit cannot be reduced below spent plus reserved funds. Changes are recorded in the admin audit log.</p>
            <button type="submit" disabled={savingBudget || !adminToken.trim()} style={buttonStyle}>{savingBudget ? "Saving…" : "Update budget limit"}</button>
            {budgetMessage && <p role="status" style={{ fontSize: 13 }}>{budgetMessage}</p>}
          </form>
          <section style={{ marginTop: 22, padding: 14, border: "1px solid #e2e8f0", borderRadius: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div><strong>Global transfer control</strong><p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 0" }}>{dashboard.transfersEnabled ? "Transfers are enabled. The stop blocks new reservations and unclaimed submissions." : "Emergency stop is active. New reservations and unclaimed submissions are blocked."} <span style={{ display: "block", marginTop: 4 }}>The stop cannot recall an OutLayer request already submitted or in flight.</span></p></div>
              <button type="button" onClick={() => setTransfersEnabled(!dashboard.transfersEnabled)} disabled={controlBusy || !adminToken.trim()} style={{ ...buttonStyle, background: dashboard.transfersEnabled ? "#b91c1c" : "#166534", marginTop: 0 }}>
                {controlBusy ? "Updating…" : dashboard.transfersEnabled ? "Emergency stop" : "Enable transfers"}
              </button>
            </div>
            {controlMessage && <p role="status" style={{ fontSize: 13 }}>{controlMessage}</p>}
          </section>
          <form onSubmit={saveAgentPolicy} style={{ marginTop: 14, padding: 14, border: "1px solid #e2e8f0", borderRadius: 9 }}>
            <strong>Per-agent spending policy</strong>
            <p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 12px" }}>Limits include active reservations. Daily and weekly limits use rolling 24-hour and 7-day windows. Blank limits add no per-agent cap; the shared budget and global transfer cap still apply. A null recipient list is unrestricted; an empty list blocks every recipient.</p>
            <label style={{ display: "block", fontSize: 13 }}>Agent
              <select value={policyAgent} onChange={e => {
                const id = e.target.value; setPolicyAgent(id);
                const policy = dashboard.policies?.find(item => item.agentId === id);
                setPolicyMax(policy?.maxTransferYocto ? yoctoToInput(policy.maxTransferYocto) : "");
                setPolicyDaily(policy?.dailyLimitYocto ? yoctoToInput(policy.dailyLimitYocto) : "");
                setPolicyWeekly(policy?.weeklyLimitYocto ? yoctoToInput(policy.weeklyLimitYocto) : "");
                setPolicyRecipients(policy?.allowedRecipients?.join("\n") ?? "");
                setPolicyDenyAll(Array.isArray(policy?.allowedRecipients) && policy.allowedRecipients.length === 0);
              }} style={{ ...inputStyle, marginTop: 5 }}>
                {dashboard.agents?.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.id})</option>)}
              </select>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginTop: 10 }}>
              <label style={{ fontSize: 13 }}>Max per transfer (NEAR)<input value={policyMax} onChange={e => setPolicyMax(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
              <label style={{ fontSize: 13 }}>Rolling 24h limit (NEAR)<input value={policyDaily} onChange={e => setPolicyDaily(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
              <label style={{ fontSize: 13 }}>Rolling 7d limit (NEAR)<input value={policyWeekly} onChange={e => setPolicyWeekly(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 10 }}><input type="checkbox" checked={policyDenyAll} onChange={e => setPolicyDenyAll(e.target.checked)} /> Block all recipients (empty allowlist)</label>
            <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>Allowed NEAR recipients, one account ID per line<textarea value={policyRecipients} disabled={policyDenyAll} onChange={e => setPolicyRecipients(e.target.value)} rows={3} placeholder="Leave blank to allow any valid recipient" style={{ ...inputStyle, marginTop: 5, opacity: policyDenyAll ? 0.5 : 1 }} /></label>
            <button type="submit" disabled={policyBusy || !adminToken.trim()} style={buttonStyle}>{policyBusy ? "Saving…" : "Save agent policy"}</button>
            {policyMessage && <p role="status" style={{ fontSize: 13 }}>{policyMessage}</p>}
          </form>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Agents ({dashboard.agents?.length ?? 0})</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["Agent","ID","Status"].map(x => <th key={x} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #cbd5e1" }}>{x}</th>)}</tr></thead>
              <tbody>{dashboard.agents?.map(agent => <tr key={agent.id}>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.name}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.id}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>{agent.active ? "Active" : "Inactive"} {agent.id !== "primary" && <button type="button" disabled={agentStatusBusy === agent.id || !adminToken.trim()} onClick={() => setAgentStatus(agent.id, !agent.active)} style={{ marginLeft: 8, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }}>{agentStatusBusy === agent.id ? "Saving…" : agent.active ? "Deactivate" : "Activate"}</button>}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Transfers awaiting approval ({dashboard.reservations?.filter(item => item.status === "awaiting_approval").length ?? 0})</h3>
          {!dashboard.reservations?.some(item => item.status === "awaiting_approval") ? <p style={{ color: "#64748b", fontSize: 13 }}>No pending approvals on this page. Use the status filter to find other pending requests.</p> :
            <div style={{ display: "grid", gap: 10 }}>
              {dashboard.reservations.filter(item => item.status === "awaiting_approval").map(item => <div key={item.requestId} style={{ padding: 13, border: "1px solid #f59e0b", borderRadius: 8, fontSize: 13 }}>
                <strong>{item.agentId}</strong> requests {near(item.amountYocto)} NEAR
                <p style={{ margin: "6px 0" }}>Recipient: <code>{item.recipient}</code></p>
                <p style={{ margin: "6px 0", color: "#64748b" }}>Request ID: {item.requestId}</p>
                <p style={{ margin: "6px 0", color: "#64748b" }}>Expires: {item.approvalExpiresAt ? new Date(item.approvalExpiresAt).toLocaleString() : "Not available"}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" disabled={reservationAction === item.requestId || !adminToken.trim()} onClick={() => decideTransfer(item.requestId, "approve")} style={{ ...buttonStyle, marginTop: 4 }}>Approve and submit</button>
                  <button type="button" disabled={reservationAction === item.requestId || !adminToken.trim()} onClick={() => decideTransfer(item.requestId, "reject")} style={{ ...buttonStyle, marginTop: 4, background: "#991b1b" }}>Reject</button>
                  {item.approvalExpiresAt && Date.now() >= new Date(item.approvalExpiresAt).getTime() && <button type="button" disabled={reservationAction !== null || !adminToken.trim()} onClick={() => resolveReservation(item.requestId, "cancel_expired")} style={{ ...buttonStyle, marginTop: 4, background: "#475569" }}>Cancel expired request</button>}
                </div>
              </div>)}
            </div>}
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Transaction history ({dashboard.reservationPage?.total ?? dashboard.reservations?.length ?? 0} records)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8, marginBottom: 12 }}>
            <input aria-label="Search transactions" placeholder="Search request, agent, recipient or tx hash" value={reservationSearch} onChange={e => setReservationSearch(e.target.value)} style={inputStyle} />
            <select aria-label="Filter transaction status" value={reservationFilter} onChange={e => setReservationFilter(e.target.value)} style={inputStyle}>
              <option value="all">All statuses</option><option value="aged">Aged / ambiguous (15+ min)</option><option value="awaiting_approval">Awaiting approval</option><option value="reserved">Reserved</option><option value="needs_review">Needs review</option><option value="executed">Executed</option><option value="failed">Failed</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option>
            </select>
            <button type="button" onClick={() => loadDashboard(1, reservationFilter, reservationSearch)} disabled={dashboardLoading} style={{ ...buttonStyle, marginTop: 0 }}>{dashboardLoading ? "Loading…" : "Apply filters"}</button>
          </div>
          {!dashboard.reservations?.length ? <p style={{ color: "#64748b", fontSize: 14 }}>No matching reservations.</p> :
            <div style={{ display: "grid", gap: 10 }}>{dashboard.reservations.map(item => <div key={item.requestId} style={{ padding: 13, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>{item.agentId}</strong><strong>{item.status}</strong>
              </div>
              <div style={{ marginTop: 6 }}>{near(item.amountYocto)} NEAR → {item.recipient}</div>
              <div style={{ color: "#64748b", marginTop: 4 }}>Created {new Date(item.createdAt).toLocaleString()} · {Math.max(0, Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 60000))} min ago</div>
              <div style={{ color: "#64748b", marginTop: 5, overflowWrap: "anywhere" }}>Request: {item.requestId}</div>
              {item.txHash && <div style={{ color: "#64748b", marginTop: 4, overflowWrap: "anywhere" }}>Tx: {item.txHash}</div>}
              {item.providerRequestId && <div style={{ color: "#64748b", marginTop: 4, overflowWrap: "anywhere" }}>Provider request: {item.providerRequestId}</div>}
              {item.lastError && <div style={{ color: "#92400e", marginTop: 4 }}>Review: {item.lastError}</div>}
              {item.resolutionReason && <div style={{ color: "#475569", marginTop: 4 }}>Resolution: {item.resolutionReason} · by {item.resolvedBy ?? "unknown"} · {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : ""}</div>}
              {item.resolutionEvidenceReference && <div style={{ color: "#64748b", marginTop: 4, overflowWrap: "anywhere" }}>Evidence: {item.resolutionEvidenceReference}</div>}
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
                {item.txHash && <button type="button" disabled={reservationAction !== null || !adminToken.trim()} onClick={() => resolveReservation(item.requestId, "failed_final", item.txHash)} style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", background: "#475569" }}>Resolve verified final failure</button>}
                {!item.providerRequestId && !item.txHash && <span style={{ color: "#92400e", fontSize: 12 }}>No provider reference or transaction hash. This remains held until evidence proves no transfer was submitted. Do not retry or release it manually.</span>}
              </div>}
            </div>)}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <span style={{ color: "#64748b", fontSize: 12 }}>Page {dashboard.reservationPage?.page ?? 1} of {dashboard.reservationPage?.totalPages ?? 1} · {dashboard.reservationPage?.total ?? dashboard.reservations?.length ?? 0} matching records</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" disabled={dashboardLoading || (dashboard.reservationPage?.page ?? 1) <= 1} onClick={() => loadDashboard(Math.max(1, (dashboard.reservationPage?.page ?? 1) - 1))} style={{ ...buttonStyle, marginTop: 0 }}>Previous</button>
              <button type="button" disabled={dashboardLoading || (dashboard.reservationPage?.page ?? 1) >= (dashboard.reservationPage?.totalPages ?? 1)} onClick={() => loadDashboard((dashboard.reservationPage?.page ?? 1) + 1)} style={{ ...buttonStyle, marginTop: 0 }}>Next</button>
            </div>
          </div>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Admin activity ({dashboard.activityPages?.audit?.total ?? dashboard.audit?.length ?? 0})</h3>
          {!dashboard.audit?.length ? <p style={{ color: "#64748b", fontSize: 13 }}>No admin actions recorded yet.</p> :
            <div style={{ display: "grid", gap: 8 }}>{dashboard.audit.map(entry => <div key={entry.id} style={{ padding: 11, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}>
              <strong>{entry.action}</strong> · {entry.targetId ?? "system"}<div style={{ color: "#64748b", marginTop: 4 }}>By {entry.actorAgentId} · {new Date(entry.createdAt).toLocaleString()}</div>
              <div style={{ overflowWrap: "anywhere", marginTop: 4 }}>{JSON.stringify(entry.details)}</div>
            </div>)}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8 }}>
            <span style={{ color: "#64748b", fontSize: 12 }}>Page {dashboard.activityPages?.audit?.page ?? 1} of {dashboard.activityPages?.audit?.totalPages ?? 1}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={dashboardLoading || (dashboard.activityPages?.audit?.page ?? 1) <= 1} onClick={() => loadDashboard(reservationPage, reservationFilter, reservationSearch, Math.max(1, auditPage - 1), securityPage)} style={{ ...buttonStyle, marginTop: 0 }}>Previous</button>
              <button type="button" disabled={dashboardLoading || (dashboard.activityPages?.audit?.page ?? 1) >= (dashboard.activityPages?.audit?.totalPages ?? 1)} onClick={() => loadDashboard(reservationPage, reservationFilter, reservationSearch, auditPage + 1, securityPage)} style={{ ...buttonStyle, marginTop: 0 }}>Next</button>
            </div>
          </div>
          <h3 style={{ margin: "24px 0 10px", fontSize: 17 }}>Transfer security events ({dashboard.activityPages?.security?.total ?? dashboard.securityEvents?.length ?? 0})</h3>
          {!dashboard.securityEvents?.length ? <p style={{ color: "#64748b", fontSize: 13 }}>No transfer security events recorded yet.</p> :
            <div style={{ display: "grid", gap: 8 }}>{dashboard.securityEvents.map(event => <div key={event.id} style={{ padding: 11, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}>
              <strong>{event.eventType}</strong>
              <div style={{ color: "#64748b", marginTop: 4 }}>Agent: {event.actorAgentId ?? "Unauthenticated"} · {new Date(event.createdAt).toLocaleString()}</div>
              {event.requestId && <div style={{ overflowWrap: "anywhere", marginTop: 4 }}>Request: {event.requestId}</div>}
            </div>)}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 8 }}>
            <span style={{ color: "#64748b", fontSize: 12 }}>Page {dashboard.activityPages?.security?.page ?? 1} of {dashboard.activityPages?.security?.totalPages ?? 1}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={dashboardLoading || (dashboard.activityPages?.security?.page ?? 1) <= 1} onClick={() => loadDashboard(reservationPage, reservationFilter, reservationSearch, auditPage, Math.max(1, securityPage - 1))} style={{ ...buttonStyle, marginTop: 0 }}>Previous</button>
              <button type="button" disabled={dashboardLoading || (dashboard.activityPages?.security?.page ?? 1) >= (dashboard.activityPages?.security?.totalPages ?? 1)} onClick={() => loadDashboard(reservationPage, reservationFilter, reservationSearch, auditPage, securityPage + 1)} style={{ ...buttonStyle, marginTop: 0 }}>Next</button>
            </div>
          </div>
          <p style={{ color: "#94a3b8", fontSize: 11, marginTop: 18 }}>Updated {dashboard.generatedAt ? new Date(dashboard.generatedAt).toLocaleString() : "just now"}. Values are read from the AgentGuard database.</p>
        </>}
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Live agent request test</h2>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
          Sends a real authenticated request to AgentGuard&apos;s reservation API. It does not call OutLayer. The agent token is held only in this page&apos;s memory and cleared after submission.
        </p>
        <form onSubmit={submitAgentRequest} style={{ display: "grid", gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Test agent
            <select value={requestAgentLabel} onChange={event => setRequestAgentLabel(event.target.value)} style={{ ...inputStyle, marginTop: 6 }}>
              <option value="Alpha">Alpha</option>
              <option value="Beta">Beta</option>
            </select>
          </label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Agent credential
            <input type="password" autoComplete="off" value={requestAgentToken} onChange={event => setRequestAgentToken(event.target.value)} required placeholder="Paste this agent's token here" style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Recipient NEAR account
            <input value={requestRecipient} onChange={event => setRequestRecipient(event.target.value)} required style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Amount (NEAR)
            <input inputMode="decimal" value={requestAmount} onChange={event => setRequestAmount(event.target.value)} required style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <button type="submit" disabled={requestBusy || !requestAgentToken.trim()} style={{ ...buttonStyle, opacity: requestBusy || !requestAgentToken.trim() ? 0.6 : 1 }}>
            {requestBusy ? "Submitting request…" : "Submit live agent request"}
          </button>
        </form>
        {requestResult && <div aria-live="polite" style={{ marginTop: 14, padding: 12, border: "1px solid #cbd5e1", borderRadius: 8 }}>
          <strong>Request response</strong>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{JSON.stringify(requestResult, null, 2)}</pre>
        </div>}
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Provision another agent</h2>
        <p style={{ color: "#64748b", fontSize: 14, lineHeight: 1.5 }}>Create a separate credential for an agent that shares the same NEAR spending budget. Only the primary admin token can do this.</p>
        <form onSubmit={createAgent}>
          <label htmlFor="agent-id" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent ID</label>
          <input id="agent-id" value={agentId} onChange={(event) => setAgentId(event.target.value)} required minLength={2} maxLength={48} pattern="[a-z0-9_-]+" style={inputStyle} />
          <label htmlFor="agent-name" style={{ display: "block", fontWeight: 600, margin: "16px 0 8px" }}>Agent name</label>
          <input id="agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} required minLength={2} maxLength={80} style={inputStyle} />
          <button type="submit" disabled={creatingAgent || !adminToken.trim()} style={buttonStyle}>{creatingAgent ? "Creating…" : "Create agent credential"}</button>
        </form>

        <form onSubmit={rotateAgent} style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid #e2e8f0" }}>
          <strong>Replace an agent&apos;s access token</strong>
          <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
            Select an existing agent below. This replaces only that agent&apos;s credential. The old token becomes invalid immediately; the agent identity, policy, budget and transaction history remain in place. The new token is displayed once.
          </p>
          <label htmlFor="rotation-agent" style={{ display: "block", fontWeight: 600, margin: "12px 0 8px" }}>Agent whose token will be replaced</label>
          <select id="rotation-agent" value={rotationAgentId} onChange={event => { setRotationAgentId(event.target.value); setRotationResult(null); }}
            disabled={!dashboard?.agents?.some(agent => agent.id !== "primary") || rotatingAgent}
            style={inputStyle}>
            {(dashboard?.agents ?? []).filter(agent => agent.id !== "primary").map(agent =>
              <option key={agent.id} value={agent.id}>{agent.name} · {agent.id} · {agent.active ? "Active" : "Inactive"}</option>
            )}
          </select>
          {!dashboard && <p style={{ color: "#92400e", fontSize: 12 }}>Load the dashboard first so the target is selected from the actual agent list.</p>}
          {dashboard && !dashboard.agents?.some(agent => agent.id !== "primary") && <p style={{ color: "#92400e", fontSize: 12 }}>There are no rotatable agents. The primary admin identity cannot be rotated here.</p>}
          <button type="submit" disabled={rotatingAgent || !adminToken.trim() || !rotationAgentId || !dashboard?.agents?.some(agent => agent.id === rotationAgentId && agent.id !== "primary")}
            style={{ ...buttonStyle, background: "#7f1d1d" }}>
            {rotatingAgent ? "Replacing token…" : rotationAgentId ? `Replace token for ${dashboard?.agents?.find(agent => agent.id === rotationAgentId)?.name ?? rotationAgentId}` : "Select an agent"}
          </button>
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
