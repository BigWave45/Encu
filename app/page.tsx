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
  policies?: Array<{ agentId: string; maxTransferYocto: string | null; dailyLimitYocto: string | null; weeklyLimitYocto: string | null }>;
  recipients?: Array<{ agentId: string; accountId: string; label: string | null; status: "active" | "revoked"; authorizedAt: string; authorizedBy: string; expiresAt: string | null; revokedAt: string | null; revokedBy: string | null }>;
  budget?: {
    totalLimitYocto: string;
    spentYocto: string;
    reservedYocto: string;
    updatedAt: string;
  };
  agents?: Array<{ id: string; name: string; active: boolean; createdAt: string }>;
  allocations?: Array<{ agentId: string; allocationLimitYocto: string; spentYocto: string; reservedYocto: string; updatedAt: string; updatedBy: string | null }>;
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

function availableAgentNear(allocation: NonNullable<Dashboard["allocations"]>[number]) {
  try {
    return near(String(
      BigInt(allocation.allocationLimitYocto) -
      BigInt(allocation.spentYocto) -
      BigInt(allocation.reservedYocto)
    ));
  } catch {
    return "Unavailable";
  }
}

function totalAgentAllocationsNear(allocations?: Dashboard["allocations"]) {
  try {
    return near((allocations ?? []).reduce((sum, item) => sum + BigInt(item.allocationLimitYocto), 0n).toString());
  } catch {
    return "Unavailable";
  }
}

function unallocatedAuthorityNear(budget: NonNullable<Dashboard["budget"]>, allocations?: Dashboard["allocations"]) {
  try {
    const allocated = (allocations ?? []).reduce((sum, item) => sum + BigInt(item.allocationLimitYocto), 0n);
    return near((BigInt(budget.totalLimitYocto) - allocated).toString());
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
  const [reservationActionMessage, setReservationActionMessage] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState("");
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMessage, setBudgetMessage] = useState("");
  const [allocationAgent, setAllocationAgent] = useState("primary");
  const [allocationLimit, setAllocationLimit] = useState("");
  const [allocationBusy, setAllocationBusy] = useState(false);
  const [allocationMessage, setAllocationMessage] = useState("");
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
  const [recipientAgent, setRecipientAgent] = useState("primary");
  const [recipientAccount, setRecipientAccount] = useState("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientExpires, setRecipientExpires] = useState("");
  const [recipientBusy, setRecipientBusy] = useState(false);
  const [recipientMessage, setRecipientMessage] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState("");
  const [requestAgentToken, setRequestAgentToken] = useState("");
  const [requestAgentId, setRequestAgentId] = useState("test-agent-alpha");
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
        const selectedAllocation = body.allocations?.find((item: NonNullable<Dashboard["allocations"]>[number]) => item.agentId === allocationAgent);
        setAllocationLimit(selectedAllocation ? yoctoToInput(selectedAllocation.allocationLimitYocto) : "");
        const selectedPolicy = body.policies?.find((item: NonNullable<Dashboard["policies"]>[number]) => item.agentId === policyAgent);
        setPolicyMax(selectedPolicy?.maxTransferYocto ? yoctoToInput(selectedPolicy.maxTransferYocto) : "");
        setPolicyDaily(selectedPolicy?.dailyLimitYocto ? yoctoToInput(selectedPolicy.dailyLimitYocto) : "");
        setPolicyWeekly(selectedPolicy?.weeklyLimitYocto ? yoctoToInput(selectedPolicy.weeklyLimitYocto) : "");
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
    // Rejection is a single-tap admin action. Avoid window.prompt(), which is
    // unreliable in embedded mobile browsers. The API records this reason.
    const reason = action === "reject" ? "Rejected by admin. No transfer was submitted." : null;
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

  async function resolveReservation(requestId: string, action: "cancel_expired" | "failed_final", reason: string, txHash?: string | null) {
    if (!adminToken.trim() || reason.trim().length < 3) return;
    const evidenceReference = action === "failed_final" ? txHash : undefined;
    setReservationAction(requestId + ":resolve");
    setReservationActionError("");
    setReservationActionMessage("");
    try {
      const response = await fetch("/api/admin/reservations/resolve", {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken.trim()}`, "content-type": "application/json" },
        body: JSON.stringify(action === "cancel_expired"
          ? { action, requestId, reason: reason.trim() }
          : { action, requestId, reason: reason.trim(), evidenceReference })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setReservationActionError(body.reason ?? body.error ?? "reservation_resolution_failed");
      else {
        setReservationActionMessage("Expired reservation cancelled. Refreshing the budget and transaction history.");
        await loadDashboard();
      }
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

  async function saveAgentAllocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = parseNearToYocto(allocationLimit);
    if (amount === null || amount < 0n) {
      setAllocationMessage("Enter a valid allocation of zero or more NEAR, with up to 24 decimal places.");
      return;
    }
    setAllocationBusy(true);
    setAllocationMessage("");
    try {
      const response = await fetch("/api/admin/agents/allocation", {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ id: allocationAgent, allocationLimitYocto: amount.toString() }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setAllocationMessage(body.error ?? "agent_allocation_update_failed");
      else {
        setAllocationMessage("Agent allocation updated.");
        await loadDashboard();
      }
    } catch {
      setAllocationMessage("Could not confirm the allocation update. Refresh the dashboard before retrying.");
    } finally {
      setAllocationBusy(false);
    }
  }

  async function authorizeRecipient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountId = recipientAccount.trim();
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(accountId) || accountId.length < 2 || accountId.length > 64) {
      setRecipientMessage("Enter an exact NEAR account ID (2–64 lowercase characters).");
      return;
    }
    let expiresAt: string | null = null;
    if (recipientExpires) {
      const parsed = new Date(recipientExpires);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setRecipientMessage("Expiry must be a valid future date and time.");
        return;
      }
      expiresAt = parsed.toISOString();
    }
    setRecipientBusy(true);
    setRecipientMessage("");
    try {
      const response = await fetch("/api/admin/agents/recipients", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ agentId: recipientAgent, accountId, label: recipientLabel.trim() || null, expiresAt }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setRecipientMessage(body.error ?? "recipient_authorization_failed");
      else {
        setRecipientMessage(`Authorized ${accountId} for ${recipientAgent}.`);
        setRecipientAccount("");
        setRecipientLabel("");
        setRecipientExpires("");
        await loadDashboard();
      }
    } catch {
      setRecipientMessage("Could not confirm recipient authorization. Refresh before retrying.");
    } finally {
      setRecipientBusy(false);
    }
  }

  async function revokeRecipient(agentId: string, accountId: string) {
    if (!window.confirm(`Revoke ${accountId} for ${agentId}? Pending requests will remain reserved until rejected or safely cancelled. Already claimed provider submissions cannot be recalled.`)) return;
    setRecipientBusy(true);
    setRecipientMessage("");
    try {
      const response = await fetch("/api/admin/agents/recipients", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken.trim()}` },
        body: JSON.stringify({ agentId, accountId, reason: "Revoked by administrator." }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setRecipientMessage(body.error ?? "recipient_revocation_failed");
      else {
        const result = body.recipient ?? {};
        setRecipientMessage(`Revoked ${accountId}. Pending approvals: ${result.pending_approvals ?? 0}; claimed/in-flight: ${result.claimed_inflight ?? 0}; provider submitted: ${result.provider_submitted ?? 0}. No reservations were automatically released.`);
        await loadDashboard();
      }
    } catch {
      setRecipientMessage("Could not confirm recipient revocation. Refresh before retrying.");
    } finally {
      setRecipientBusy(false);
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
    if (!adminToken.trim()) {
      setReservationActionError("Enter the administrator token before checking or reconciling a reservation.");
      return;
    }
    setReservationAction(requestId + ":" + action);
    setReservationActionError("");
    try {
      const response = await fetch(`/api/agent/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken.trim()}`
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
        const diagnostic = body.checks ? "; checks: " + JSON.stringify(body.checks) : "";
        setReservationActionError(requestId + ": " + body.reason + diagnostic);
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
      if (response.ok) await loadDashboard();
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
          amountYocto: amount.toString(),
          expectedAgentId: requestAgentId
        }),
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({ error: "Invalid server response" }));
      setRequestResult({ httpStatus: response.status, ...body });
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
    <main style={{ maxWidth: 1180, margin: "32px auto", padding: "24px clamp(16px, 3vw, 32px)", fontFamily: "Arial, sans-serif", color: "#0f172a" }}>
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
        {reservationActionError && <p role="alert" style={{ color: "#b91c1c", marginTop: 16 }}>{reservationActionError}</p>}
        {reservationActionMessage && <p role="status" style={{ color: "#166534", marginTop: 16 }}>{reservationActionMessage}</p>}
        {dashboard && <nav aria-label="Dashboard sections" style={{ position: "sticky", top: 0, zIndex: 5, display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18, padding: "10px 0", background: "rgba(255,255,255,0.96)", borderBottom: "1px solid #e2e8f0" }}>
          {[
            ["Overview", "#overview"], ["Treasury", "#treasury-settings"], ["Agents", "#agents"],
            ["Recipients", "#recipients"], ["Payments", "#payments"], ["Approvals", "#approvals"],
            ["Security & audit", "#security-events"], ["Health", "#system-health"], ["Developer tools", "#developer-tools"]
          ].map(([label, href]) => <a key={href} href={href} style={{ padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 999, color: "#334155", textDecoration: "none", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</a>)}
        </nav>}
        <div id="system-health" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap", scrollMarginTop: 76 }}>
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
          <div id="overview" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 12, marginTop: 20, scrollMarginTop: 76 }}>
            {[
              ["Total budget", near(dashboard.budget.totalLimitYocto)],
              ["Allocated to agents", totalAgentAllocationsNear(dashboard.allocations)],
              ["Unallocated authority", unallocatedAuthorityNear(dashboard.budget, dashboard.allocations)],
              ["Spent", near(dashboard.budget.spentYocto)],
              ["Reserved", near(dashboard.budget.reservedYocto)],
              ["Available", availableNear(dashboard.budget)]
            ].map(([label, value]) => <div key={label} style={{ padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9 }}>
              <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
              <div style={{ fontSize: 23, fontWeight: 700, marginTop: 5 }}>{value} <span style={{ fontSize: 12, fontWeight: 400 }}>NEAR</span></div>
            </div>)}
          </div>
          <form id="treasury-settings" onSubmit={updateBudget} style={{ marginTop: 22, padding: 18, border: "1px solid #e2e8f0", borderRadius: 12, scrollMarginTop: 76 }}>
            <strong>Shared budget limit</strong>
            <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>New total limit (NEAR)
              <input type="number" min="0.000000000000000000000001" step="any" value={budgetLimit} onChange={e => setBudgetLimit(e.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
            </label>
            <p style={{ color: "#64748b", fontSize: 12 }}>The limit cannot be reduced below spent plus reserved funds or below the sum of agent allocations. Changes are recorded in the admin audit log.</p>
            <button type="submit" disabled={savingBudget || !adminToken.trim()} style={buttonStyle}>{savingBudget ? "Saving…" : "Update budget limit"}</button>
            {budgetMessage && <p role="status" style={{ fontSize: 13 }}>{budgetMessage}</p>}
          </form>
          <section id="emergency-stop" style={{ marginTop: 14, padding: 18, border: "1px solid #e2e8f0", borderRadius: 12, scrollMarginTop: 76 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div><strong>Global transfer control</strong><p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 0" }}>{dashboard.transfersEnabled ? "Transfers are enabled. The stop blocks new reservations and unclaimed submissions." : "Emergency stop is active. New reservations and unclaimed submissions are blocked."} <span style={{ display: "block", marginTop: 4 }}>The stop cannot recall an OutLayer request already submitted or in flight.</span></p></div>
              <button type="button" onClick={() => setTransfersEnabled(!dashboard.transfersEnabled)} disabled={controlBusy || !adminToken.trim()} style={{ ...buttonStyle, background: dashboard.transfersEnabled ? "#b91c1c" : "#166534", marginTop: 0 }}>
                {controlBusy ? "Updating…" : dashboard.transfersEnabled ? "Emergency stop" : "Enable transfers"}
              </button>
            </div>
            {controlMessage && <p role="status" style={{ fontSize: 13 }}>{controlMessage}</p>}
          </section>
          <form id="agent-policy" onSubmit={saveAgentPolicy} style={{ marginTop: 14, padding: 18, border: "1px solid #e2e8f0", borderRadius: 12, scrollMarginTop: 76 }}>
            <strong>Per-agent spending policy</strong>
            <p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 12px" }}>Limits include active reservations. Daily and weekly limits use rolling 24-hour and 7-day windows. Blank limits add no per-agent cap; the shared budget and global transfer cap still apply. A null recipient list is unrestricted; an empty list blocks every recipient.</p>
            <label style={{ display: "block", fontSize: 13 }}>Agent
              <select value={policyAgent} onChange={e => {
                const id = e.target.value; setPolicyAgent(id);
                const policy = dashboard.policies?.find(item => item.agentId === id);
                setPolicyMax(policy?.maxTransferYocto ? yoctoToInput(policy.maxTransferYocto) : "");
                setPolicyDaily(policy?.dailyLimitYocto ? yoctoToInput(policy.dailyLimitYocto) : "");
                setPolicyWeekly(policy?.weeklyLimitYocto ? yoctoToInput(policy.weeklyLimitYocto) : "");
              }} style={{ ...inputStyle, marginTop: 5 }}>
                {dashboard.agents?.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.id})</option>)}
              </select>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginTop: 10 }}>
              <label style={{ fontSize: 13 }}>Max per transfer (NEAR)<input value={policyMax} onChange={e => setPolicyMax(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
              <label style={{ fontSize: 13 }}>Rolling 24h limit (NEAR)<input value={policyDaily} onChange={e => setPolicyDaily(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
              <label style={{ fontSize: 13 }}>Rolling 7d limit (NEAR)<input value={policyWeekly} onChange={e => setPolicyWeekly(e.target.value)} placeholder="No additional limit" style={{ ...inputStyle, marginTop: 5 }} /></label>
            </div>
            <button type="submit" disabled={policyBusy || !adminToken.trim()} style={buttonStyle}>{policyBusy ? "Saving…" : "Save agent policy"}</button>
            {policyMessage && <p role="status" style={{ fontSize: 13 }}>{policyMessage}</p>}
          </form>
          <form id="agent-allocations" onSubmit={saveAgentAllocation} style={{ marginTop: 14, padding: 18, border: "1px solid #e2e8f0", borderRadius: 12, scrollMarginTop: 76 }}>
            <strong>Agent treasury allocation</strong>
            <p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 12px" }}>An allocation is a sub-limit inside the global treasury ceiling, not additional funds. Spent and reserved amounts count against it. New agents start at zero and cannot reserve funds until an administrator assigns an allocation.</p>
            <label style={{ display: "block", fontSize: 13 }}>Agent
              <select value={allocationAgent} onChange={event => {
                const id = event.target.value;
                setAllocationAgent(id);
                const allocation = dashboard.allocations?.find(item => item.agentId === id);
                setAllocationLimit(allocation ? yoctoToInput(allocation.allocationLimitYocto) : "");
                setAllocationMessage("");
              }} style={{ ...inputStyle, marginTop: 5 }}>
                {(dashboard.agents ?? []).map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}
              </select>
            </label>
            {(() => {
              const allocation = dashboard.allocations?.find(item => item.agentId === allocationAgent);
              return allocation ? <p style={{ color: "#64748b", fontSize: 12, margin: "8px 0" }}>
                Spent: {near(allocation.spentYocto)} NEAR · Reserved: {near(allocation.reservedYocto)} NEAR · Available: {availableAgentNear(allocation)} NEAR
              </p> : <p style={{ color: "#92400e", fontSize: 12 }}>No allocation ledger row exists for this agent. The allocation migration must be applied before editing.</p>;
            })()}
            <label style={{ display: "block", fontSize: 13, marginTop: 8 }}>Allocation limit (NEAR)
              <input inputMode="decimal" value={allocationLimit} onChange={event => setAllocationLimit(event.target.value)} required style={{ ...inputStyle, marginTop: 5 }} />
            </label>
            <button type="submit" disabled={allocationBusy || !adminToken.trim() || !dashboard.allocations?.some(item => item.agentId === allocationAgent)} style={buttonStyle}>
              {allocationBusy ? "Saving…" : "Save agent allocation"}
            </button>
            {allocationMessage && <p role="status" style={{ fontSize: 13 }}>{allocationMessage}</p>}
          </form>
          <section id="recipients" style={{ marginTop: 14, padding: 18, border: "1px solid #e2e8f0", borderRadius: 12, scrollMarginTop: 76 }}>
            <strong>Authorized recipients</strong>
            <p style={{ color: "#64748b", fontSize: 12, margin: "5px 0 12px" }}>Only exact NEAR account IDs authorized by an administrator can receive new transfers. Labels are display-only. Revocation blocks future requests and approvals; it does not recall claimed provider submissions or release pending reservations.</p>
            <form onSubmit={authorizeRecipient} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
              <label style={{ fontSize: 13 }}>Agent
                <select value={recipientAgent} onChange={e => setRecipientAgent(e.target.value)} style={{ ...inputStyle, marginTop: 5 }}>
                  {(dashboard.agents ?? []).map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.id})</option>)}
                </select>
              </label>
              <label style={{ fontSize: 13 }}>Exact NEAR account ID
                <input value={recipientAccount} onChange={e => setRecipientAccount(e.target.value)} placeholder="recipient.near" required style={{ ...inputStyle, marginTop: 5 }} />
              </label>
              <label style={{ fontSize: 13 }}>Label (optional)
                <input value={recipientLabel} onChange={e => setRecipientLabel(e.target.value)} maxLength={80} placeholder="Treasury wallet" style={{ ...inputStyle, marginTop: 5 }} />
              </label>
              <label style={{ fontSize: 13 }}>Expires at (optional)
                <input type="datetime-local" value={recipientExpires} onChange={e => setRecipientExpires(e.target.value)} style={{ ...inputStyle, marginTop: 5 }} />
              </label>
              <div style={{ display: "flex", alignItems: "end" }}>
                <button type="submit" disabled={recipientBusy || !adminToken.trim()} style={buttonStyle}>{recipientBusy ? "Saving…" : "Authorize recipient"}</button>
              </div>
            </form>
            <div style={{ marginTop: 14 }}>
              {(dashboard.recipients ?? []).filter(item => item.agentId === recipientAgent).length === 0
                ? <p style={{ color: "#92400e", fontSize: 13 }}>No recipients are authorized for this agent. New transfer requests will be denied until an administrator authorizes an account ID.</p>
                : (dashboard.recipients ?? []).filter(item => item.agentId === recipientAgent).map(item => {
                  const expired = item.expiresAt ? new Date(item.expiresAt).getTime() <= Date.now() : false;
                  const active = item.status === "active" && !expired;
                  return <div key={item.agentId + ":" + item.accountId} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid #e2e8f0" }}>
                    <div style={{ minWidth: 180, flex: 1 }}>
                      <strong style={{ fontSize: 13 }}>{item.label || item.accountId}</strong>
                      <div style={{ fontSize: 12, color: "#64748b" }}>{item.accountId}</div>
                      <div style={{ fontSize: 11, color: "#64748b" }}>{active ? "Authorized" : expired ? "Expired" : "Revoked"} · by {item.authorizedBy}{item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleString()}` : ""}</div>
                    </div>
                    {active && <button type="button" disabled={recipientBusy} onClick={() => revokeRecipient(item.agentId, item.accountId)} style={buttonStyle}>Revoke</button>}
                  </div>;
                })}
            </div>
            {recipientMessage && <p role="status" style={{ fontSize: 13 }}>{recipientMessage}</p>}
          </section>
          <h3 id="agents" style={{ margin: "24px 0 10px", fontSize: 17, scrollMarginTop: 76 }}>Agents ({dashboard.agents?.length ?? 0})</h3>
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
          <h3 id="approvals" style={{ margin: "24px 0 10px", fontSize: 17, scrollMarginTop: 76 }}>Transfers awaiting approval ({dashboard.reservations?.filter(item => item.status === "awaiting_approval").length ?? 0})</h3>
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
                  {item.approvalExpiresAt && Date.now() >= new Date(item.approvalExpiresAt).getTime() && <button type="button" disabled={reservationAction !== null || !adminToken.trim()} onClick={() => resolveReservation(item.requestId, "cancel_expired", "Expired request was never submitted")} style={{ ...buttonStyle, marginTop: 4, background: "#475569" }}>Cancel expired request</button>}
                </div>
              </div>)}
            </div>}
          <h3 id="payments" style={{ margin: "24px 0 10px", fontSize: 17, scrollMarginTop: 76 }}>Transaction history ({dashboard.reservationPage?.total ?? dashboard.reservations?.length ?? 0} records)</h3>
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
              {item.status === "awaiting_approval" && item.approvalExpiresAt && new Date(item.approvalExpiresAt).getTime() <= Date.now() && !item.providerRequestId && !item.txHash && !item.approvedAt && <button type="button" disabled={reservationAction !== null || !adminToken.trim()} onClick={() => resolveReservation(item.requestId, "cancel_expired", "Expired request was never submitted")} style={{ ...buttonStyle, marginTop: 10, fontSize: 12, padding: "8px 10px", background: "#92400e" }}>{reservationAction === item.requestId + ":resolve" ? "Cancelling expired reservation…" : "Cancel expired, unsubmitted request"}</button>}
              {(item.status === "needs_review" || item.status === "reserved") && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                {item.providerRequestId && <button type="button"
                  disabled={reservationAction !== null || !adminToken.trim()}
                  onClick={() => inspectReservation(item.requestId, "provider-status")}
                  style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", opacity: reservationAction !== null ? 0.55 : 1 }}>
                  {reservationAction === item.requestId + ":provider-status" ? "Checking provider…" : "Check provider"}
                </button>}
                {item.txHash && <button type="button"
                  disabled={reservationAction !== null || !adminToken.trim()}
                  onClick={() => inspectReservation(item.requestId, "reconcile")}
                  style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", opacity: reservationAction !== null ? 0.55 : 1 }}>
                  {reservationAction === item.requestId + ":reconcile" ? "Checking NEAR…" : "Reconcile on NEAR"}
                </button>}
                {item.txHash && <button type="button" disabled={reservationAction !== null || !adminToken.trim()} onClick={() => resolveReservation(item.requestId, "failed_final", "Provider confirms final failure", item.txHash)} style={{ ...buttonStyle, marginTop: 0, fontSize: 12, padding: "8px 10px", background: "#475569" }}>Resolve verified final failure</button>}
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
          <h3 id="security-events" style={{ margin: "24px 0 10px", fontSize: 17, scrollMarginTop: 76 }}>Transfer security events ({dashboard.activityPages?.security?.total ?? dashboard.securityEvents?.length ?? 0})</h3>
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

      <section id="developer-tools" style={{ ...panel, scrollMarginTop: 76 }}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Developer tools · Live agent request test</h2>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
          Sends a real authenticated request to AgentGuard&apos;s reservation API. It does not call OutLayer. The agent token is held only in this page&apos;s memory and cleared after submission.
        </p>
        <form onSubmit={submitAgentRequest} style={{ display: "grid", gap: 10 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Test agent
            <select value={requestAgentId} onChange={event => setRequestAgentId(event.target.value)} style={{ ...inputStyle, marginTop: 6 }}>
              <option value="test-agent-alpha">Alpha · test-agent-alpha</option>
              <option value="test-agent-beta">Beta · test-agent-beta</option>
            </select>
            <span style={{ display: "block", color: "#64748b", fontSize: 12, fontWeight: 400, marginTop: 5 }}>AgentGuard verifies this selection against the identity in the token. A mismatch is rejected before reserving funds.</span>
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

      <section id="agent-access" style={{ ...panel, scrollMarginTop: 76 }}>
        <h2 style={{ fontSize: 21, margin: "0 0 8px" }}>Agent access management</h2>
        <p style={{ color: "#64748b", fontSize: 13 }}>Provisioning and credential rotation are administrator-only operations.</p>
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
