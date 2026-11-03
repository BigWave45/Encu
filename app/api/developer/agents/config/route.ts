import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDeveloper } from "@/lib/developer-auth";
import { requireOwnedAgent } from "@/lib/developer-agent-access";
import { getSupabase } from "@/lib/supabase";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/);
const amount = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const positiveAmount = z.string().regex(/^[1-9][0-9]*$/).max(78);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("policy"), id, maxTransferYocto: positiveAmount.nullable(), dailyLimitYocto: positiveAmount.nullable(), weeklyLimitYocto: positiveAmount.nullable() }),
  z.object({ action: z.literal("allocation"), id, allocationLimitYocto: amount }),
  z.object({ action: z.literal("auto_spend"), id, autoSpendLimitYocto: amount.nullable() }),
  z.object({ action: z.literal("authorize_recipient"), id, accountId: z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/), label: z.string().max(80).optional(), expiresAt: z.string().datetime().nullable().optional() }),
  z.object({ action: z.literal("revoke_recipient"), id, accountId: z.string().min(2).max(64), reason: z.string().trim().min(3).max(500) })
]);

async function identity(request: NextRequest) {
  try { return await authenticateDeveloper(request.headers.get("authorization")); }
  catch { return null; }
}

export async function GET(request: NextRequest) {
  const user = await identity(request);
  if (!user) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });
  const agentId = request.nextUrl.searchParams.get("id") ?? "";
  if (!id.safeParse(agentId).success) return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  const owned = await requireOwnedAgent(user.userId, agentId);
  if (owned.response) return owned.response;
  const db = getSupabase();
  const [allocation, policy, recipients] = await Promise.all([
    db.from("agent_allocations").select("agent_id,allocation_limit_yocto,spent_yocto,reserved_yocto").eq("agent_id", agentId).maybeSingle(),
    db.from("agent_policies").select("agent_id,max_transfer_yocto,daily_limit_yocto,weekly_limit_yocto,auto_spend_limit_yocto").eq("agent_id", agentId).maybeSingle(),
    db.from("agent_authorized_recipients").select("account_id,label,status,authorized_at,expires_at,revoked_at").eq("agent_id", agentId).order("created_at", { ascending: false })
  ]);
  if (allocation.error || policy.error || recipients.error) return NextResponse.json({ error: "agent_configuration_read_failed" }, { status: 503 });
  return NextResponse.json({ allocation: allocation.data, policy: policy.data, recipients: recipients.data ?? [] }, { headers: { "Cache-Control": "no-store, private" } });
}

export async function PATCH(request: NextRequest) {
  const user = await identity(request);
  if (!user) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const owned = await requireOwnedAgent(user.userId, input.id);
  if (owned.response) return owned.response;

  const rate = await consumeRateLimit(`developer:${user.userId}`, `agent_config_${input.action}`, 20, 60);
  if (!rate) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "rate_limit_exceeded", retryAfterSeconds: rate.retryAfterSeconds }, { status: 429 });
  const db = getSupabase();
  const actor = `developer:${user.userId}`;
  let result: { data: unknown; error: { message: string } | null };
  if (input.action === "policy") {
    result = await db.rpc("developer_set_agent_policy", { p_owner_user_id: user.userId, p_agent_id: input.id, p_max_transfer_yocto: input.maxTransferYocto, p_daily_limit_yocto: input.dailyLimitYocto, p_weekly_limit_yocto: input.weeklyLimitYocto });
  } else if (input.action === "allocation") {
    result = await db.rpc("developer_set_agent_allocation", { p_owner_user_id: user.userId, p_agent_id: input.id, p_allocation_limit_yocto: input.allocationLimitYocto });
  } else if (input.action === "auto_spend") {
    result = await db.rpc("developer_set_agent_auto_spend_limit", { p_owner_user_id: user.userId, p_agent_id: input.id, p_auto_spend_limit_yocto: input.autoSpendLimitYocto });
  } else if (input.action === "authorize_recipient") {
    result = await db.rpc("developer_authorize_agent_recipient", { p_owner_user_id: user.userId, p_agent_id: input.id, p_account_id: input.accountId, p_label: input.label ?? null, p_expires_at: input.expiresAt ?? null, p_actor_agent_id: actor });
  } else {
    result = await db.rpc("developer_revoke_agent_recipient", { p_owner_user_id: user.userId, p_agent_id: input.id, p_account_id: input.accountId, p_reason: input.reason, p_actor_agent_id: actor });
  }
  if (result.error) return NextResponse.json({ error: "agent_configuration_update_failed", reason: result.error.message }, { status: 400 });
  return NextResponse.json({ status: "updated", result: result.data }, { headers: { "Cache-Control": "no-store, private" } });
}
