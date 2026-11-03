import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const mockPort = 54321;
const appPort = 3000;
const tokens = {
  "agent-one-token": { id: "primary", active: true },
  "agent-two-token": { id: "research-agent", active: true },
  "inactive-agent-token": { id: "inactive-agent", active: false }
};
const reservations = new Map();
const securityEvents = [];
const rateWindows = new Map();
const agentPolicies = new Map([["primary", {}], ["research-agent", {}]]);
const allocations = new Map([
  ["primary", { agent_id: "primary", allocation_limit_yocto: (2n * 10n ** 24n).toString(), spent_yocto: "0", reserved_yocto: "0", updated_at: "2026-01-01T00:00:00.000Z", updated_by: "admin" }],
  ["research-agent", { agent_id: "research-agent", allocation_limit_yocto: (3n * 10n ** 24n).toString(), spent_yocto: "0", reserved_yocto: "0", updated_at: "2026-01-01T00:00:00.000Z", updated_by: "admin" }]
]);
const recipientAuthorizations = new Map();
const systemControls = { transfers_enabled: true, updated_at: "2026-01-01T00:00:00.000Z", updated_by: "admin" };
let mockSignerAddress = "agentguard.testnet";
let mockBudgetReadError = false;
const counters = { reserve: 0, finish: 0, record: 0, provider: 0, providerStatus: 0 };
const budget = 5n * 10n ** 24n;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const mockAgents = [
  { id: "primary", name: "Primary Agent", active: true, created_at: "2026-01-01T00:00:00.000Z" },
  { id: "research-agent", name: "Research Agent", active: true, created_at: "2026-01-02T00:00:00.000Z" }
];
const agentsByHash = new Map(Object.entries(tokens).map(([token, agent]) => [hash(token), agent.id]));
const mockBudget = { id: "default", total_limit_yocto: budget.toString(), spent_yocto: "0", reserved_yocto: "0", updated_at: "2026-01-01T00:00:00.000Z" };
const adminAudit = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const mock = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${mockPort}`);
    if (req.method === "POST" && url.pathname === "/") {
      const body = await readJson(req);
      if (body.method === "status") return send(res, 200, { jsonrpc: "2.0", id: body.id, result: { chain_id: "testnet" } });
      if (body.method === "tx") return send(res, 200, {
        jsonrpc: "2.0", id: body.id,
        result: {
          final_execution_status: "FINAL",
          transaction: {
            signer_id: "agentguard.testnet",
            receiver_id: "recipient.near",
            actions: [{ Transfer: { deposit: "1000000000000000000000000" } }]
          },
          status: { Failure: { error_message: "mock final failure" } }
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/wallet/v1/address") return send(res, 200, { executor_account_id: mockSignerAddress });
    if (req.method === "GET" && url.pathname === "/wallet/v1/policy") return send(res, 200, {
      policy: {
        rules: { limits: { per_transaction: { native: "1000000000000000000000000" } }, transaction_types: ["transfer"] },
        approval: { threshold: { required: 1 }, approvers: [{ id: "lensherr.testnet", role: "admin" }] },
        capabilities: { evm_sign: { allowed: false }, solana_sign: { allowed: false } },
        api_key: "must-not-be-returned"
      },
      internal_debug: "must-not-be-returned"
    });
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_budgets") {
      if (mockBudgetReadError) return send(res, 500, {
        code: "42501",
        message: "permission denied for table agent_budgets; internal diagnostic"
      });
      return send(res, 200, [mockBudget]);
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agentguard_system_controls") return send(res, 200, [systemControls]);
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_policies") {
      const rows = [...agentPolicies.entries()].map(([agent_id, policy]) => ({ agent_id, ...policy }));
      res.setHeader("content-range", `0-${Math.max(0, rows.length - 1)}/${rows.length}`);
      return send(res, 200, rows);
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_allocations") {
      const rows = [...allocations.values()];
      res.setHeader("content-range", `0-${Math.max(0, rows.length - 1)}/${rows.length}`);
      return send(res, 200, rows);
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_authorized_recipients") {
      let rows = [...recipientAuthorizations.values()];
      for (const field of ["agent_id", "account_id", "status"]) {
        const value = url.searchParams.get(field)?.replace(/^eq\./, "");
        if (value) rows = rows.filter(row => String(row[field]) === value);
      }
      res.setHeader("content-range", `0-${Math.max(0, rows.length - 1)}/${rows.length}`);
      return send(res, 200, rows);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/agent_policies") {
      const body = await readJson(req);
      agentPolicies.set(body.agent_id, {});
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agentguard_admin_audit") {
      res.setHeader("content-range", `0-${Math.max(0, adminAudit.length - 1)}/${adminAudit.length}`);
      return send(res, 200, adminAudit.slice().reverse());
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agentguard_security_events") {
      res.setHeader("content-range", `0-${Math.max(0, securityEvents.length - 1)}/${securityEvents.length}`);
      return send(res, 200, securityEvents.slice().reverse());
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/agentguard_security_events") {
      securityEvents.push(await readJson(req));
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/agentguard_admin_audit") {
      adminAudit.push(await readJson(req));
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/spend_reservations") {
      let rows = [...reservations.entries()].map(([request_id, row]) => ({
        request_id, agent_id: row.agentId, recipient: row.recipient,
        amount_yocto: row.amount, status: row.status,
        outlayer_tx_hash: row.txHash ?? null, outlayer_request_id: row.providerRequestId ?? null,
        last_error: row.lastError ?? null, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }));
      const requestId = url.searchParams.get("request_id")?.replace(/^eq\./, "");
      if (requestId) rows = rows.filter(row => row.request_id === requestId);
      res.setHeader("content-range", `0-${Math.max(0, rows.length - 1)}/${rows.length}`);
      return send(res, 200, rows);
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agents") {
      const tokenHash = url.searchParams.get("token_hash")?.replace(/^eq\./, "");
      if (tokenHash) {
        const agentId = agentsByHash.get(tokenHash);
        const agent = mockAgents.find(item => item.id === agentId);
        return send(res, 200, agent ? [{ id: agent.id, active: agent.active }] : []);
      }
      res.setHeader("content-range", `0-${Math.max(0, mockAgents.length - 1)}/${mockAgents.length}`);
      return send(res, 200, mockAgents);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/agents") {
      const body = await readJson(req);
      if (mockAgents.some(agent => agent.id === body.id)) return send(res, 409, { code: "23505", message: "duplicate key" });
      mockAgents.push({ id: body.id, name: body.name, active: true, created_at: new Date().toISOString() });
      agentsByHash.set(body.token_hash, body.id);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "PATCH" && url.pathname === "/rest/v1/agents") {
      const body = await readJson(req);
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const agent = mockAgents.find(item => item.id === id && (!url.searchParams.has("active") || item.active === (url.searchParams.get("active") === "eq.true")));
      if (!agent) return send(res, 200, []);
      if (body.token_hash) {
        for (const [existingHash, existingAgentId] of agentsByHash) {
          if (existingAgentId === agent.id) agentsByHash.delete(existingHash);
        }
        agentsByHash.set(body.token_hash, agent.id);
      }
      if (typeof body.active === "boolean") agent.active = body.active;
      return send(res, 200, [{ id: agent.id, name: agent.name, active: agent.active }]);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/consume_agentguard_rate_limit") {
      const body = await readJson(req);
      const key = `${body.p_actor_key}:${body.p_action_key}:${Math.floor(Date.now() / (body.p_window_seconds * 1000))}`;
      const count = (rateWindows.get(key) ?? 0) + 1;
      rateWindows.set(key, count);
      return send(res, 200, { allowed: count <= body.p_limit, retry_after_seconds: body.p_window_seconds });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/claim_agent_transfer_submission") {
      const body = await readJson(req);
      if (!systemControls.transfers_enabled) return send(res, 200, { claimed: false, reason: "emergency_stop" });
      const row = reservations.get(body.p_request_id);
      if (!row || row.agentId !== body.p_agent_id || row.claimed) return send(res, 200, { claimed: false, reason: "already_claimed_or_processed" });
      row.claimed = true;
      return send(res, 200, { claimed: true, request_id: body.p_request_id });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agentguard_transfers_enabled") {
      const body = await readJson(req);
      systemControls.transfers_enabled = body.p_enabled;
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "transfers_enabled_changed", target_id: "default", details: { enabled: body.p_enabled } });
      return send(res, 200, { transfers_enabled: body.p_enabled });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/authorize_agent_recipient") {
      const body = await readJson(req);
      if (body.p_expires_at && new Date(body.p_expires_at).getTime() <= Date.now()) return send(res, 400, { message: "invalid_recipient_authorization" });
      const key = `${body.p_agent_id}|${body.p_account_id}`;
      const existing = recipientAuthorizations.get(key);
      const row = { agent_id: body.p_agent_id, account_id: body.p_account_id, label: body.p_label, status: "active", authorized_at: new Date().toISOString(), authorized_by: body.p_actor_agent_id, expires_at: body.p_expires_at, revoked_at: null, revoked_by: null };
      recipientAuthorizations.set(key, row);
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "recipient_authorized", target_id: body.p_agent_id, details: { account_id: body.p_account_id } });
      return send(res, 200, { agent_id: body.p_agent_id, account_id: body.p_account_id, label: body.p_label, status: "active", expires_at: body.p_expires_at, created: !existing });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/revoke_agent_recipient") {
      const body = await readJson(req);
      const row = recipientAuthorizations.get(`${body.p_agent_id}|${body.p_account_id}`);
      if (!row) return send(res, 400, { message: "recipient_authorization_not_found" });
      const related = [...reservations.values()].filter(item => item.agentId === body.p_agent_id && item.recipient === body.p_account_id);
      const pending = related.filter(item => item.status === "awaiting_approval" && !item.claimed).length;
      const claimed = related.filter(item => ["reserved", "needs_review"].includes(item.status) && item.claimed && !item.txHash && !item.providerRequestId).length;
      const submitted = related.filter(item => ["reserved", "needs_review"].includes(item.status) && (item.txHash || item.providerRequestId)).length;
      row.status = "revoked"; row.revoked_at = new Date().toISOString(); row.revoked_by = body.p_actor_agent_id;
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "recipient_revoked", target_id: body.p_agent_id, details: { account_id: body.p_account_id } });
      return send(res, 200, { agent_id: body.p_agent_id, account_id: body.p_account_id, status: "revoked", pending_approvals: pending, claimed_inflight: claimed, provider_submitted: submitted });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agent_policy") {
      const body = await readJson(req);
      agentPolicies.set(body.p_agent_id, { ...(agentPolicies.get(body.p_agent_id) ?? {}), ...body });
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "agent_policy_updated", target_id: body.p_agent_id, details: {} });
      return send(res, 200, { agent_id: body.p_agent_id });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agent_auto_spend_limit") {
      const body = await readJson(req);
      const allocation = allocations.get(body.p_agent_id);
      if (!allocation) return send(res, 400, { message: "agent_allocation_not_configured" });
      const limit = body.p_auto_spend_limit_yocto == null ? null : BigInt(body.p_auto_spend_limit_yocto);
      if (limit !== null && limit > BigInt(allocation.allocation_limit_yocto)) return send(res, 400, { message: "auto_limit_exceeds_agent_allocation" });
      const policy = agentPolicies.get(body.p_agent_id) ?? {};
      policy.auto_spend_limit_yocto = limit?.toString() ?? null;
      agentPolicies.set(body.p_agent_id, policy);
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "agent_auto_spend_limit_updated", target_id: body.p_agent_id, details: {} });
      return send(res, 200, { agent_id: body.p_agent_id, auto_spend_limit_yocto: policy.auto_spend_limit_yocto });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/approve_agent_transfer") {
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row || row.status !== "awaiting_approval") return send(res, 400, { message: "approval_not_pending" });
      if (!systemControls.transfers_enabled) return send(res, 400, { message: "emergency_stop" });
      const recipientAuth = recipientAuthorizations.get(`${row.agentId}|${row.recipient}`);
      if (!recipientAuth || recipientAuth.status !== "active" || (recipientAuth.expires_at && new Date(recipientAuth.expires_at).getTime() <= Date.now())) return send(res, 400, { code: "P0001", message: "recipient_not_authorized", details: null, hint: null });
      row.status = "reserved";
      row.claimed = true;
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "transfer_approved", target_id: body.p_request_id, details: {} });
      return send(res, 200, { request_id: body.p_request_id, agent_id: row.agentId, recipient: row.recipient, amount_yocto: row.amount, status: "reserved" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/reject_agent_transfer") {
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row || row.status !== "awaiting_approval") return send(res, 400, { message: "approval_not_pending" });
      row.status = "rejected";
      mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) - BigInt(row.amount)).toString();
      const allocation = allocations.get(row.agentId);
      allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) - BigInt(row.amount)).toString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "transfer_rejected", target_id: body.p_request_id, details: {} });
      return send(res, 200, { request_id: body.p_request_id, status: "rejected" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agent_allocation") {
      const body = await readJson(req);
      const row = allocations.get(body.p_agent_id);
      if (!row) return send(res, 400, { message: "agent_allocation_not_configured" });
      const next = BigInt(body.p_allocation_limit_yocto);
      if (next < BigInt(row.spent_yocto) + BigInt(row.reserved_yocto)) return send(res, 400, { message: "allocation_below_committed_amounts" });
      const others = [...allocations.values()].filter(item => item.agent_id !== body.p_agent_id)
        .reduce((sum, item) => sum + BigInt(item.allocation_limit_yocto), 0n);
      if (others + next > BigInt(mockBudget.total_limit_yocto)) return send(res, 400, { message: "allocations_exceed_treasury_limit" });
      row.allocation_limit_yocto = next.toString();
      row.updated_by = body.p_actor_agent_id;
      row.updated_at = new Date().toISOString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "agent_allocation_updated", target_id: body.p_agent_id, details: {} });
      return send(res, 200, { agent_id: body.p_agent_id, allocation_limit_yocto: next.toString(), spent_yocto: row.spent_yocto, reserved_yocto: row.reserved_yocto });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/update_agent_budget_limit") {
      const body = await readJson(req);
      const next = BigInt(body.p_new_limit_yocto);
      if (next < BigInt(mockBudget.spent_yocto) + BigInt(mockBudget.reserved_yocto)) return send(res, 400, { message: "budget_below_committed_amounts" });
      const allocated = [...allocations.values()].reduce((sum, item) => sum + BigInt(item.allocation_limit_yocto), 0n);
      if (next < allocated) return send(res, 400, { message: "budget_below_allocated_amounts" });
      mockBudget.total_limit_yocto = next.toString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "budget_limit_updated", target_id: "default", details: {} });
      return send(res, 200, { total_limit_yocto: next.toString(), spent_yocto: mockBudget.spent_yocto, reserved_yocto: mockBudget.reserved_yocto, allocated_yocto: allocated.toString() });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/create_agent_with_audit") {
      const body = await readJson(req);
      if (mockAgents.some(agent => agent.id === body.p_agent_id)) {
        return send(res, 409, { code: "23505", message: "duplicate key" });
      }
      const agent = {
        id: body.p_agent_id,
        name: body.p_name,
        active: true,
        created_at: new Date().toISOString()
      };
      mockAgents.push(agent);
      agentsByHash.set(body.p_token_hash, agent.id);
      agentPolicies.set(agent.id, {});
      allocations.set(agent.id, { agent_id: agent.id, allocation_limit_yocto: "0", spent_yocto: "0", reserved_yocto: "0", updated_at: new Date().toISOString(), updated_by: body.p_actor_agent_id });
      adminAudit.push({
        actor_agent_id: body.p_actor_agent_id,
        action: "agent_credential_created",
        target_id: agent.id,
        details: { name: agent.name }
      });
      return send(res, 200, { id: agent.id, name: agent.name, allocation_limit_yocto: "0" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/cancel_expired_agent_transfer") {
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row || row.status !== "awaiting_approval" || new Date(row.approvalExpiresAt ?? 0).getTime() > Date.now()) {
        return send(res, 400, { message: "reservation_not_safely_cancellable" });
      }
      row.status = "cancelled";
      mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) - BigInt(row.amount)).toString();
      const allocation = allocations.get(row.agentId);
      allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) - BigInt(row.amount)).toString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "expired_transfer_cancelled", target_id: body.p_request_id, details: { reason: body.p_reason } });
      return send(res, 200, { request_id: body.p_request_id, status: "cancelled" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/resolve_agent_transfer_failed_final") {
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row || !["reserved", "needs_review"].includes(row.status) || !row.txHash) {
        return send(res, 400, { message: "reservation_not_resolvable" });
      }
      row.status = "failed";
      row.lastError = body.p_reason;
      mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) - BigInt(row.amount)).toString();
      const allocation = allocations.get(row.agentId);
      allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) - BigInt(row.amount)).toString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "transfer_resolved_failed_final", target_id: body.p_request_id, details: { reason: body.p_reason, evidence_reference: body.p_evidence_reference } });
      return send(res, 200, { request_id: body.p_request_id, status: "failed" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/rotate_agent_credential") {
      const body = await readJson(req);
      const agent = mockAgents.find(item => item.id === body.p_agent_id && item.active);
      if (!agent || agent.id === "primary") return send(res, 400, { message: "active_agent_not_found" });
      for (const [existingHash, existingAgentId] of agentsByHash) {
        if (existingAgentId === agent.id) agentsByHash.delete(existingHash);
      }
      agentsByHash.set(body.p_token_hash, agent.id);
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "agent_credential_rotated", target_id: agent.id, details: { name: agent.name } });
      return send(res, 200, { id: agent.id, name: agent.name });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agent_active") {
      const body = await readJson(req);
      if (body.p_agent_id === "primary") return send(res, 400, { message: "primary_agent_protected" });
      const agent = mockAgents.find(item => item.id === body.p_agent_id);
      if (!agent) return send(res, 400, { message: "agent_not_found" });
      agent.active = body.p_active;
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: body.p_active ? "agent_activated" : "agent_deactivated", target_id: agent.id, details: {} });
      return send(res, 200, { id: agent.id, name: agent.name, active: agent.active });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/reserve_agent_spend") {
      counters.reserve++;
      const body = await readJson(req);
      const existing = reservations.get(body.p_request_id);
      if (existing) {
        const same = existing.amount === body.p_amount_yocto
          && existing.recipient === body.p_recipient
          && existing.agentId === body.p_agent_id;
        if (!same) return send(res, 400, { message: "idempotency_key_conflict" });
        return send(res, 200, { created: false, status: existing.status, request_id: body.p_request_id, auto_approved: existing.autoApproved === true });
      }
      if (!systemControls.transfers_enabled) return send(res, 200, { created: false, status: "blocked", reason: "emergency_stop" });
      const policy = agentPolicies.get(body.p_agent_id) ?? {};
      const amount = BigInt(body.p_amount_yocto);
      if (policy.p_max_transfer_yocto && amount > BigInt(policy.p_max_transfer_yocto)) return send(res, 200, { created: false, status: "blocked", reason: "agent_per_transfer_limit" });
      const recipientAuth = recipientAuthorizations.get(`${body.p_agent_id}|${body.p_recipient}`);
      if (!recipientAuth || recipientAuth.status !== "active" || (recipientAuth.expires_at && new Date(recipientAuth.expires_at).getTime() <= Date.now())) return send(res, 200, { created: false, status: "blocked", reason: "recipient_not_authorized" });
      const allocation = allocations.get(body.p_agent_id);
      if (!allocation || BigInt(allocation.spent_yocto) + BigInt(allocation.reserved_yocto) + amount > BigInt(allocation.allocation_limit_yocto)) return send(res, 200, { created: false, status: "blocked", reason: "agent_allocation_exceeded" });
      const committed = BigInt(mockBudget.spent_yocto) + BigInt(mockBudget.reserved_yocto);
      if (committed + amount > BigInt(mockBudget.total_limit_yocto)) {
        return send(res, 200, { created: false, status: "blocked", request_id: body.p_request_id });
      }
      const autoLimit = policy.auto_spend_limit_yocto == null ? null : BigInt(policy.auto_spend_limit_yocto);
      const autoCommitted = [...reservations.values()]
        .filter(row => row.agentId === body.p_agent_id && row.autoApproved === true && ["reserved", "needs_review", "executed"].includes(row.status))
        .reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const autoApproved = autoLimit !== null && autoCommitted + amount <= autoLimit;
      const status = autoApproved ? "reserved" : "awaiting_approval";
      reservations.set(body.p_request_id, {
        amount: body.p_amount_yocto, recipient: body.p_recipient,
        agentId: body.p_agent_id, status, autoApproved, claimed: autoApproved,
        txHash: null, providerRequestId: null,
        approvalExpiresAt: autoApproved ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
      mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) + amount).toString();
      allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) + amount).toString();
      return send(res, 200, { created: true, status, auto_approved: autoApproved, request_id: body.p_request_id, approval_expires_at: reservations.get(body.p_request_id).approvalExpiresAt });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/record_outlayer_submission") {
      counters.record++;
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row) return send(res, 400, { message: "reservation_not_found" });
      if (row.txHash && body.p_tx_hash && row.txHash !== body.p_tx_hash) return send(res, 400, { message: "provider_transaction_hash_conflict" });
      if (row.providerRequestId && body.p_provider_request_id && row.providerRequestId !== body.p_provider_request_id) return send(res, 400, { message: "provider_request_id_conflict" });
      row.txHash = row.txHash ?? body.p_tx_hash ?? null;
      row.providerRequestId = row.providerRequestId ?? body.p_provider_request_id ?? null;
      row.lastError = body.p_error ?? null;
      row.status = "needs_review";
      return send(res, 200, { status: row.status, request_id: body.p_request_id });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/finish_agent_spend") {
      counters.finish++;
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row) return send(res, 400, { message: "reservation_not_found" });
      if (["reserved", "needs_review"].includes(row.status) && body.p_outcome === "executed") {
        mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) - BigInt(row.amount)).toString();
        mockBudget.spent_yocto = (BigInt(mockBudget.spent_yocto) + BigInt(row.amount)).toString();
        const allocation = allocations.get(row.agentId);
        allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) - BigInt(row.amount)).toString();
        allocation.spent_yocto = (BigInt(allocation.spent_yocto) + BigInt(row.amount)).toString();
      } else if (["reserved", "needs_review"].includes(row.status) && body.p_outcome === "failed") {
        mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) - BigInt(row.amount)).toString();
        const allocation = allocations.get(row.agentId);
        allocation.reserved_yocto = (BigInt(allocation.reserved_yocto) - BigInt(row.amount)).toString();
      }
      row.status = body.p_outcome;
      row.txHash = body.p_tx_hash ?? null;
      row.lastError = body.p_error ?? null;
      return send(res, 200, { status: row.status, request_id: body.p_request_id });
    }
    if (req.method === "GET" && url.pathname.startsWith("/wallet/v1/requests/")) {
      counters.providerStatus++;
      const providerId = decodeURIComponent(url.pathname.split("/").pop());
      if (providerId === "mock-provider-unavailable") return send(res, 503, { error: "provider_down" });
      if (providerId === "mock-provider-nohash") return send(res, 200, { status: "pending" });
      if (providerId === "mock-provider-conflict") return send(res, 200, { status: "executed", tx_hash: "conflicting-hash" });
      return send(res, 200, { status: "executed", tx_hash: "recovered-hash" });
    }
    if (req.method === "PATCH" && url.pathname === "/rest/v1/spend_reservations") {
      await readJson(req);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/wallet/v1/transfer") {
      counters.provider++;
      const body = await readJson(req);
      if (body.to === "timeout.test") return req.socket.destroy();
      if (body.to === "provider-error.test") return send(res, 502, { error: "provider_unavailable" });
      return send(res, 200, { tx_hash: `mock-tx-${counters.provider}`, request_id: `mock-provider-${counters.provider}` });
    }
    return send(res, 404, { error: "mock_route_not_found", path: url.pathname });
  } catch (error) {
    return send(res, 500, { error: String(error) });
  }
});

const env = {
  ...process.env,
  SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  OUTLAYER_BASE_URL: `http://127.0.0.1:${mockPort}`,
  OUTLAYER_API_KEY: "test-outlayer-key",
  OUTLAYER_NEAR_ADDRESS: "agentguard.testnet",
  NEAR_RPC_URL: `http://127.0.0.1:${mockPort}`,
  CI: "true",
  AGENTGUARD_TEST_MODE: "true",
  AGENTGUARD_NETWORK: "testnet",
  AGENTGUARD_MAX_TRANSFER_YOCTO: "5000000000000000000000000",
  AGENTGUARD_AGENT_TOKEN: "primary-agent-token",
  AGENTGUARD_ADMIN_TOKEN: "admin-token",
  PORT: String(appPort),
  HOSTNAME: "127.0.0.1"
};
let app;
let failed = false;
const assert = (condition, message) => {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  process.stdout.write(`PASS: ${message}\n`);
};
async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/agent/transfer`, { method: "GET" });
      if (response.status) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Next.js server did not become ready");
}
async function postTransfer({ token, requestId, to = "recipient.near", amount = "1000000000000000000000000", rawBody } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${appPort}/api/agent/transfer`, {
    method: "POST",
    headers,
    body: rawBody ?? JSON.stringify({ requestId, to, amountYocto: amount })
  });
}

async function approveTransfer(requestId, action = "approve") {
  return fetch(`http://127.0.0.1:${appPort}/api/admin/approvals`, {
    method: "POST",
    headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify(action === "approve"
      ? { action, requestId }
      : { action, requestId, reason: "Rejected by integration test" })
  });
}

try {
  await new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(mockPort, "127.0.0.1", resolve);
  });
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"]
  });
  let appOutput = "";
  app.stdout.on("data", chunk => { appOutput += chunk.toString(); });
  app.stderr.on("data", chunk => { appOutput += chunk.toString(); });
  await waitForApp();

  let payload;
  let response = await fetch(`http://127.0.0.1:${appPort}/api/admin/dashboard`, {
    headers: { authorization: "Bearer admin-token" }
  });
  payload = await response.json();
  assert(response.status === 200 && payload.status === "ok" && payload.agents?.length === 2 && payload.allocations?.length === 2 && Array.isArray(payload.recipients), `admin dashboard loads budget, agents, allocations and recipient registry (HTTP ${response.status}: ${JSON.stringify(payload)})`);
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/dashboard`, {
    headers: { authorization: "Bearer primary-agent-token" }
  });
  assert(response.status === 403, "primary agent credential cannot access admin dashboard");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "primary", accountId: "recipient.near" })
  });
  assert(response.status === 403, "agent credential cannot authorize recipients");
  for (const accountId of ["recipient.near", "timeout.test", "provider-error.test"]) {
    response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
      method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ agentId: "primary", accountId, label: accountId === "recipient.near" ? "Primary recipient" : null })
    });
    assert(response.status === 200, `admin can authorize exact recipient ${accountId}`);
  }
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "primary", accountId: "expired.test", expiresAt: new Date(Date.now() - 60000).toISOString() })
  });
  assert(response.status === 400, "expired recipient authorization is rejected");
  response = await postTransfer({ token: "admin-token", requestId: "test-admin-token-transfer-001" });
  assert(response.status === 401, "administrator credential cannot submit agent transfers");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/dashboard`, {
    headers: { authorization: "Bearer agent-one-token" }
  });
  assert(response.status === 403, "non-admin agent cannot read admin dashboard");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/budget`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ limitYocto: "6000000000000000000000000" })
  });
  assert(response.status === 200 && mockBudget.total_limit_yocto === "6000000000000000000000000", "admin can update shared budget limit");
  mockBudget.reserved_yocto = "2000000000000000000000000";
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/budget`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ limitYocto: "1000000000000000000000000" })
  });
  assert(response.status === 409, "admin cannot lower budget below reserved commitments");
  mockBudget.reserved_yocto = "0";
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/budget`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ limitYocto: "4000000000000000000000000" })
  });
  assert(response.status === 409 && (await response.json()).error === "budget_below_agent_allocations", "admin cannot lower treasury ceiling below summed agent allocations");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", allocationLimitYocto: "2500000000000000000000000" })
  });
  assert(response.status === 200 && allocations.get("primary").allocation_limit_yocto === "2500000000000000000000000", "admin can update agent allocation within treasury ceiling");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", allocationLimitYocto: "1000000000000000000000000" })
  });
  assert(response.status === 403, "agent credential cannot change allocation");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", allocationLimitYocto: "4000000000000000000000000" })
  });
  assert(response.status === 409, "allocation update cannot exceed treasury ceiling");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/status`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "research-agent", active: false })
  });
  assert(response.status === 200 && mockAgents.find(agent => agent.id === "research-agent")?.active === false, "admin can deactivate a secondary agent");
  response = await postTransfer({ token: "agent-two-token", requestId: "test-deactivated-agent-001" });
  assert(response.status === 401, "deactivated agent credential is rejected");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/status`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "research-agent", active: true })
  });
  assert(response.status === 200, "admin can reactivate a secondary agent");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/status`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", active: false })
  });
  assert(response.status === 400, "primary admin agent cannot be deactivated");

  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/agents`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "demo-agent", name: "Demo Agent" })
  });
  payload = await response.json();
  assert(response.status === 201 && payload.token && allocations.get("demo-agent")?.allocation_limit_yocto === "0" && adminAudit.some(entry => entry.action === "agent_credential_created"), "agent provisioning creates zero allocation and returns one-time token");
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/agents`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "admin", name: "Reserved Admin Collision" })
  });
  payload = await response.json();
  assert(response.status === 400 && payload.error === "invalid_request", "reserved administrator identity cannot be provisioned as an agent");
  const oldDemoToken = payload.token;
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/agents/rotate`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "demo-agent" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.token && payload.token !== oldDemoToken && adminAudit.some(entry => entry.action === "agent_credential_rotated"), "credential rotation invalidates old key and writes audit entry");
  response = await postTransfer({ token: oldDemoToken, requestId: "test-old-demo-token-001" });
  assert(response.status === 401, "rotated credential is no longer accepted");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "research-agent", allocationLimitYocto: "2500000000000000000000000" })
  });
  assert(response.status === 200, "admin can rebalance an agent allocation to make room for a newly provisioned agent");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "demo-agent", allocationLimitYocto: "1000000000000000000000000" })
  });
  assert(response.status === 200, "new agent receives spending authority only after explicit allocation");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "demo-agent", accountId: "recipient.near" })
  });
  assert(response.status === 200, "new agent receives recipient authorization only after explicit admin action");
  response = await postTransfer({ token: payload.token, requestId: "test-new-demo-token-001" });
  const replacementBody = await response.text();
  assert(response.status === 202 && replacementBody.length > 0, `replacement credential reaches transfer lifecycle (HTTP ${response.status}; body: ${replacementBody || "<empty>"})`);
  response = await approveTransfer("test-new-demo-token-001", "reject");
  assert(response.status === 200, "test credential's pending transfer is rejected to release its reservation");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "research-agent", allocationLimitYocto: "0" })
  });
  assert(response.status === 200, "admin can release unused research-agent allocation");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "demo-agent", allocationLimitYocto: "0" })
  });
  assert(response.status === 200, "admin can release unused demo-agent allocation after rejection");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/allocation`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", allocationLimitYocto: "6000000000000000000000000" })
  });
  assert(response.status === 200, "admin can reallocate the full treasury ceiling to primary");

  const beforeUnauthReserve = counters.reserve;
  const beforeUnauthProvider = counters.provider;
  response = await postTransfer({ requestId: "test-unauth-001" });
  assert(response.status === 401, "missing bearer token is rejected with 401");
  assert(counters.reserve === beforeUnauthReserve && counters.provider === beforeUnauthProvider, "unauthenticated request never reaches reservation or provider");
  assert(securityEvents.some(event => event.event_type === "transfer_unauthorized"), "unauthenticated transfer rejection is recorded as a security event");

  response = await postTransfer({ token: "not-a-valid-token", requestId: "test-invalid-auth-001" });
  assert(response.status === 401, "unknown bearer token is rejected");

  response = await postTransfer({ token: "inactive-agent-token", requestId: "test-inactive-001" });
  assert(response.status === 401, "inactive agent token is rejected");

  response = await postTransfer({ token: "agent-one-token", requestId: "test-malformed-001", rawBody: "{" });
  assert(response.status === 400, "malformed JSON is rejected with 400");

  response = await postTransfer({ token: "agent-one-token", requestId: "short" });
  assert(response.status === 400, "invalid request ID is rejected with 400");

  const reserveBeforeCap = counters.reserve;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-cap-001", amount: "6000000000000000000000000" });
  assert(response.status === 403, "transfer above configured per-transaction cap is blocked");
  assert(counters.reserve === reserveBeforeCap, "cap rejection occurs before a reservation is created");
  assert(securityEvents.some(event => event.event_type === "transfer_per_transaction_limit_blocked"), "per-transaction cap rejection is recorded");

  response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  payload = await response.json();
  assert(response.status === 200 && payload.status === "ok" && payload.signerMatches === true && payload.nearRpc === "connected" && payload.network === "testnet", "health confirms testnet RPC and provider signer");
  mockSignerAddress = "unexpected.testnet";
  response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  payload = await response.json();
  assert(response.status === 503 && payload.outlayer === "signer_mismatch" && payload.nearRpc === "connected", "health fails closed when provider wallet signer differs");
  mockSignerAddress = "agentguard.testnet";

  mockBudgetReadError = true;
  response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  payload = await response.json();
  assert(
    response.status === 503 && payload.status === "database_error"
      && !("code" in payload) && !("message" in payload)
      && !JSON.stringify(payload).includes("42501")
      && !JSON.stringify(payload).includes("internal diagnostic"),
    "public health endpoint redacts Postgres error codes and messages"
  );
  mockBudgetReadError = false;

  const primaryId = "test-api-primary-001";
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/policy`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({
      id: "primary", maxTransferYocto: "2000000000000000000000000",
      dailyLimitYocto: null, weeklyLimitYocto: null
    })
  });
  assert(response.status === 200, "admin can configure per-agent spending limits without mutating recipient authorization");
  const policyReserveCount = counters.reserve;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-policy-recipient-001", to: "unlisted.near" });
  payload = await response.json();
  assert(response.status === 403 && payload.reason === "recipient_not_authorized", "unregistered exact account ID is denied");
  assert(counters.reserve === policyReserveCount + 1, "recipient policy is checked in the reservation transaction");
  response = await postTransfer({ token: "agent-one-token", requestId: "test-policy-limit-001", amount: "3000000000000000000000000" });
  payload = await response.json();
  assert(response.status === 403 && payload.reason === "agent_per_transfer_limit", "per-agent transfer cap blocks an over-limit request");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "primary", accountId: "revoke.test", label: "Temporary recipient" })
  });
  assert(response.status === 200, "admin can authorize a recipient before revocation test");
  response = await postTransfer({ token: "agent-one-token", requestId: "test-recipient-revoke-001", to: "revoke.test" });
  assert(response.status === 202, "authorized recipient can receive a pending transfer request");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "DELETE", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "primary", accountId: "revoke.test", reason: "test revoke" })
  });
  assert(response.status === 403, "agent credential cannot revoke recipients");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/recipients`, {
    method: "DELETE", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: "primary", accountId: "revoke.test", reason: "test revocation" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.recipient.pending_approvals === 1, "revocation reports pending approvals without releasing reservations");
  response = await approveTransfer("test-recipient-revoke-001");
  payload = await response.json();
  assert(response.status === 409 && payload.reason === "recipient_not_authorized", `revoked recipient cannot pass approval revalidation (HTTP ${response.status}: ${JSON.stringify(payload)})`);
  assert(reservations.get("test-recipient-revoke-001").status === "awaiting_approval", "revocation leaves pending reservation intact");
  assert(securityEvents.some(event => event.event_type === "transfer_approval_blocked" && event.request_id === "test-recipient-revoke-001"), `blocked approval attempt is recorded in the security event log (${JSON.stringify(securityEvents.filter(event => event.request_id === "test-recipient-revoke-001"))})`);
  response = await approveTransfer("test-recipient-revoke-001", "reject");
  assert(response.status === 200, "admin can reject a pending request after recipient revocation");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/policy`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", maxTransferYocto: null, dailyLimitYocto: null, weeklyLimitYocto: null })
  });
  assert(response.status === 200, "admin can update per-agent limits without changing recipient authorizations");

  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/transfers`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert(response.status === 200, "admin can activate the global emergency stop");
  response = await postTransfer({ token: "agent-one-token", requestId: "test-emergency-stop-001" });
  payload = await response.json();
  assert(response.status === 403 && payload.reason === "emergency_stop", "emergency stop blocks new transfer reservations");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/transfers`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ enabled: true })
  });
  assert(response.status === 200, "admin can re-enable transfers after emergency stop");

  const providerCountBeforePrimary = counters.provider;
  const recordCountBeforePrimary = counters.record;
  response = await postTransfer({ token: "agent-one-token", requestId: primaryId });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "awaiting_approval", "agent transfer creates a pending approval request");
  assert(counters.provider === providerCountBeforePrimary, "agent request cannot contact provider before admin approval");
  mockSignerAddress = "unexpected.testnet";
  response = await approveTransfer(primaryId);
  payload = await response.json();
  assert(response.status === 503 && payload.error === "outlayer_signer_mismatch", "approval fails closed when live OutLayer signer differs from configured signer");
  assert(counters.provider === providerCountBeforePrimary && reservations.get(primaryId)?.status === "awaiting_approval", "signer mismatch does not consume approval or submit to OutLayer");
  mockSignerAddress = "agentguard.testnet";
  response = await approveTransfer(primaryId);
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "admin approval submits transfer and holds it for chain confirmation");
  assert(counters.provider === providerCountBeforePrimary + 1 && counters.record === recordCountBeforePrimary + 1, "approved request invokes provider once and atomically records provider references");
  assert(reservations.get(primaryId)?.providerRequestId === `mock-provider-${providerCountBeforePrimary + 1}`, "provider request ID is persisted atomically");
  assert(reservations.get(primaryId)?.txHash === `mock-tx-${providerCountBeforePrimary + 1}`, "transaction hash is persisted atomically");
  response = await approveTransfer(primaryId);
  assert(response.status === 409, "an already-consumed approval cannot be replayed");
  assert(counters.provider === providerCountBeforePrimary + 1, "approval replay cannot call OutLayer twice");

  response = await postTransfer({ token: "agent-one-token", requestId: primaryId });
  assert(response.status === 409, "identical request replay is rejected by API");
  assert(counters.provider === providerCountBeforePrimary + 1, "identical replay does not invoke provider again");
  assert(securityEvents.some(event => event.event_type === "transfer_replay_rejected" && event.request_id === primaryId), "duplicate transfer replay is recorded as a security event");

  response = await postTransfer({ token: "agent-one-token", requestId: primaryId, amount: "4000000000000000000000000" });
  assert(response.status === 409, "same request ID with changed amount is rejected");

  response = await postTransfer({ token: "agent-two-token", requestId: primaryId });
  assert(response.status === 409, "second agent cannot reuse another agent's request ID");

  const providerBeforeTimeout = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-timeout-001", to: "timeout.test", amount: "3000000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "awaiting_approval", "timeout test transfer waits for administrator approval");
  response = await approveTransfer("test-timeout-001");
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "ambiguous provider connection failure remains needs_review");
  assert(payload.reason === "outlayer_timeout_or_connection_error", "ambiguous provider failure is classified explicitly");
  assert(counters.provider === providerBeforeTimeout + 1, "timeout path invokes provider only once");
  assert(reservations.get("test-timeout-001")?.status === "needs_review", "timeout reservation remains held in the ledger");

  response = await postTransfer({ token: "agent-one-token", requestId: "test-provider-error-001", to: "provider-error.test", amount: "1000000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "awaiting_approval", "provider-error test transfer waits for approval");
  response = await approveTransfer("test-provider-error-001");
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "provider 5xx response is not treated as proof of transfer failure");
  assert(reservations.get("test-provider-error-001")?.status === "needs_review", "provider 5xx reservation remains held");

  response = await postTransfer({ token: "agent-one-token", requestId: "test-reject-001" });
  assert(response.status === 202, "rejection test creates pending approval");
  response = await approveTransfer("test-reject-001", "reject");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "rejected", "administrator can reject a pending transfer");
  assert(reservations.get("test-reject-001")?.status === "rejected", "rejected transfer is terminal in the ledger");

  const expiredResolutionId = "test-expired-resolution-001";
  const expiredAmount = "1000000000000000000000";
  reservations.set(expiredResolutionId, {
    amount: expiredAmount, recipient: "recipient.near", agentId: "primary",
    status: "awaiting_approval", approvalExpiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) + BigInt(expiredAmount)).toString();
  allocations.get("primary").reserved_yocto = (BigInt(allocations.get("primary").reserved_yocto) + BigInt(expiredAmount)).toString();
  response = await fetch("http://127.0.0.1:3000/api/admin/reservations/resolve", {
    method: "POST",
    headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ action: "cancel_expired", requestId: expiredResolutionId, reason: "Approval expired and no provider submission was made." })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.status === "cancelled", "admin can cancel an expired unapproved reservation");
  assert(reservations.get(expiredResolutionId)?.status === "cancelled" && adminAudit.some(entry => entry.action === "expired_transfer_cancelled"), "expired cancellation releases its reservation and writes an admin audit entry");

  const failedFinalResolutionId = "test-failed-final-resolution-001";
  const failedFinalAmount = "1000000000000000000000000";
  reservations.set(failedFinalResolutionId, {
    amount: failedFinalAmount, recipient: "recipient.near", agentId: "primary",
    status: "needs_review", txHash: "mock-failed-final-hash", providerRequestId: "mock-failed-final-provider"
  });
  mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) + BigInt(failedFinalAmount)).toString();
  allocations.get("primary").reserved_yocto = (BigInt(allocations.get("primary").reserved_yocto) + BigInt(failedFinalAmount)).toString();
  response = await fetch("http://127.0.0.1:3000/api/admin/reservations/resolve", {
    method: "POST",
    headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({
      action: "failed_final", requestId: failedFinalResolutionId,
      reason: "NEAR confirms the transfer failed at finality.",
      evidenceReference: "https://nearblocks.io/txns/mock-failed-final-hash"
    })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.status === "failed", "admin can resolve a matching NEAR FINAL failure");
  assert(reservations.get(failedFinalResolutionId)?.status === "failed" && adminAudit.some(entry => entry.action === "transfer_resolved_failed_final"), "final-failure resolution releases reserved budget and records evidence audit");

  const recoveryRow = {
    amount: "1000000000000000000000000", recipient: "recipient.near", agentId: "primary",
    status: "needs_review", providerRequestId: "mock-provider-nohash", txHash: null
  };
  reservations.set("provider-recovery-001", recoveryRow);
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-recovery-001" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.providerStatus === "pending" && !payload.txHash, "provider pending response does not settle reservation");

  recoveryRow.providerRequestId = "mock-provider-recover";
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-recovery-001" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.txHash === "recovered-hash" && payload.reconciliationRequired, "provider status recovers a missing transaction hash");
  assert(recoveryRow.txHash === "recovered-hash" && recoveryRow.status === "needs_review", "recovered hash persists without budget settlement");

  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-two-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-recovery-001" })
  });
  assert(response.status === 404, "cross-agent provider status lookup is hidden");

  const unavailableRow = { ...recoveryRow, providerRequestId: "mock-provider-unavailable", txHash: null };
  reservations.set("provider-unavailable-001", unavailableRow);
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-unavailable-001" })
  });
  assert(response.status === 202 && unavailableRow.status === "needs_review", "provider status outage leaves reservation pending");

  // Exercise the shared fail-closed rate-limit helper on the balance route.
  const balanceWindow = Math.floor(Date.now() / 60000);
  rateWindows.set(`agent:primary:wallet_balance_lookup:${balanceWindow}`, 20);
  const balanceProviderCount = counters.providerStatus;
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/balance`, {
    method: "GET", headers: { authorization: "Bearer agent-one-token" }
  });
  payload = await response.json();
  assert(response.status === 429 && payload.error === "rate_limit_exceeded", "agent balance lookup is rate limited before provider access");
  assert(response.headers.get("retry-after") !== null, "rate-limited response includes Retry-After");
  assert(securityEvents.some(event => event.event_type === "agent_rate_limited" && event.details?.action === "wallet_balance_lookup"), "rate-limit denial is written to security events");
  assert(counters.providerStatus === balanceProviderCount, "rate-limited balance lookup does not call the provider");

  const conflictRow = { ...recoveryRow, providerRequestId: "mock-provider-conflict", txHash: "known-hash" };
  reservations.set("provider-conflict-001", conflictRow);
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-conflict-001" })
  });
  payload = await response.json();
  assert(response.status === 202 && payload.reason === "provider_transaction_hash_conflict", "conflicting provider hash is not overwritten");


  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/outlayer-policy`, {
    headers: { authorization: "Bearer agent-one-token" }
  });
  assert(response.status === 403, "agent credential cannot inspect the OutLayer wallet policy");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/outlayer-policy`, {
    headers: { authorization: "Bearer admin-token" }
  });
  payload = await response.json();
  assert(response.status === 200 && payload.policy?.approval?.threshold?.required === 1, "admin can inspect the effective OutLayer approval policy");
  assert(!JSON.stringify(payload).includes("must-not-be-returned"), "OutLayer policy inspection strips unrelated provider fields and secrets");

  rateWindows.clear();
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/auto-spend`, {
    method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", autoSpendLimitYocto: "100000000000000000000000" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.policy.auto_spend_limit_yocto === "100000000000000000000000", "admin can set a bounded autonomous lifetime allowance");
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/agents/auto-spend`, {
    method: "PATCH", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "primary", autoSpendLimitYocto: "100000000000000000000000" })
  });
  assert(response.status === 403, "agent credential cannot change its autonomous allowance");
  const providerBeforeAuto = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-spend-001", to: "recipient.near", amount: "50000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review" && payload.providerRequestId, "within-allowance transfer submits to provider without per-transfer admin approval");
  assert(counters.provider === providerBeforeAuto + 1 && reservations.get("test-auto-spend-001")?.autoApproved === true, "autonomous reservation is submitted exactly once and marked auto-authorized");
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-spend-001", to: "recipient.near", amount: "50000000000000000000000" });
  assert(response.status === 409 && counters.provider === providerBeforeAuto + 1, "autonomous request replay cannot submit a duplicate provider transfer");

  const providerBeforeAutoOverflow = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-overflow-001", to: "recipient.near", amount: "60000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "awaiting_approval", "request beyond remaining autonomous allowance falls back to admin approval");
  assert(counters.provider === providerBeforeAutoOverflow, "autonomous allowance overflow does not reach OutLayer");
  response = await approveTransfer("test-auto-overflow-001", "reject");
  assert(response.status === 200, "admin can reject a request routed to approval after autonomous allowance is exhausted");

  const providerBeforeAutoTimeout = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-timeout-001", to: "timeout.test", amount: "10000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review" && payload.reason === "outlayer_timeout_or_connection_error", "autonomous provider timeout is retained as needs_review");
  assert(counters.provider === providerBeforeAutoTimeout + 1, "autonomous timeout makes one provider attempt only");
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-timeout-001", to: "timeout.test", amount: "10000000000000000000000" });
  assert(response.status === 409 && counters.provider === providerBeforeAutoTimeout + 1, "autonomous timeout replay cannot retry an ambiguous provider submission");

  const providerBeforeAutoError = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-auto-provider-error-001", to: "provider-error.test", amount: "10000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review" && payload.reason === "unclassified_outlayer_response_502", "autonomous provider 5xx response is retained for review");
  assert(counters.provider === providerBeforeAutoError + 1, "autonomous provider 5xx makes one provider attempt only");

  // A second app process runs with a mainnet provider URL. The route must
  // refuse before reservation or provider execution, even in CI test mode.
  const guardPort = 3002;
  const guardEnv = { ...env, OUTLAYER_BASE_URL: "https://api.outlayer.ai", PORT: String(guardPort) };
  const guardApp = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(guardPort)], {
    cwd: process.cwd(), env: guardEnv, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const probe = await fetch(`http://127.0.0.1:${guardPort}/api/agent/transfer`, { method: "GET" });
        if (probe.status) { ready = true; break; }
      } catch {}
      await delay(500);
    }
    assert(ready, "isolated guard server starts for provider network test");
    const reserveCount = counters.reserve;
    const providerCount = counters.provider;
    response = await fetch(`http://127.0.0.1:${guardPort}/api/agent/transfer`, {
      method: "POST",
      headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "test-mainnet-block-001",
        to: "recipient.near",
        amountYocto: "1000000000000000000000000"
      })
    });
    payload = await response.json();
    assert(response.status === 503 && payload.error === "outlayer_testnet_endpoint_required", "mainnet OutLayer endpoint is refused");
    assert(counters.reserve === reserveCount && counters.provider === providerCount, "mainnet endpoint refusal happens before reservation and provider call");
  } finally {
    if (!guardApp.killed) guardApp.kill("SIGTERM");
  }

  process.stdout.write("\nAPI integration tests passed. Mock OutLayer and mock Supabase only; no credentials, production database, or NEAR transfer used.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  if (app && !app.killed) app.kill("SIGTERM");
  await new Promise(resolve => mock.close(resolve));
}
if (failed) process.exitCode = 1;
