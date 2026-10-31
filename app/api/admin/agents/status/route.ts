import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/),
  active: z.boolean()
}).refine(value => value.id !== "primary", {
  message: "The primary admin identity cannot be deactivated."
});

export async function PATCH(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try { identity = await authenticateAgent(request.headers.get("authorization")); }
  catch { return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 }); }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request_or_primary_agent" }, { status: 400 });

  const { data, error } = await getSupabase().rpc("set_agent_active", {
    p_agent_id: parsed.data.id,
    p_active: parsed.data.active,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    if ((error.message ?? "").includes("agent_not_found")) {
      return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "agent_status_update_failed" }, { status: 500 });
  }
  return NextResponse.json({ status: "updated", agent: data });
}
