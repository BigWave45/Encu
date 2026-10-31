import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

if (process.env.AGENTGUARD_TEST_DATABASE !== "true") {
  throw new Error("Refusing to run. Set AGENTGUARD_TEST_DATABASE=true only for a dedicated disposable test project. Never use production.");
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || !url.includes(".supabase.co")) {
  throw new Error("Provide the test project's SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const yocto = 10n ** 24n;
const amount = (3n * yocto).toString();
const recipient = "agentguard-test.near";
const suffix = randomUUID();
const requests = [
  { requestId: `ag-concurrency-${suffix}-primary`, agentId: "primary" },
  { requestId: `ag-concurrency-${suffix}-research`, agentId: "research-agent" },
];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const unwrap = (data) => Array.isArray(data) ? data[0] : data;

async function getBudget() {
  const { data, error } = await db.from("agent_budgets")
    .select("id,total_limit_yocto,spent_yocto,reserved_yocto").eq("id", "default").single();
  if (error) throw error;
  return data;
}
async function cleanup(snapshot) {
  const { error: deleteError } = await db.from("spend_reservations")
    .delete().in("request_id", requests.map(x => x.requestId));
  if (deleteError) throw deleteError;
  const { error: restoreError } = await db.from("agent_budgets").update({
    total_limit_yocto: snapshot.total_limit_yocto,
    spent_yocto: snapshot.spent_yocto,
    reserved_yocto: snapshot.reserved_yocto,
  }).eq("id", "default");
  if (restoreError) throw restoreError;
}

let snapshot;
let started = false;
try {
  const [budget, existing, agents] = await Promise.all([
    getBudget(),
    db.from("spend_reservations").select("request_id").limit(1),
    db.from("agents").select("id,active").in("id", ["primary", "research-agent"]),
  ]);
  if (existing.error) throw existing.error;
  if (agents.error) throw agents.error;
  assert(budget.total_limit_yocto === (5n * yocto).toString(), "Test budget must be exactly 5 NEAR.");
  assert(BigInt(budget.spent_yocto) === 0n && BigInt(budget.reserved_yocto) === 0n, "Test budget must have zero spent and reserved.");
  assert(existing.data.length === 0, "Test database must have no existing reservations.");
  assert(agents.data.length === 2 && agents.data.every(x => x.active), "Both seeded agents must be active.");
  snapshot = budget;
  started = true;
  console.log("Preconditions passed: disposable database, empty 5 NEAR budget, two active agents.");

  // Promise.all issues independent PostgREST requests, exercising separate database transactions.
  const outcomes = await Promise.all(requests.map(async request => {
    const { data, error } = await db.rpc("reserve_agent_spend", {
      p_request_id: request.requestId,
      p_amount_yocto: amount,
      p_recipient: recipient,
      p_agent_id: request.agentId,
    });
    if (error) throw error;
    return { request, result: unwrap(data) };
  }));
  const winners = outcomes.filter(x => x.result?.created === true);
  const blocked = outcomes.filter(x => x.result?.status === "blocked");
  assert(winners.length === 1, `Expected one reservation winner; got ${winners.length}.`);
  assert(blocked.length === 1, `Expected one budget block; got ${blocked.length}.`);

  const after = await getBudget();
  assert(BigInt(after.spent_yocto) === 0n, "Race must not change spent amount.");
  assert(BigInt(after.reserved_yocto) === 3n * yocto, "Race must reserve exactly 3 NEAR.");
  assert(BigInt(after.spent_yocto) + BigInt(after.reserved_yocto) <= BigInt(after.total_limit_yocto), "Budget invariant failed.");

  const { data: rows, error: rowError } = await db.from("spend_reservations")
    .select("request_id,agent_id,amount_yocto,status")
    .in("request_id", requests.map(x => x.requestId));
  if (rowError) throw rowError;
  assert(rows.length === 1 && rows[0].request_id === winners[0].request.requestId, "Ledger row does not match the winning request.");

  const winner = winners[0].request;
  const { data: replayData, error: replayError } = await db.rpc("reserve_agent_spend", {
    p_request_id: winner.requestId, p_amount_yocto: amount,
    p_recipient: recipient, p_agent_id: winner.agentId,
  });
  if (replayError) throw replayError;
  assert(unwrap(replayData)?.created === false, "Identical replay must return created=false.");

  const { error: conflict } = await db.rpc("reserve_agent_spend", {
    p_request_id: winner.requestId, p_amount_yocto: (4n * yocto).toString(),
    p_recipient: recipient, p_agent_id: winner.agentId,
  });
  assert(conflict?.message?.includes("idempotency_key_conflict"), "Changed-payload replay was not rejected.");

  console.log("PASS: concurrent 3 NEAR requests yielded one reservation and one budget block.");
  console.log("PASS: persisted ledger and budget counters agree.");
  console.log("PASS: identical replay did not create another reservation.");
  console.log("PASS: changed-payload replay returned idempotency_key_conflict.");
} finally {
  if (started && snapshot) {
    await cleanup(snapshot);
    const restored = await getBudget();
    assert(
      restored.total_limit_yocto === snapshot.total_limit_yocto &&
      restored.spent_yocto === snapshot.spent_yocto &&
      restored.reserved_yocto === snapshot.reserved_yocto,
      "Cleanup failed to restore the original budget snapshot."
    );
    console.log("Cleanup verified: test rows removed and original budget restored.");
  }
}
