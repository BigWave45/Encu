import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateDeveloper } from "@/lib/developer-auth";
import { getSupabase } from "@/lib/supabase";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/).refine(id => !["admin", "primary"].includes(id)),
  name: z.string().trim().min(2).max(80)
});

async function developerRateLimit(userId: string, action: string, limit: number) {
  const result = await consumeRateLimit(`developer:${userId}`, action, limit, 60);
  if (!result) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!result.allowed) return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
  return null;
}

export async function GET(request: NextRequest) {
  let identity;
  try { identity = await authenticateDeveloper(request.headers.get("authorization")); }
  catch { return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 }); }
  if (!identity) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });

  const db = getSupabase();
  const { data: agents, error } = await db.from("agents")
    .select("id,name,active,created_at")
    .eq("owner_user_id", identity.userId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "developer_agents_read_failed" }, { status: 503 });
  const ids = (agents ?? []).map(agent => agent.id);
  if (!ids.length) return NextResponse.json({ agents: [] }, { headers: { "Cache-Control": "no-store, private" } });

  const [allocations, policies, recipients] = await Promise.all([
    db.from("agent_allocations").select("agent_id,allocation_limit_yocto,spent_yocto,reserved_yocto").in("agent_id", ids),
    db.from("agent_policies").select("agent_id,max_transfer_yocto,daily_limit_yocto,weekly_limit_yocto,auto_spend_limit_yocto").in("agent_id", ids),
    db.from("agent_authorized_recipients").select("agent_id,status,expires_at").in("agent_id", ids)
  ]);
  if (allocations.error || policies.error || recipients.error) return NextResponse.json({ error: "developer_agent_details_read_failed" }, { status: 503 });

  const allocationById = new Map((allocations.data ?? []).map(row => [row.agent_id, row]));
  const policyById = new Map((policies.data ?? []).map(row => [row.agent_id, row]));
  const now = Date.now();
  const recipientCountById = new Map<string, number>();
  for (const recipient of recipients.data ?? []) {
    const unexpired = recipient.expires_at == null || Date.parse(recipient.expires_at) > now;
    if (recipient.status === "active" && unexpired) {
      recipientCountById.set(recipient.agent_id, (recipientCountById.get(recipient.agent_id) ?? 0) + 1);
    }
  }
  return NextResponse.json({
    agents: (agents ?? []).map(agent => ({
      id: agent.id,
      name: agent.name,
      active: agent.active,
      createdAt: agent.created_at,
      allocation: allocationById.get(agent.id) ?? null,
      policy: policyById.get(agent.id) ?? null,
      activeRecipientCount: recipientCountById.get(agent.id) ?? 0
    }))
  }, { headers: { "Cache-Control": "no-store, private" } });
}

export async function POST(request: NextRequest) {
  let identity;
  try { identity = await authenticateDeveloper(request.headers.get("authorization")); }
  catch { return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 }); }
  if (!identity) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });

  const limited = await developerRateLimit(identity.userId, "agent_create", 5);
  if (limited) return limited;

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await getSupabase().rpc("create_developer_agent", {
    p_owner_user_id: identity.userId,
    p_agent_id: parsed.data.id,
    p_name: parsed.data.name,
    p_token_hash: tokenHash
  });

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "agent_id_conflict" }, { status: 409 });
    if ((error.message ?? "").includes("invalid_developer_agent")) return NextResponse.json({ error: "invalid_agent_details" }, { status: 400 });
    return NextResponse.json({ error: "agent_creation_failed" }, { status: 500 });
  }

  return NextResponse.json({
    status: "created",
    agent: { id: data.id, name: data.name, active: data.active, createdAt: data.created_at },
    token,
    warning: "Copy this agent token now. It cannot be retrieved again. The agent starts with zero allocation. Configure its allocation and spending policy in your developer workspace before requesting transfers."
  }, { status: 201, headers: { "Cache-Control": "no-store, private" } });
}
