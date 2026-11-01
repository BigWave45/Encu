import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/);
const policySchema = z.object({
  id: idSchema,
  maxTransferYocto: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  dailyLimitYocto: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  weeklyLimitYocto: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  // null = unrestricted; [] = deny every recipient.
  allowedRecipients: z.array(z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/)).max(500).nullable()
});

function admin(request: NextRequest) {
  try {
    const identity = authenticateAdmin(request.headers.get("authorization"));
    return identity?.isAdmin ? identity : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const identity = admin(request);
  if (!identity) return NextResponse.json({ error: "admin_required" }, { status: 403 });
  const id = request.nextUrl.searchParams.get("id");
  if (id && !idSchema.safeParse(id).success) return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });

  let query = getSupabase().from("agent_policies")
    .select("agent_id,max_transfer_yocto::text,daily_limit_yocto::text,weekly_limit_yocto::text,allowed_recipients,updated_at,updated_by")
    .order("agent_id", { ascending: true });
  if (id) query = query.eq("agent_id", id);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "agent_policy_read_failed" }, { status: 503 });
  return NextResponse.json({ policies: (data ?? []).map((row) => ({
    agentId: row.agent_id,
    maxTransferYocto: row.max_transfer_yocto,
    dailyLimitYocto: row.daily_limit_yocto,
    weeklyLimitYocto: row.weekly_limit_yocto,
    allowedRecipients: row.allowed_recipients,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  })) }, { headers: { "Cache-Control": "no-store, private" } });
}

export async function PATCH(request: NextRequest) {
  const identity = admin(request);
  if (!identity) return NextResponse.json({ error: "admin_required" }, { status: 403 });
  const parsed = policySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });

  const policy = parsed.data;
  const { data, error } = await getSupabase().rpc("set_agent_policy", {
    p_agent_id: policy.id,
    p_max_transfer_yocto: policy.maxTransferYocto,
    p_daily_limit_yocto: policy.dailyLimitYocto,
    p_weekly_limit_yocto: policy.weeklyLimitYocto,
    p_allowed_recipients: policy.allowedRecipients,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    const status = error.message.includes("agent_not_found") ? 404 : 400;
    return NextResponse.json({ error: "agent_policy_update_failed", reason: error.message }, { status });
  }
  return NextResponse.json({ status: "updated", policy: data });
}
