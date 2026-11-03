import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/),
  allocationLimitYocto: z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
});

export async function PATCH(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) {
    return NextResponse.json({ error: "admin_required" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const limited = await adminRateLimitResponse(identity.agentId, "agent_allocation_update", 10, 60);
  if (limited) return limited;

  const { data, error } = await getSupabase().rpc("set_agent_allocation", {
    p_agent_id: parsed.data.id,
    p_allocation_limit_yocto: parsed.data.allocationLimitYocto,
    p_actor_agent_id: identity.agentId
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("agent_allocation_not_configured")) {
      return NextResponse.json({ error: "agent_allocation_not_configured" }, { status: 404 });
    }
    if (message.includes("allocation_below_committed_amounts")) {
      return NextResponse.json({ error: "allocation_below_spent_plus_reserved" }, { status: 409 });
    }
    if (message.includes("allocations_exceed_treasury_limit")) {
      return NextResponse.json({ error: "allocations_exceed_treasury_limit" }, { status: 409 });
    }
    if (message.includes("budget_not_configured")) {
      return NextResponse.json({ error: "budget_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "agent_allocation_update_failed" }, { status: 500 });
  }

  return NextResponse.json({ status: "updated", allocation: data }, {
    headers: { "Cache-Control": "no-store, private" }
  });
}
