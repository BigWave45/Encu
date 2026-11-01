import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ limitYocto: z.string().regex(/^[1-9][0-9]{0,39}$/) });

export async function PATCH(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try { identity = authenticateAdmin(request.headers.get("authorization")); }
  catch { return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 }); }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { data, error } = await getSupabase().rpc("update_agent_budget_limit", {
    p_new_limit_yocto: parsed.data.limitYocto,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("budget_below_committed_amounts")) {
      return NextResponse.json({ error: "budget_below_spent_plus_reserved" }, { status: 409 });
    }
    if (message.includes("budget_not_configured")) {
      return NextResponse.json({ error: "budget_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "budget_update_failed" }, { status: 500 });
  }
  return NextResponse.json({ status: "updated", budget: data }, {
    headers: { "Cache-Control": "no-store, private" }
  });
}
