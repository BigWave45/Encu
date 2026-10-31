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
let mockSignerAddress = "agentguard.testnet";
const counters = { reserve: 0, finish: 0, record: 0, provider: 0, providerStatus: 0 };
const budget = 5n * 10n ** 24n;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const agentsByHash = new Map(Object.entries(tokens).map(([token, agent]) => [hash(token), agent]));

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
    if (req.method === "GET" && url.pathname === "/rest/v1/agent_budgets") return send(res, 200, [{ id: "default" }]);
    if (req.method === "GET" && url.pathname === "/wallet/v1/address") return send(res, 200, { address: mockSignerAddress, executor_account_id: mockSignerAddress, asset_account_id: null });
    if (req.method === "GET" && url.pathname === "/rest/v1/agents") {
      const tokenHash = url.searchParams.get("token_hash")?.replace(/^eq\./, "");
      const agent = agentsByHash.get(tokenHash);
      return send(res, 200, agent ? [{ id: agent.id, active: agent.active }] : []);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/reserve_agent_spend") {
      counters.reserve++;
      const body = await readJson(req);
      const id = body.p_request_id;
      const existing = reservations.get(id);
      if (existing) {
        if (existing.amount !== String(body.p_amount_yocto) ||
            existing.recipient !== body.p_recipient ||
            existing.agentId !== body.p_agent_id) {
          return send(res, 400, { message: "idempotency_key_conflict" });
        }
        return send(res, 200, { created: false, status: existing.status, request_id: id, agent_id: existing.agentId });
      }
      const amount = BigInt(body.p_amount_yocto);
      const reserved = [...reservations.values()].reduce((sum, item) => sum + (item.status === "reserved" || item.status === "needs_review" ? BigInt(item.amount) : 0n), 0n);
      if (reserved + amount > budget) return send(res, 200, { created: false, status: "blocked", reason: "total_budget_exceeded" });
      const row = { amount: String(body.p_amount_yocto), recipient: body.p_recipient, agentId: body.p_agent_id, status: "reserved" };
      reservations.set(id, row);
      return send(res, 200, { created: true, status: "reserved", request_id: id, agent_id: row.agentId });
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/spend_reservations") {
      const id = url.searchParams.get("request_id")?.replace("eq.", "");
      const row = reservations.get(id);
      return send(res, 200, row ? [{
        request_id: id, status: row.status, outlayer_request_id: row.providerRequestId ?? null,
        outlayer_tx_hash: row.txHash ?? null, agent_id: row.agentId
      }] : []);
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
  CI: "true",
  AGENTGUARD_TEST_MODE: "true",
  AGENTGUARD_MAX_TRANSFER_YOCTO: "5000000000000000000000000",
  AGENTGUARD_AGENT_TOKEN: "",
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
  let response = await postTransfer({ requestId: "test-unauth-001" });
  assert(response.status === 401, "missing bearer token is rejected with 401");
  assert(counters.reserve === 0 && counters.provider === 0, "unauthenticated request never reaches reservation or provider");

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

  response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  payload = await response.json();
  assert(response.status === 200 && payload.status === "ok" && payload.signerMatches === true, "health confirms provider wallet matches configured signer");
  mockSignerAddress = "unexpected.testnet";
  response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  payload = await response.json();
  assert(response.status === 503 && payload.outlayer === "signer_mismatch", "health fails closed when provider wallet signer differs");
  mockSignerAddress = "agentguard.testnet";

  const primaryId = "test-api-primary-001";
  response = await postTransfer({ token: "agent-one-token", requestId: primaryId });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "provider transaction hash is held for independent chain confirmation");
  assert(counters.provider === 1 && counters.record === 1, "first valid request invokes provider once and atomically records provider references");
  assert(reservations.get(primaryId)?.providerRequestId === "mock-provider-1", "provider request ID is persisted atomically");
  assert(reservations.get(primaryId)?.txHash === "mock-tx-1", "transaction hash is persisted atomically");

  response = await postTransfer({ token: "agent-one-token", requestId: primaryId });
  assert(response.status === 409, "identical request replay is rejected by API");
  assert(counters.provider === 1, "identical replay does not invoke provider again");

  response = await postTransfer({ token: "agent-one-token", requestId: primaryId, amount: "4000000000000000000000000" });
  assert(response.status === 409, "same request ID with changed amount is rejected");

  response = await postTransfer({ token: "agent-two-token", requestId: primaryId });
  assert(response.status === 409, "second agent cannot reuse another agent's request ID");

  const providerBeforeTimeout = counters.provider;
  response = await postTransfer({ token: "agent-one-token", requestId: "test-timeout-001", to: "timeout.test", amount: "3000000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "ambiguous provider connection failure remains needs_review");
  assert(payload.reason === "outlayer_timeout_or_connection_error", "ambiguous provider failure is classified explicitly");
  assert(counters.provider === providerBeforeTimeout + 1, "timeout path invokes provider only once");
  assert(reservations.get("test-timeout-001")?.status === "needs_review", "timeout reservation remains held in the ledger");

  response = await postTransfer({ token: "agent-one-token", requestId: "test-provider-error-001", to: "provider-error.test", amount: "1000000000000000000000000" });
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "provider 5xx response is not treated as proof of transfer failure");
  assert(reservations.get("test-provider-error-001")?.status === "needs_review", "provider 5xx reservation remains held");


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
