import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/),
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

  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const db = getSupabase();

  const { error } = await db.from("agents").insert({
    id: parsed.data.id,
    name: parsed.data.name,
    token_hash: tokenHash,
    active: true
  });

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "agent_id_or_token_conflict" }, { status: 409 });
    return NextResponse.json({ error: "agent_creation_failed" }, { status: 500 });
  }

  const audit = await db.from("agentguard_admin_audit").insert({
    actor_agent_id: identity.agentId,
    action: "agent_credential_created",
    target_id: parsed.data.id,
    details: { name: parsed.data.name }
  });
  const auditWarning = audit.error ? "credential_created_but_audit_write_failed" : undefined;

  return NextResponse.json({
    status: "created",
    agent: { id: parsed.data.id, name: parsed.data.name },
    token,
    warning: "Copy this token now. It cannot be retrieved again.",
    ...(auditWarning ? { auditWarning } : {})
  }, { status: 201 });
}
