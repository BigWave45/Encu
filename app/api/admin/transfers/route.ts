import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ enabled: z.boolean() });

export async function GET(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const { data, error } = await getSupabase()
    .from("agentguard_system_controls")
    .select("transfers_enabled,updated_at,updated_by")
    .eq("id", "default")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: "system_controls_unavailable" }, { status: 503 });
  return NextResponse.json({
    transfersEnabled: data.transfers_enabled,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by
  }, { headers: { "Cache-Control": "no-store, private" } });
}

export async function PATCH(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { data, error } = await getSupabase().rpc("set_agentguard_transfers_enabled", {
    p_enabled: parsed.data.enabled,
    p_actor_agent_id: identity.agentId
  });
  if (error) return NextResponse.json({ error: "system_control_update_failed" }, { status: 500 });
  return NextResponse.json({ status: "updated", ...data });
}
