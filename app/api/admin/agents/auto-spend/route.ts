import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/),
  autoSpendLimitYocto: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).nullable()
});

export async function PATCH(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });

  const limited = await adminRateLimitResponse(identity.agentId, "agent_auto_spend_update", 10, 60);
  if (limited) return limited;

  const { data, error } = await getSupabase().rpc("set_agent_auto_spend_limit", {
    p_agent_id: parsed.data.id,
    p_auto_spend_limit_yocto: parsed.data.autoSpendLimitYocto,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    const status = error.message.includes("agent_allocation_not_configured") || error.message.includes("agent_policy_not_configured") ? 409 : 400;
    return NextResponse.json({ error: "agent_auto_spend_update_failed", reason: error.message }, { status });
  }
  return NextResponse.json({ status: "updated", policy: data });
}
