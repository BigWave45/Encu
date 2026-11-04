import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/).refine(id => id !== "admin", { message: "Reserved administrator identity." }),
  name: z.string().trim().min(2).max(80)
});

export async function POST(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const limited = await adminRateLimitResponse(identity.agentId, "agent_provisioning", 10, 60);
  if (limited) return limited;

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await getSupabase().rpc("create_agent_with_audit", {
    p_agent_id: parsed.data.id,
    p_name: parsed.data.name,
    p_token_hash: tokenHash,
    p_actor_agent_id: identity.agentId
  });

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "agent_id_or_token_conflict" }, { status: 409 });
    return NextResponse.json({ error: "agent_creation_failed" }, { status: 500 });
  }

  return NextResponse.json({
    status: "created",
    agent: { id: data.id, name: data.name },
    token,
    warning: "Copy this token now. It cannot be retrieved again."
  }, { status: 201 });
}
