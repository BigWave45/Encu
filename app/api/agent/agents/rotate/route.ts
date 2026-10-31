import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateAgent } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/)
}).refine((value) => value.id !== "primary", {
  message: "The primary admin identity cannot be rotated through this endpoint."
});

export async function POST(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await getSupabase()
    .from("agents")
    .update({ token_hash: tokenHash })
    .eq("id", parsed.data.id)
    .eq("active", true)
    .select("id,name")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "agent_rotation_failed" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "active_agent_not_found" }, { status: 404 });
  const audit = await getSupabase().from("agentguard_admin_audit").insert({
    actor_agent_id: identity.agentId,
    action: "agent_credential_rotated",
    target_id: data.id,
    details: { name: data.name }
  });
  const auditWarning = audit.error ? "credential_rotated_but_audit_write_failed" : undefined;

  return NextResponse.json({
    status: "rotated",
    agent: { id: data.id, name: data.name },
    token,
    warning: "The previous credential is invalid. Copy this replacement now; it cannot be retrieved again.",
    ...(auditWarning ? { auditWarning } : {})
  }, { status: 200 });
}
