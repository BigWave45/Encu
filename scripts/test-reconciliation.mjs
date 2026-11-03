import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const mockPort = 54322;
const appPort = 3001;
const signerId = "agentguard.testnet";
const tokens = {
  "agent-one-token": { id: "primary", active: true },
  "agent-two-token": { id: "research-agent", active: true }
};
const hash = value => createHash("sha256").update(value).digest("hex");
const agentsByHash = new Map(Object.entries(tokens).map(([token, agent]) => [hash(token), agent]));
const reservations = new Map();
const rpcResponses = new Map();
const counters = { rpc: 0, finish: 0 };
let failFinalization = false;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function reservation(id, overrides = {}) {
  return {
    request_id: id,
    status: "needs_review",
    outlayer_tx_hash: `hash-${id}`,
    outlayer_request_id: `provider-${id}`,
    recipient: "recipient.near",
    amount_yocto: "1000000000000000000000000",
    agent_id: "primary",
    ...overrides
  };
}
function matchingResult(row, status = { SuccessValue: "" }) {
  return {
    result: {
      final_execution_status: "FINAL",
      status,
      transaction: {
        signer_id: signerId,
        receiver_id: row.recipient,
        actions: [{ Transfer: { deposit: String(row.amount_yocto) } }]
      }
    }
  };
}

const mock = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${mockPort}`);
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/consume_agentguard_rate_limit") {
      const body = await readJson(req);
      // This suite exercises reconciliation behavior, not rate-limit thresholds.
      // Keep the test fixture permissive so repeated lifecycle cases do not
      // consume the production endpoint's ten-request window.
      return send(res, 200, { allowed: true, retry_after_seconds: body.p_window_seconds });
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/agents") {
      const tokenHash = url.searchParams.get("token_hash")?.replace(/^eq\./, "");
      const agent = agentsByHash.get(tokenHash);
      return send(res, 200, agent ? [{ id: agent.id, active: agent.active }] : []);
    }
    if (req.method === "GET" && url.pathname === "/rest/v1/spend_reservations") {
      const id = url.searchParams.get("request_id")?.replace(/^eq\./, "");
      const row = reservations.get(id);
      return send(res, 200, row ? [row] : []);
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/finish_agent_spend") {
      counters.finish++;
      const body = await readJson(req);
      if (failFinalization) return send(res, 500, { message: "simulated_ledger_failure" });
      const row = reservations.get(body.p_request_id);
      if (!row) return send(res, 400, { message: "reservation_not_found" });
      row.status = body.p_outcome;
      row.outlayer_tx_hash = body.p_tx_hash ?? row.outlayer_tx_hash;
      row.last_error = body.p_error ?? null;
      return send(res, 200, { status: row.status, request_id: row.request_id });
    }
    if (req.method === "POST" && url.pathname === "/") {
      counters.rpc++;
      const body = await readJson(req);
      const txHash = body.params?.tx_hash;
      const response = rpcResponses.get(txHash);
      if (response === "throw") return send(res, 503, { error: { message: "rpc_down" } });
      if (response === "missing") return send(res, 200, { error: { message: "transaction_not_found" } });
      return send(res, 200, response ?? { error: { message: "no_fixture" } });
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
  NEAR_RPC_URL: `http://127.0.0.1:${mockPort}/`,
  OUTLAYER_BASE_URL: `http://127.0.0.1:${mockPort}`,
  OUTLAYER_API_KEY: "test-outlayer-key",
  OUTLAYER_NEAR_ADDRESS: signerId,
  AGENTGUARD_NETWORK: "testnet",
  AGENTGUARD_ADMIN_TOKEN: "test-admin-token",
  CI: "true",
  AGENTGUARD_TEST_MODE: "true",
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
      const response = await fetch(`http://127.0.0.1:${appPort}/api/agent/reconcile`, { method: "GET" });
      if (response.status) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Next.js server did not become ready");
}
async function postReconcile(token, requestId) {
  return fetch(`http://127.0.0.1:${appPort}/api/agent/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId })
  });
}

try {
  const fixtures = [
    ["success-001", reservation("success-001")],
    ["failure-001", reservation("failure-001")],
    ["mismatch-recipient-001", reservation("mismatch-recipient-001")],
    ["mismatch-amount-001", reservation("mismatch-amount-001")],
    ["mismatch-signer-001", reservation("mismatch-signer-001")],
    ["multiple-actions-001", reservation("multiple-actions-001")],
    ["receipt-only-001", reservation("receipt-only-001")],
    ["non-final-001", reservation("non-final-001")],
    ["rpc-error-001", reservation("rpc-error-001")],
    ["rpc-missing-001", reservation("rpc-missing-001")],
    ["no-hash-001", reservation("no-hash-001", { outlayer_tx_hash: null })],
    ["wrong-agent-001", reservation("wrong-agent-001", { agent_id: "research-agent" })],
    ["finalize-error-001", reservation("finalize-error-001")]
  ];
  for (const [id, row] of fixtures) reservations.set(id, row);

  const success = reservations.get("success-001");
  rpcResponses.set(success.outlayer_tx_hash, matchingResult(success));
  const failure = reservations.get("failure-001");
  rpcResponses.set(failure.outlayer_tx_hash, matchingResult(failure, { Failure: { error_message: "transfer failed" } }));

  const mismatchRecipient = reservations.get("mismatch-recipient-001");
  rpcResponses.set(mismatchRecipient.outlayer_tx_hash, matchingResult({ ...mismatchRecipient, recipient: "attacker.near" }));
  const mismatchAmount = reservations.get("mismatch-amount-001");
  rpcResponses.set(mismatchAmount.outlayer_tx_hash, matchingResult({ ...mismatchAmount, amount_yocto: "2000000000000000000000000" }));
  const mismatchSigner = reservations.get("mismatch-signer-001");
  const wrongSigner = matchingResult(mismatchSigner);
  wrongSigner.result.transaction.signer_id = "attacker.near";
  rpcResponses.set(mismatchSigner.outlayer_tx_hash, wrongSigner);
  const multipleActions = reservations.get("multiple-actions-001");
  const multipleActionResult = matchingResult(multipleActions);
  multipleActionResult.result.transaction.actions = [
    { Transfer: { deposit: String(multipleActions.amount_yocto) } },
    { Transfer: { deposit: "1" } }
  ];
  rpcResponses.set(multipleActions.outlayer_tx_hash, multipleActionResult);
  const receiptOnly = reservations.get("receipt-only-001");
  rpcResponses.set(receiptOnly.outlayer_tx_hash, matchingResult(receiptOnly, { SuccessReceiptId: "pending-receipt" }));
  const nonFinal = reservations.get("non-final-001");
  const nonFinalResult = matchingResult(nonFinal);
  nonFinalResult.result.final_execution_status = "EXECUTED";
  rpcResponses.set(nonFinal.outlayer_tx_hash, nonFinalResult);
  rpcResponses.set(reservations.get("rpc-error-001").outlayer_tx_hash, "throw");
  rpcResponses.set(reservations.get("rpc-missing-001").outlayer_tx_hash, "missing");
  rpcResponses.set(reservations.get("finalize-error-001").outlayer_tx_hash, matchingResult(reservations.get("finalize-error-001")));
  rpcResponses.set(reservations.get("wrong-agent-001").outlayer_tx_hash, matchingResult(reservations.get("wrong-agent-001")));

  await new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(mockPort, "127.0.0.1", resolve);
  });
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForApp();

  let response = await fetch(`http://127.0.0.1:${appPort}/api/agent/reconcile`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "success-001" })
  });
  assert(response.status === 401, "unauthenticated reconciliation is rejected");

  response = await postReconcile("agent-two-token", "success-001");
  assert(response.status === 404, "agent cannot inspect another agent's reservation");

  response = await postReconcile("agent-one-token", "missing-001");
  assert(response.status === 404, "unknown reservation is not found");

  response = await postReconcile("agent-one-token", "no-hash-001");
  let payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "reservation without transaction hash stays pending");
  assert(counters.rpc === 0, "NEAR RPC is not called when no transaction hash exists");

  response = await postReconcile("agent-one-token", "rpc-error-001");
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "RPC transport failure cannot settle or release funds");
  assert(reservations.get("rpc-error-001").status === "needs_review", "RPC transport failure leaves ledger reservation unchanged");

  response = await postReconcile("agent-one-token", "rpc-missing-001");
  payload = await response.json();
  assert(response.status === 202 && payload.status === "needs_review", "transaction not found cannot settle or release funds");

  for (const id of ["mismatch-recipient-001", "mismatch-amount-001", "mismatch-signer-001", "multiple-actions-001", "receipt-only-001", "non-final-001"]) {
    response = await postReconcile("agent-one-token", id);
    payload = await response.json();
    assert(response.status === 202 && payload.status === "needs_review", `${id}: non-matching or non-final transaction remains pending`);
    assert(reservations.get(id).status === "needs_review", `${id}: no ledger settlement occurs`);
  }
  assert(counters.finish === 0, "no invalid, missing, or non-final RPC result calls ledger finalisation");

  response = await postReconcile("agent-one-token", "success-001");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "executed" && payload.finality === "FINAL", "matching FINAL success settles reservation as executed");
  assert(reservations.get("success-001").status === "executed", "successful finality is persisted in reservation ledger");
  const successRpcCalls = counters.rpc;
  const successFinishCalls = counters.finish;
  response = await postReconcile("agent-one-token", "success-001");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "executed", "repeated reconciliation returns the existing executed state");
  assert(counters.rpc === successRpcCalls && counters.finish === successFinishCalls, "repeated executed reconciliation does not query NEAR or settle twice");

  response = await postReconcile("agent-one-token", "failure-001");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "failed", "matching FINAL failure settles reservation as failed");
  assert(reservations.get("failure-001").status === "failed", "failed final execution is persisted in reservation ledger");
  const failureRpcCalls = counters.rpc;
  const failureFinishCalls = counters.finish;
  response = await postReconcile("agent-one-token", "failure-001");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "failed", "repeated reconciliation returns the existing failed state");
  assert(counters.rpc === failureRpcCalls && counters.finish === failureFinishCalls, "repeated failed reconciliation does not query NEAR or settle twice");

  failFinalization = true;
  response = await postReconcile("agent-one-token", "finalize-error-001");
  payload = await response.json();
  assert(response.status === 500 && payload.status === "needs_review", "ledger write failure is reported without claiming settlement");
  assert(reservations.get("finalize-error-001").status === "needs_review", "failed ledger finalisation leaves reservation pending");

  failFinalization = false;
  response = await postReconcile("test-admin-token", "wrong-agent-001");
  payload = await response.json();
  assert(response.status === 200 && payload.status === "executed", "administrator can reconcile another agent's reservation");

  process.stdout.write("\nReconciliation integration tests passed. Mock NEAR RPC and mock Supabase only; no credentials or real transfer used.\n");
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  if (app && !app.killed) app.kill("SIGTERM");
  await new Promise(resolve => mock.close(resolve));
}
if (failed) process.exitCode = 1;
