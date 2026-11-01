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
const systemControls = { transfers_enabled: true, updated_at: "2026-01-01T00:00:00.000Z", updated_by: "admin" };
let mockSignerAddress = "agentguard.testnet";
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
    }
    if (req.method === "GET" && url.pathname === "/wallet/v1/address") return send(res, 200, { executor_account_id: mockSignerAddress });
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_budgets") return send(res, 200, [mockBudget]);
    if (req.method === "GET" && url.pathname === "/rest/v1/agentguard_system_controls") return send(res, 200, [systemControls]);
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_policies") {
      const rows = [...agentPolicies.entries()].map(([agent_id, policy]) => ({ agent_id, ...policy }));
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
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/set_agent_policy") {
      const body = await readJson(req);
      agentPolicies.set(body.p_agent_id, body);
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "agent_policy_updated", target_id: body.p_agent_id, details: {} });
      return send(res, 200, { agent_id: body.p_agent_id });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/approve_agent_transfer") {
      const body = await readJson(req);
      const row = reservations.get(body.p_request_id);
      if (!row || row.status !== "awaiting_approval") return send(res, 400, { message: "approval_not_pending" });
      if (!systemControls.transfers_enabled) return send(res, 400, { message: "emergency_stop" });
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
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "transfer_rejected", target_id: body.p_request_id, details: {} });
      return send(res, 200, { request_id: body.p_request_id, status: "rejected" });
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/update_agent_budget_limit") {
      const body = await readJson(req);
      const next = BigInt(body.p_new_limit_yocto);
      if (next < BigInt(mockBudget.spent_yocto) + BigInt(mockBudget.reserved_yocto)) return send(res, 400, { message: "budget_below_committed_amounts" });
      mockBudget.total_limit_yocto = next.toString();
      adminAudit.push({ actor_agent_id: body.p_actor_agent_id, action: "budget_limit_updated", target_id: "default", details: {} });
      return send(res, 200, { total_limit_yocto: next.toString(), spent_yocto: mockBudget.spent_yocto, reserved_yocto: mockBudget.reserved_yocto });
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
        return send(res, 200, { created: false, status: existing.status, request_id: body.p_request_id });
      }
      const amount = BigInt(body.p_amount_yocto);
      const committed = BigInt(mockBudget.spent_yocto) + BigInt(mockBudget.reserved_yocto);
      if (committed + amount > BigInt(mockBudget.total_limit_yocto)) {
        return send(res, 200, { created: false, status: "blocked", request_id: body.p_request_id });
      }
      reservations.set(body.p_request_id, {
        amount: body.p_amount_yocto, recipient: body.p_recipient,
        agentId: body.p_agent_id, status: "awaiting_approval", txHash: null, providerRequestId: null, approvalExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
      mockBudget.reserved_yocto = (BigInt(mockBudget.reserved_yocto) + amount).toString();
      return send(res, 200, { created: true, status: "awaiting_approval", request_id: body.p_request_id, approval_expires_at: reservations.get(body.p_request_id).approvalExpiresAt });
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
  assert(response.status === 200 && payload.status === "ok" && payload.agents?.length === 2, `admin dashboard loads budget and agent inventory (HTTP ${response.status}: ${JSON.stringify(payload)})`);
  response = await fetch(`http://127.0.0.1:${appPort}/api/admin/dashboard`, {
    headers: { authorization: "Bearer primary-agent-token" }
  });
  assert(response.status === 403, "primary agent credential cannot access admin dashboard");
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
  assert(response.status === 201 && payload.token && adminAudit.some(entry => entry.action === "agent_credential_created"), "agent provisioning returns one-time token and writes audit entry");
  const oldDemoToken = payload.token;
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/agents/rotate`, {
    method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "demo-agent" })
  });
  payload = await response.json();
  assert(response.status === 200 && payload.token && payload.token !== oldDemoToken && adminAudit.some(entry => entry.action === "agent_credential_rotated"), "credential rotation invalidates old key and writes audit entry");
  response = await postTransfer({ token: oldDemoToken, requestId: "test-old-demo-token-001" });
  assert(response.status === 401, "rotated credential is no longer accepted");
  response = await postTransfer({ token: payload.token, requestId: "test-new-demo-token-001" });
  const replacementBody = await response.text();
  assert(response.status === 202 && replacementBody.length > 0, `replacement credential reaches transfer lifecycle (HTTP ${response.status}; body: ${replacementBody || "<empty>"})`);

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

  const primaryId = "test-api-primary-001";
  const providerCountBeforePrimary = counters.provider;
  const recordCountBeforePrimary = counters.record;
  response = await postTransfer({ token: "agent-one-token", requestId: primaryId });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "awaiting_approval", "agent transfer creates a pending approval request");
  assert(counters.provider === providerCountBeforePrimary, "agent request cannot contact provider before admin approval");
  response = await approveTransfer(primaryId);
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "admin approval submits transfer and holds it for chain confirmation");
  assert(counters.provider === providerCountBeforePrimary + 1 && counters.record === recordCountBeforePrimary + 1, "approved request invokes provider once and atomically records provider references");
  assert(reservations.get(primaryId)?.providerRequestId === `mock-provider-${providerCountBeforePrimary + 1}`, "provider request ID is persisted atomically");
  assert(reservations.get(primaryId)?.txHash === `mock-tx-${providerCountBeforePrimary + 1}`, "transaction hash is persisted atomically");

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

  const conflictRow = { ...recoveryRow, providerRequestId: "mock-provider-conflict", txHash: "known-hash" };
  reservations.set("provider-conflict-001", conflictRow);
  response = await fetch(`http://127.0.0.1:${appPort}/api/agent/provider-status`, {
    method: "POST", headers: { authorization: "Bearer agent-one-token", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "provider-conflict-001" })
  });
  payload = await response.json();
  assert(response.status === 202 && payload.reason === "provider_transaction_hash_conflict", "conflicting provider hash is not overwritten");


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
